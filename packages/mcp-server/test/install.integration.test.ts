import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

/**
 * Drives scripts/install.sh against a throwaway $HOME with the download path
 * short-circuited via CHROMANCHE_INSTALL_OFFLINE. We seed a fake "release"
 * directory containing only what the installer needs to find (the MCP entry
 * file); the rest of the script — Claude/Codex/OpenCode/Copilot registration —
 * runs unchanged.
 *
 * Why this matters: the OpenCode registration path was previously writing to
 * ~/.opencode/config.json, a location OpenCode never reads. This test pins it
 * to the canonical XDG path so the bug cannot recur.
 */
const SCRIPT = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const HOST_OS = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim();

let home: string;
let bin: string;
let offline: string;
let commandLog: string;
let winRoot: string;
let scratch: string;

const opencodeCfg = () => join(home, ".config", "opencode", "opencode.json");
const opencodeLegacyCfg = () => join(home, ".opencode", "config.json");
const copilotCfg = () => join(home, ".copilot", "mcp-config.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const privateNode = () => join(home, ".chromanche", "node", "bin", "node");
// The no-node cases need PATH (bin/ + /usr/bin + /bin) to have no real node.
const SYSTEM_NODE_IN_BASE_PATH = existsSync("/usr/bin/node") || existsSync("/bin/node");

const writeFakeCommand = (name: string) =>
  writeScript(name, [`printf '%s %s\\n' "${name}" "$*" >> "${commandLog}"`, "exit 0"]);

/** Never write through bin/ symlinks: bin/node and bin/jq point at the host's real binaries. */
const writeScript = (name: string, lines: string[]) => {
  const path = join(bin, name);
  rmSync(path, { force: true });
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

/** `uname -s` → sys, `uname -r` → release, `uname -m` → machine. */
const writeFakeUname = (sys: string, release: string, machine = "x86_64") =>
  writeScript("uname", [
    'case "$1" in',
    `  -r) printf '%s\\n' '${release}' ;;`,
    `  -m) printf '%s\\n' '${machine}' ;;`,
    `  *) printf '%s\\n' '${sys}' ;;`,
    "esac",
  ]);

/** A system node that is too old for Chromanche (shadows the real one). */
const writeOldSystemNode = () =>
  writeScript("node", ['case "$1" in', "  -v|--version) echo v18.20.4 ;;", "  -e) echo 18 ;;", "esac"]);

/** No node on PATH at all (only meaningful when SYSTEM_NODE_IN_BASE_PATH is false). */
const removeSystemNode = () => rmSync(join(bin, "node"), { force: true });

/**
 * A directory laid out like https://nodejs.org/dist/latest-v22.x/, served to
 * the installer over file:// via CHROMANCHE_NODE_DIST_URL. Its "node" is a
 * script answering the installer's probes (-v and the -e major check).
 */
const makeNodeDist = (opts: {
  version?: string;
  os?: string;
  arch?: string;
  nodeBody?: string[];
  badChecksum?: boolean;
} = {}) => {
  const version = opts.version ?? "22.99.0";
  const base = `node-v${version}-${opts.os ?? "linux"}-${opts.arch ?? "x64"}`;
  const dist = mkdtempSync(join(scratch, "node-dist-"));
  const stage = mkdtempSync(join(scratch, "node-stage-"));
  mkdirSync(join(stage, base, "bin"), { recursive: true });
  const nodeBody = opts.nodeBody ?? [
    'case "$1" in',
    `  -v|--version) echo v${version} ;;`,
    `  -e) echo ${version.split(".")[0]} ;;`,
    "esac",
  ];
  writeFileSync(join(stage, base, "bin", "node"), ["#!/usr/bin/env bash", ...nodeBody, ""].join("\n"));
  chmodSync(join(stage, base, "bin", "node"), 0o755);
  const tarball = `${base}.tar.gz`;
  execFileSync("tar", ["-czf", join(dist, tarball), "-C", stage, base], {
    env: { ...process.env, COPYFILE_DISABLE: "1" }, // no macOS AppleDouble files
  });
  const sha = createHash("sha256").update(readFileSync(join(dist, tarball))).digest("hex");
  const decoyPlatform = base.endsWith("-darwin-arm64") ? "linux-x64" : "darwin-arm64";
  writeFileSync(join(dist, "SHASUMS256.txt"), [
    // Decoys: other platforms and the .tar.xz flavour must not be picked.
    `${"a".repeat(64)}  node-v${version}-${decoyPlatform}.tar.gz`,
    `${"b".repeat(64)}  ${base}.tar.xz`,
    `${opts.badChecksum ? "0".repeat(64) : sha}  ${tarball}`,
    "",
  ].join("\n"));
  return { url: `file://${dist}`, dir: dist, tarball };
};

// --- Minimal zip writer, so tests control every byte (incl. hostile entries). ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
interface ZipEntry { name: string; data?: string; deflate?: boolean; badCrc?: boolean }
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
const buildZip = (entries: ZipEntry[]): Buffer => {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data ?? "", "utf8");
    const isDir = e.name.endsWith("/");
    const method = !isDir && e.deflate ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = isDir ? 0 : (crc32(raw) ^ (e.badCrc ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
};

/** Ship the offline "release" extension as a zip instead of a directory. */
const useOfflineExtensionZip = (entries: ZipEntry[]) => {
  rmSync(join(offline, "extension"), { recursive: true, force: true });
  writeFileSync(join(offline, "extension.zip"), buildZip(entries));
};

/** WSL interop's cmd.exe: logs the call, prints the profile with a CRLF like the real one. */
const writeFakeCmdExe = (profile: string) =>
  writeScript("cmd.exe", [
    `printf '%s %s\\n' "cmd.exe" "$*" >> "${commandLog}"`,
    `printf '%s\\r\\n' '${profile}'`,
  ]);

/** wslpath -u that only knows the exact (CR-free) Windows paths it is given. */
const writeFakeWslpath = (map: Record<string, string>) =>
  writeScript("wslpath", [
    `printf '%s %s\\n' "wslpath" "$*" >> "${commandLog}"`,
    ...Object.entries(map).map(
      ([win, unix]) => `if [ "$1" = "-u" ] && [ "$2" = '${win}' ]; then printf '%s\\n' '${unix}'; exit 0; fi`,
    ),
    "exit 1",
  ]);

const linkRealCommand = (name: string) => {
  // Resolve once via the host's PATH then symlink into bin/ so the installer
  // can find it without us inheriting the rest of process.env.PATH (which
  // could contain a real `opencode`/`claude` and break absence assertions).
  const resolved = execFileSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
  if (!resolved) throw new Error(`Required host tool not found: ${name}`);
  symlinkSync(resolved, join(bin, name));
};

const envFor = (extraEnv: Record<string, string>) => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  // Pin PATH to bin/ + system dirs only. Inheriting process.env.PATH
  // would expose any real `opencode`/`claude` installed on the dev
  // machine and defeat the "CLI absent" assertions.
  PATH: `${bin}:/usr/bin:/bin`,
  CHROMANCHE_INSTALL_OFFLINE: offline,
  // Never inherit WSL markers from a developer's WSL shell.
  WSL_DISTRO_NAME: "",
  WSL_INTEROP: "",
  // Never reach nodejs.org: an unexpected Node download fails loudly.
  CHROMANCHE_NODE_DIST_URL: `file://${join(scratch, "no-node-dist")}`,
  ...extraEnv,
});

const run = (extraEnv: Record<string, string> = {}) =>
  execFileSync("bash", [SCRIPT], { env: envFor(extraEnv), encoding: "utf8" });

/** Runs install.sh without throwing; for the failure cases. */
const runRaw = (extraEnv: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT], { env: envFor(extraEnv), encoding: "utf8" });

/** Like run(), but also captures stderr (where _warn writes). */
const runCapture = (extraEnv: Record<string, string> = {}) => {
  const r = runRaw(extraEnv);
  if (r.status !== 0) throw new Error(`install.sh exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-install-home-"));
  bin = mkdtempSync(join(tmpdir(), "chromanche-install-bin-"));
  offline = mkdtempSync(join(tmpdir(), "chromanche-install-offline-"));
  winRoot = mkdtempSync(join(tmpdir(), "chromanche-install-winroot-"));
  scratch = mkdtempSync(join(tmpdir(), "chromanche-install-scratch-"));
  commandLog = join(home, "commands.log");

  // The installer hard-requires these on PATH. Symlink the host's copies
  // into our pinned bin/ so we can drop the rest of process.env.PATH.
  for (const tool of ["node", "jq"]) linkRealCommand(tool);

  // Hermetic WSL detection: the host's real OS name with a non-WSL kernel,
  // so running these tests inside WSL never takes the WSL branch (and never
  // reaches a real Windows profile). WSL tests override this.
  writeFakeUname(HOST_OS, "0.0.0-generic");

  // Lay out a minimal offline "release": the installer only checks that
  // mcp-server/dist/index.cjs exists. Extension dir is optional but cheap.
  mkdirSync(join(offline, "mcp-server", "dist"), { recursive: true });
  writeFileSync(join(offline, "mcp-server", "dist", "index.cjs"), "// fake mcp entrypoint\n");
  mkdirSync(join(offline, "extension"), { recursive: true });
  writeFileSync(join(offline, "extension", "manifest.json"), "{}\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(offline, { recursive: true, force: true });
  rmSync(winRoot, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("install.sh OpenCode registration", () => {
  it("writes to the XDG path ~/.config/opencode/opencode.json — not the legacy ~/.opencode/config.json", () => {
    // Fake CLIs so the corresponding registration branches run; the OpenCode
    // branch is the one under test but we exercise the whole installer path.
    writeFakeCommand("opencode");
    writeFakeCommand("claude");
    writeFakeCommand("codex");

    run();

    const entry = join(home, ".chromanche", "mcp-server", "dist", "index.cjs");
    expect(existsSync(entry)).toBe(true);

    // XDG path: present and correctly populated.
    expect(existsSync(opencodeCfg())).toBe(true);
    const cfg = readJson(opencodeCfg());
    expect(cfg.mcp).toEqual({
      chromanche: {
        type: "local",
        command: ["node", entry],
        enabled: true,
      },
    });
    // $schema is set so users get IDE validation out of the box.
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");

    // Legacy path must not be created by a fresh install.
    expect(existsSync(opencodeLegacyCfg())).toBe(false);
  });

  it("preserves unrelated keys and other MCP servers in an existing XDG config", () => {
    writeFakeCommand("opencode");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeCfg(), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-opus-4-20250514",
      mcp: {
        other: { type: "local", command: ["node", "/x/y.cjs"], enabled: true },
      },
    }, null, 2));

    run();

    const cfg = readJson(opencodeCfg());
    expect(cfg.model).toBe("anthropic/claude-opus-4-20250514");
    expect(cfg.mcp.other).toEqual({
      type: "local",
      command: ["node", "/x/y.cjs"],
      enabled: true,
    });
    expect(cfg.mcp.chromanche.type).toBe("local");
    expect(cfg.mcp.chromanche.enabled).toBe(true);
  });

  it("scrubs a stale chromanche entry from the legacy ~/.opencode/config.json", () => {
    writeFakeCommand("opencode");
    // Simulate the buggy state earlier installers left users in.
    mkdirSync(join(home, ".opencode"), { recursive: true });
    writeFileSync(opencodeLegacyCfg(), JSON.stringify({
      mcp: {
        chromanche: { type: "local", command: ["node", "/stale/index.cjs"], enabled: true },
      },
    }, null, 2));

    run();

    // Legacy file still exists (we do not delete the file itself, only the
    // entry) but no longer claims a chromanche server.
    expect(existsSync(opencodeLegacyCfg())).toBe(true);
    expect(readJson(opencodeLegacyCfg())).not.toHaveProperty("mcp");
    // New entry written at the real path.
    expect(readJson(opencodeCfg()).mcp.chromanche.type).toBe("local");
  });

  it("skips OpenCode registration entirely when the opencode CLI is absent", () => {
    // No opencode binary on PATH.
    writeFakeCommand("claude");

    run();

    expect(existsSync(opencodeCfg())).toBe(false);
    expect(existsSync(opencodeLegacyCfg())).toBe(false);
  });

  it("registers a stdio entry for GitHub Copilot CLI under mcpServers (camelCase)", () => {
    // Sibling smoke test — guards against a regression where the Copilot
    // shape silently drifts back to .servers (its old, invalid schema).
    writeFakeCommand("copilot");

    run();

    expect(existsSync(copilotCfg())).toBe(true);
    const cfg = readJson(copilotCfg());
    expect(cfg.mcpServers.chromanche.type).toBe("stdio");
    expect(cfg.mcpServers.chromanche.command).toBe("node");
    expect(cfg).not.toHaveProperty("servers");
  });
});

describe("install.sh under WSL", () => {
  const WIN_PROFILE = "C:\\Users\\tester";
  const winHome = () => join(winRoot, "Users", "tester");
  const winExt = () => join(winHome(), ".chromanche", "extension");
  const WSL2_KERNEL = "5.15.167.4-microsoft-standard-WSL2";

  const fakeWindows = () => {
    writeFakeCmdExe(WIN_PROFILE);
    writeFakeWslpath({ [WIN_PROFILE]: winHome() });
    mkdirSync(winHome(), { recursive: true });
  };

  it("mirrors the extension into the Windows profile and points Chrome at the Windows path", () => {
    // Kernel string only, no WSL_* env: the marker that survives env scrubbing.
    writeFakeUname("Linux", WSL2_KERNEL);
    fakeWindows();
    writeFakeCommand("claude");

    const { stdout } = runCapture();

    expect(readFileSync(join(winExt(), "manifest.json"), "utf8")).toBe("{}\n");
    expect(stdout).toContain(`select:\n       ${WIN_PROFILE}\\.chromanche\\extension\n`);
    expect(stdout).toContain(`Windows copy: ${WIN_PROFILE}\\.chromanche\\extension\n`);
    // cmd.exe without AutoRun; wslpath got the CR-stripped profile path (the
    // fake only answers for the exact string).
    const log = readFileSync(commandLog, "utf8");
    expect(log).toContain("cmd.exe /d /c echo %USERPROFILE%");
    expect(log).toContain(`wslpath -u ${WIN_PROFILE}`);
    // The MCP server stays on the Linux side and is registered from there; the
    // Linux copy of the extension stays too (for Chromium inside WSL).
    const entry = join(home, ".chromanche", "mcp-server", "dist", "index.cjs");
    expect(log).toContain(`claude mcp add chromanche --scope user -- node ${entry}`);
    expect(existsSync(join(home, ".chromanche", "extension", "manifest.json"))).toBe(true);
  });

  it("creates the pairing token and tells the user exactly what to enter in the popup", () => {
    writeFakeUname("Linux", WSL2_KERNEL);
    fakeWindows();

    const { stdout } = runCapture();

    const tokenFile = join(home, ".chromanche", "token");
    const token = readFileSync(tokenFile, "utf8");
    // Same format the server accepts (packages/mcp-server/src/wsl.ts), 0600.
    expect(token).toMatch(/^wsl_[0-9a-f]{64}$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(stdout).toContain('Pair the extension (needed once under WSL): click the Chromanche\n     icon, open "Advanced — override pairing", enter\n');
    expect(stdout).toContain(`       Port:   48765\n       Token:  ${token}\n`);
    expect(stdout).toContain(`The token is kept in ${tokenFile}`);
    expect(stdout).not.toContain("Pairing is automatic");
  });

  it("keeps the existing token on re-install, so the popup stays paired", () => {
    writeFakeUname("Linux", WSL2_KERNEL);
    fakeWindows();
    runCapture();
    const token = readFileSync(join(home, ".chromanche", "token"), "utf8");

    const { stdout } = runCapture();

    expect(readFileSync(join(home, ".chromanche", "token"), "utf8")).toBe(token);
    expect(stdout).toContain(`Token:  ${token}\n`);
  });

  it("replaces a legacy derived token left by an earlier version", () => {
    writeFakeUname("Linux", WSL2_KERNEL);
    fakeWindows();
    mkdirSync(join(home, ".chromanche"), { recursive: true });
    writeFileSync(join(home, ".chromanche", "token"), "2fe10176".repeat(8));

    runCapture();

    expect(readFileSync(join(home, ".chromanche", "token"), "utf8")).toMatch(/^wsl_[0-9a-f]{64}$/);
  });

  it("detects WSL from WSL_DISTRO_NAME even with an unrecognised kernel string", () => {
    writeFakeUname("Linux", "6.1.0-custom");
    fakeWindows();

    runCapture({ WSL_DISTRO_NAME: "Ubuntu-Test" });

    expect(existsSync(join(winExt(), "manifest.json"))).toBe(true);
  });

  it("replaces a stale Windows copy on re-install but leaves sibling folders alone", () => {
    writeFakeUname("Linux", WSL2_KERNEL);
    fakeWindows();
    mkdirSync(winExt(), { recursive: true });
    writeFileSync(join(winExt(), "stale.js"), "old build\n");
    // A native Windows install could live next to it; not ours to touch.
    mkdirSync(join(winHome(), ".chromanche", "mcp-server"), { recursive: true });
    writeFileSync(join(winHome(), ".chromanche", "mcp-server", "keep.txt"), "native\n");

    runCapture();

    expect(existsSync(join(winExt(), "stale.js"))).toBe(false);
    expect(existsSync(join(winExt(), "manifest.json"))).toBe(true);
    expect(readFileSync(join(winHome(), ".chromanche", "mcp-server", "keep.txt"), "utf8")).toBe("native\n");
  });

  it("without WSL interop: still installs, and says where to copy the extension from", () => {
    writeFakeUname("Linux", WSL2_KERNEL);
    // No cmd.exe / wslpath on PATH.

    const { stdout, stderr } = runCapture({ WSL_DISTRO_NAME: "Ubuntu-Test" });

    const unc = "\\\\wsl.localhost\\Ubuntu-Test" + join(home, ".chromanche", "extension").replaceAll("/", "\\");
    expect(stderr).toContain("your Windows user folder could not be located");
    expect(stderr).toContain(`Copy ${unc} to a Windows folder`);
    expect(stdout).toContain(`the Windows folder you copied ${unc} to`);
    expect(existsSync(join(home, ".chromanche", "mcp-server", "dist", "index.cjs"))).toBe(true);
  });

  it("on plain Linux never calls cmd.exe and keeps the Linux extension path", () => {
    writeFakeUname("Linux", "6.8.0-1021-azure");
    fakeWindows();

    const { stdout } = runCapture();

    expect(existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "").not.toContain("cmd.exe");
    expect(existsSync(winExt())).toBe(false);
    expect(stdout).toContain(`select:\n       ${join(home, ".chromanche", "extension")}\n`);
    expect(stdout).not.toContain("Windows copy:");
    // Outside WSL pairing stays automatic: no token created, no popup steps.
    expect(stdout).toContain("Pairing is automatic");
    expect(stdout).not.toContain("Pair the extension");
    expect(existsSync(join(home, ".chromanche", "token"))).toBe(false);
  });
});

describe("install.sh MCP client summary", () => {
  const row = (label: string, text: string) => `    ${label.padEnd(20)} ${text}\n`;

  it("says where Chromanche got registered and why the other clients were skipped, without warnings", () => {
    writeFakeCommand("claude");

    const { stdout, stderr } = runCapture();

    expect(stdout).toContain(`  MCP clients:\n${row("Claude Code", "registered")}`);
    expect(stdout).toContain(row("Codex", "skipped: 'codex' is not installed (only needed if you use Codex)"));
    expect(stdout).toContain(row("OpenCode", "skipped: 'opencode' is not installed (only needed if you use OpenCode)"));
    expect(stdout).toContain(
      row("GitHub Copilot CLI", "skipped: 'copilot' is not installed (only needed if you use GitHub Copilot CLI)"),
    );
    expect(stdout).toContain("Install one of them later? Re-run this installer and it gets registered too.");
    // A client you don't use is not a problem: no warnings, no hand-edit snippets.
    expect(stderr).not.toContain("!!");
    expect(stdout + stderr).not.toContain("config.toml");
    expect(stdout + stderr).not.toContain("settings.json");
  });

  it("lists every client as registered when all are installed, with no 're-run' hint", () => {
    for (const cli of ["claude", "codex", "opencode", "copilot"]) writeFakeCommand(cli);

    const { stdout } = runCapture();

    for (const label of ["Claude Code", "Codex", "OpenCode", "GitHub Copilot CLI"]) {
      expect(stdout).toContain(row(label, "registered"));
    }
    expect(stdout).not.toContain("Re-run this installer");
  });

  it("warns when no MCP client is installed at all", () => {
    const { stderr } = runCapture();

    expect(stderr).toContain("No MCP client was found, so Chromanche isn't registered anywhere yet.");
  });
});

describe("install.sh Node.js provisioning", () => {
  const entry = () => join(home, ".chromanche", "mcp-server", "dist", "index.cjs");
  const log = () => (existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "");
  const linux = (machine = "x86_64") => writeFakeUname("Linux", "6.8.0-generic", machine);

  it("keeps using a system node that is new enough: no download, plain `node` registered", () => {
    writeFakeCommand("claude");

    const { stdout } = runCapture();

    expect(stdout).not.toContain("Installing Node.js");
    expect(existsSync(join(home, ".chromanche", "node"))).toBe(false);
    expect(log()).toContain(`claude mcp add chromanche --scope user -- node ${entry()}`);
  });

  it("installs a private Node without sudo when the system node is too old, and registers its absolute path", () => {
    linux();
    writeOldSystemNode();
    const dist = makeNodeDist();
    for (const cli of ["claude", "codex", "opencode", "copilot", "sudo"]) writeFakeCommand(cli);

    const { stdout } = runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(stdout).toContain("Found Node.js v18.20.4, but Chromanche needs 20+.");
    expect(stdout).toContain(`Installing Node.js v22.99.0 for Chromanche into ${join(home, ".chromanche", "node")} (no sudo)`);
    expect(execFileSync(privateNode(), ["-v"], { encoding: "utf8" }).trim()).toBe("v22.99.0");
    expect(existsSync(join(home, ".chromanche", ".node-staging"))).toBe(false);
    // Every MCP client gets the absolute path: the private node is not on PATH.
    expect(log()).toContain(`claude mcp add chromanche --scope user -- ${privateNode()} ${entry()}`);
    expect(log()).toContain(`codex mcp add chromanche -- ${privateNode()} ${entry()}`);
    expect(readJson(opencodeCfg()).mcp.chromanche.command).toEqual([privateNode(), entry()]);
    expect(readJson(copilotCfg()).mcpServers.chromanche.command).toBe(privateNode());
    expect(stdout).toContain(`Node.js:     ${privateNode()} (v22.99.0, private to Chromanche, not on your PATH)`);
    expect(log()).not.toMatch(/^sudo /m);
  });

  it.skipIf(SYSTEM_NODE_IN_BASE_PATH)("installs a private Node when there is no node at all", () => {
    linux();
    removeSystemNode();
    const dist = makeNodeDist();

    const { stdout } = runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(stdout).toContain("Node.js not found.");
    expect(execFileSync(privateNode(), ["-v"], { encoding: "utf8" }).trim()).toBe("v22.99.0");
  });

  it.skipIf(SYSTEM_NODE_IN_BASE_PATH)("under WSL, says a Windows node.exe doesn't count", () => {
    writeFakeUname("Linux", "5.15.167.4-microsoft-standard-WSL2");
    removeSystemNode();
    writeScript("node.exe", ["exit 0"]);
    const dist = makeNodeDist();

    const { stdout } = runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(stdout).toContain("Node.js on Windows doesn't count: the MCP server runs inside WSL.");
    expect(existsSync(privateNode())).toBe(true);
  });

  it("picks the build for this CPU (arm64), never a decoy for another platform", () => {
    linux("aarch64");
    writeOldSystemNode();
    const dist = makeNodeDist({ arch: "arm64" });

    runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(execFileSync(privateNode(), ["-v"], { encoding: "utf8" }).trim()).toBe("v22.99.0");
  });

  it("reuses an up-to-date private Node on re-install without downloading it again", () => {
    linux();
    writeOldSystemNode();
    const dist = makeNodeDist();
    runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });
    rmSync(join(dist.dir, dist.tarball)); // a second download would now fail

    const { stdout } = runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(stdout).toContain(`Using Chromanche's Node.js v22.99.0 (${join(home, ".chromanche", "node")})`);
    expect(stdout).not.toContain("Installing Node.js");
  });

  it("upgrades the private Node when a newer build is published", () => {
    linux();
    writeOldSystemNode();
    runCapture({ CHROMANCHE_NODE_DIST_URL: makeNodeDist().url });

    runCapture({ CHROMANCHE_NODE_DIST_URL: makeNodeDist({ version: "22.100.1" }).url });

    expect(execFileSync(privateNode(), ["-v"], { encoding: "utf8" }).trim()).toBe("v22.100.1");
  });

  it("keeps the existing private Node when the download site is unreachable", () => {
    linux();
    writeOldSystemNode();
    writeFakeCommand("claude");
    runCapture({ CHROMANCHE_NODE_DIST_URL: makeNodeDist().url });

    const { stderr } = runCapture(); // default env: dist URL that doesn't exist

    expect(stderr).toContain("to check for Node.js updates; keeping v22.99.0.");
    expect(log()).toContain(`claude mcp add chromanche --scope user -- ${privateNode()} ${entry()}`);
  });

  it("refuses a Node download whose checksum doesn't match, and registers nothing", () => {
    linux();
    writeOldSystemNode();
    writeFakeCommand("claude");
    const dist = makeNodeDist({ badChecksum: true });

    const r = runRaw({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`Checksum mismatch for ${dist.tarball}`);
    expect(existsSync(join(home, ".chromanche", "node"))).toBe(false);
    expect(log()).not.toContain("mcp add");
  });

  it("refuses a Node build that can't run here (musl/old glibc) and leaves nothing half-installed", () => {
    linux();
    writeOldSystemNode();
    const dist = makeNodeDist({ nodeBody: ["exit 127"] });

    const r = runRaw({ CHROMANCHE_NODE_DIST_URL: dist.url });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("doesn't run on this system");
    expect(existsSync(join(home, ".chromanche", "node"))).toBe(false);
    expect(existsSync(join(home, ".chromanche", ".node-staging"))).toBe(false);
  });

  it("fails clearly on a CPU without an official Node.js build", () => {
    linux("mips64");
    writeOldSystemNode();

    const r = runRaw();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No official Node.js build for 'mips64'");
  });
});

describe("install.sh extension zip extraction", () => {
  const extDir = () => join(home, ".chromanche", "extension");
  const ENTRIES: ZipEntry[] = [
    { name: "manifest.json", data: '{"manifest_version":3}\n' },
    { name: "icons/" },
    { name: "icons/readme.txt", data: "deflated ".repeat(50), deflate: true },
  ];
  const expectExtracted = () => {
    expect(readFileSync(join(extDir(), "manifest.json"), "utf8")).toBe('{"manifest_version":3}\n');
    expect(readFileSync(join(extDir(), "icons", "readme.txt"), "utf8")).toBe("deflated ".repeat(50));
  };
  const breakUnzip = () => writeScript("unzip", ["exit 9"]);

  it("extracts with unzip when it is available", () => {
    useOfflineExtensionZip(ENTRIES);

    run();

    expectExtracted();
  });

  it("falls back to Node when unzip is missing or fails", () => {
    useOfflineExtensionZip(ENTRIES);
    breakUnzip();

    run();

    expectExtracted();
  });

  it.skipIf(SYSTEM_NODE_IN_BASE_PATH)(
    "fresh distro with neither node nor unzip: installs a private Node and extracts with it",
    () => {
      linuxFresh();
      useOfflineExtensionZip(ENTRIES);
      breakUnzip();
      // The private "node" answers -v itself and hands everything else
      // (the extraction script) to a real Node.
      const dist = makeNodeDist({
        nodeBody: ['case "$1" in', "  -v|--version) echo v22.99.0 ;;", `  *) exec "${process.execPath}" "$@" ;;`, "esac"],
      });

      runCapture({ CHROMANCHE_NODE_DIST_URL: dist.url });

      expect(execFileSync(privateNode(), ["-v"], { encoding: "utf8" }).trim()).toBe("v22.99.0");
      expectExtracted();
    },
  );

  it("Node fallback refuses entries that escape the extension directory", () => {
    useOfflineExtensionZip([...ENTRIES, { name: "../escaped.txt", data: "pwned" }]);
    breakUnzip();

    const r = runRaw();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unsafe path in zip: ../escaped.txt");
    expect(existsSync(join(home, ".chromanche", "escaped.txt"))).toBe(false);
  });

  it.runIf(typeof (zlib as { crc32?: unknown }).crc32 === "function")(
    "Node fallback rejects a corrupted entry (CRC mismatch)",
    () => {
      useOfflineExtensionZip([{ name: "manifest.json", data: "{}\n", deflate: true, badCrc: true }]);
      breakUnzip();

      const r = runRaw();

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("CRC mismatch for manifest.json");
    },
  );

  function linuxFresh() {
    writeFakeUname("Linux", "6.8.0-generic", "x86_64");
    removeSystemNode();
  }
});

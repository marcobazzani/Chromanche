import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const opencodeCfg = () => join(home, ".config", "opencode", "opencode.json");
const opencodeLegacyCfg = () => join(home, ".opencode", "config.json");
const copilotCfg = () => join(home, ".copilot", "mcp-config.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const writeFakeCommand = (name: string) => {
  const path = join(bin, name);
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `printf '%s %s\\n' "${name}" "$*" >> "${commandLog}"`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
};

const writeScript = (name: string, lines: string[]) => {
  const path = join(bin, name);
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

/** `uname -s` → sys, `uname -r` → release. */
const writeFakeUname = (sys: string, release: string) =>
  writeScript("uname", [
    'case "$1" in',
    `  -r) printf '%s\\n' '${release}' ;;`,
    `  *) printf '%s\\n' '${sys}' ;;`,
    "esac",
  ]);

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
  ...extraEnv,
});

const run = (extraEnv: Record<string, string> = {}) =>
  execFileSync("bash", [SCRIPT], { env: envFor(extraEnv), encoding: "utf8" });

/** Like run(), but also captures stderr (where _warn writes). */
const runCapture = (extraEnv: Record<string, string> = {}) => {
  const r = spawnSync("bash", [SCRIPT], { env: envFor(extraEnv), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`install.sh exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-install-home-"));
  bin = mkdtempSync(join(tmpdir(), "chromanche-install-bin-"));
  offline = mkdtempSync(join(tmpdir(), "chromanche-install-offline-"));
  winRoot = mkdtempSync(join(tmpdir(), "chromanche-install-winroot-"));
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
    expect(stdout).toContain("CHROMANCHE_BROWSER_PLATFORM=linux");
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
    expect(stdout).not.toContain("WSL:");
  });
});

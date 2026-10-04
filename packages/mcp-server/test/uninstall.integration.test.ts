import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/uninstall.sh", import.meta.url));
const HOST_OS = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim();

let home: string;
let bin: string;
let commandLog: string;
let winRoot: string;

const claudeCfg = () => join(home, ".claude", "settings.json");
const opencodeCfg = () => join(home, ".config", "opencode", "opencode.json");
const opencodeLegacyCfg = () => join(home, ".opencode", "config.json");
const copilotCfg = () => join(home, ".copilot", "mcp-config.json");
const codexCfg = () => join(home, ".codex", "config.toml");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const writeJson = (relDir: string, file: string, data: unknown) => {
  mkdirSync(join(home, relDir), { recursive: true });
  writeFileSync(join(home, relDir, file), JSON.stringify(data, null, 2));
};

const writeScript = (name: string, lines: string[]) => {
  const path = join(bin, name);
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

const writeFakeCommand = (name: string) =>
  writeScript(name, [`printf '%s %s\\n' "${name}" "$*" >> "${commandLog}"`, "exit 0"]);

const writeFakeUname = (sys: string, release: string) =>
  writeScript("uname", [
    'case "$1" in',
    `  -r) printf '%s\\n' '${release}' ;;`,
    `  *) printf '%s\\n' '${sys}' ;;`,
    "esac",
  ]);

const WIN_PROFILE = "C:\\Users\\tester";
const winHome = () => join(winRoot, "Users", "tester");

/** Fake WSL interop: cmd.exe prints the profile (CRLF), wslpath maps it into winRoot. */
const fakeWindows = () => {
  writeScript("cmd.exe", [
    `printf '%s %s\\n' "cmd.exe" "$*" >> "${commandLog}"`,
    `printf '%s\\r\\n' '${WIN_PROFILE}'`,
  ]);
  writeScript("wslpath", [
    `if [ "$1" = "-u" ] && [ "$2" = '${WIN_PROFILE}' ]; then printf '%s\\n' '${winHome()}'; exit 0; fi`,
    "exit 1",
  ]);
  mkdirSync(winHome(), { recursive: true });
};

const run = () =>
  execFileSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // Never inherit WSL markers from a developer's WSL shell.
      WSL_DISTRO_NAME: "",
      WSL_INTEROP: "",
    },
    encoding: "utf8",
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-uninstall-home-"));
  bin = mkdtempSync(join(tmpdir(), "chromanche-uninstall-bin-"));
  winRoot = mkdtempSync(join(tmpdir(), "chromanche-uninstall-winroot-"));
  commandLog = join(home, "commands.log");
  writeFakeCommand("claude");
  writeFakeCommand("codex");
  // Hermetic: a non-WSL kernel by default, so running the suite inside WSL
  // can never reach (and delete from) the developer's real Windows profile.
  writeFakeUname(HOST_OS, "0.0.0-generic");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(winRoot, { recursive: true, force: true });
});

describe("uninstall.sh", () => {
  it("removes chromanche and legacy browseruse installs and MCP registrations", () => {
    mkdirSync(join(home, ".chromanche", "mcp-server"), { recursive: true });
    mkdirSync(join(home, ".browseruse", "mcp-server"), { recursive: true });

    writeJson(".claude", "settings.json", {
      mcpServers: {
        chromanche: { command: "node" },
        browseruse: { command: "node" },
        keepme: { command: "x" },
      },
    });
    writeJson(".config/opencode", "opencode.json", {
      mcp: {
        chromanche: { type: "local" },
        browseruse: { type: "local" },
        keepme: { type: "local" },
      },
    });
    // Stale config left behind by older installers that wrote to the wrong path.
    writeJson(".opencode", "config.json", {
      mcp: {
        chromanche: { type: "local" },
        browseruse: { type: "local" },
      },
    });
    writeJson(".copilot", "mcp-config.json", {
      mcpServers: {
        chromanche: { type: "stdio" },
        browseruse: { type: "stdio" },
        keepme: { type: "stdio" },
      },
    });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexCfg(), [
      "[mcp_servers.chromanche]",
      'command = "node"',
      'args = ["/new/index.cjs"]',
      "",
      "[mcp_servers.browseruse]",
      'command = "node"',
      'args = ["/old/index.cjs"]',
      "",
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
    ].join("\n"));

    run();

    expect(existsSync(join(home, ".chromanche"))).toBe(false);
    expect(existsSync(join(home, ".browseruse"))).toBe(false);
    expect(readJson(claudeCfg()).mcpServers).toEqual({ keepme: { command: "x" } });
    expect(readJson(opencodeCfg()).mcp).toEqual({ keepme: { type: "local" } });
    // The legacy path must also be scrubbed so users do not retain a ghost
    // entry that points at a deleted binary.
    expect(readJson(opencodeLegacyCfg())).not.toHaveProperty("mcp");
    expect(readJson(copilotCfg()).mcpServers).toEqual({ keepme: { type: "stdio" } });
    expect(readFileSync(codexCfg(), "utf8")).toBe([
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
    ].join("\n"));
    expect(readFileSync(commandLog, "utf8")).toContain("claude mcp remove chromanche --scope user");
    expect(readFileSync(commandLog, "utf8")).toContain("claude mcp remove browseruse --scope user");
    expect(readFileSync(commandLog, "utf8")).toContain("codex mcp remove chromanche");
    expect(readFileSync(commandLog, "utf8")).toContain("codex mcp remove browseruse");
  });

  it("on non-WSL hosts never calls cmd.exe or touches a Windows profile", () => {
    fakeWindows();
    mkdirSync(join(winHome(), ".chromanche", "extension"), { recursive: true });

    run();

    expect(readFileSync(commandLog, "utf8")).not.toContain("cmd.exe");
    expect(existsSync(join(winHome(), ".chromanche", "extension"))).toBe(true);
  });

  it("under WSL removes the Windows extension copy but leaves a native Windows install alone", () => {
    writeFakeUname("Linux", "5.15.167.4-microsoft-standard-WSL2");
    fakeWindows();
    mkdirSync(join(winHome(), ".chromanche", "extension"), { recursive: true });
    writeFileSync(join(winHome(), ".chromanche", "extension", "manifest.json"), "{}\n");
    mkdirSync(join(winHome(), ".chromanche", "mcp-server"), { recursive: true });
    writeFileSync(join(winHome(), ".chromanche", "mcp-server", "keep.txt"), "native\n");

    const out = run();

    expect(out).toContain(`Removing ${WIN_PROFILE}\\.chromanche\\extension`);
    expect(existsSync(join(winHome(), ".chromanche", "extension"))).toBe(false);
    expect(readFileSync(join(winHome(), ".chromanche", "mcp-server", "keep.txt"), "utf8")).toBe("native\n");
  });

  it("under WSL also drops the Windows .chromanche folder once it is empty", () => {
    writeFakeUname("Linux", "5.15.167.4-microsoft-standard-WSL2");
    fakeWindows();
    mkdirSync(join(winHome(), ".chromanche", "extension"), { recursive: true });
    writeFileSync(join(winHome(), ".chromanche", "extension", "manifest.json"), "{}\n");

    run();

    expect(existsSync(join(winHome(), ".chromanche"))).toBe(false);
  });
});

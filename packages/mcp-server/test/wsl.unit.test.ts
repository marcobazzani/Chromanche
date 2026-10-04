import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WSL_PORT,
  WSL_TOKEN_RE,
  ensureWslToken,
  isWsl,
  wslPairingHelp,
  type WslDetectionDeps,
} from "../src/wsl.js";

function deps(overrides: Partial<WslDetectionDeps> = {}): WslDetectionDeps {
  return {
    platform: () => "linux",
    release: () => "5.15.0-generic",
    env: {},
    readProcVersion: () => {
      throw new Error("ENOENT");
    },
    ...overrides,
  };
}

describe("isWsl", () => {
  it("is false on native linux, macOS and Windows", () => {
    expect(isWsl(deps())).toBe(false);
    expect(isWsl(deps({ platform: () => "darwin" }))).toBe(false);
    expect(isWsl(deps({ platform: () => "win32", env: { WSL_DISTRO_NAME: "Ubuntu" } }))).toBe(false);
  });

  it("detects WSL via WSL_DISTRO_NAME or WSL_INTEROP", () => {
    expect(isWsl(deps({ env: { WSL_DISTRO_NAME: "Ubuntu" } }))).toBe(true);
    expect(isWsl(deps({ env: { WSL_INTEROP: "/run/WSL/1_interop" } }))).toBe(true);
  });

  it("detects WSL2 from the kernel string even when the MCP client strips WSL_* env vars", () => {
    expect(isWsl(deps({ release: () => "6.18.40.1-microsoft-standard-WSL2" }))).toBe(true);
  });

  it("detects WSL1 via /proc/version", () => {
    expect(isWsl(deps({ readProcVersion: () => "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)" }))).toBe(true);
  });

  it("does not throw when os.release() or /proc/version are unreadable", () => {
    const broken = deps({
      release: () => {
        throw new Error("boom");
      },
    });
    expect(isWsl(broken)).toBe(false);
  });
});

describe("ensureWslToken", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chromanche-wsl-token-"));
    file = join(dir, "token");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a random wsl_ token readable only by the user", () => {
    const token = ensureWslToken(file);
    expect(token).toMatch(WSL_TOKEN_RE);
    expect(readFileSync(file, "utf8")).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ensureWslToken(join(dir, "other"))).not.toBe(token);
  });

  it("reuses an existing token, so the value pasted into the popup stays valid", () => {
    const first = ensureWslToken(file);
    expect(ensureWslToken(file)).toBe(first);
  });

  it("accepts a token written by install.sh (same format, trailing newline tolerated)", () => {
    const fromInstaller = `wsl_${"ab".repeat(32)}`;
    writeFileSync(file, `${fromInstaller}\n`);
    expect(ensureWslToken(file)).toBe(fromInstaller);
  });

  it("replaces a legacy derived token (the extension couldn't have been paired with it under WSL)", () => {
    writeFileSync(file, "2fe10176".repeat(8));
    const token = ensureWslToken(file);
    expect(token).toMatch(WSL_TOKEN_RE);
    expect(readFileSync(file, "utf8")).toBe(token);
  });

  it("tightens a pre-existing world-readable token file to 0600", () => {
    writeFileSync(file, "legacy");
    chmodSync(file, 0o644);
    ensureWslToken(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("wslPairingHelp", () => {
  const help = wslPairingHelp(48765, "/home/me/.chromanche/token");

  it("gives the exact popup steps with the port and where to read the token", () => {
    expect(help).toContain('"Advanced — override pairing"');
    expect(help).toContain("set Port to 48765");
    expect(help).toContain("cat /home/me/.chromanche/token");
    expect(help).toContain("Test-NetConnection 127.0.0.1 -Port 48765");
  });

  it("never contains a token (tool errors reach the model and the LLM backend)", () => {
    expect(help).not.toMatch(/wsl_[0-9a-f]{8}/);
  });
});

describe("WSL_PORT", () => {
  it("sits below Windows' dynamic port range, where Hyper-V reserves blocks", () => {
    expect(WSL_PORT).toBeGreaterThan(1024);
    expect(WSL_PORT).toBeLessThan(49152);
  });

  it("matches the installer's copy", () => {
    const installer = readFileSync(new URL("../../../scripts/install.sh", import.meta.url), "utf8");
    expect(installer).toContain(`WSL_PORT=${WSL_PORT}\n`);
  });
});

import { describe, expect, it } from "vitest";
import {
  describePairing,
  isWsl,
  resolvePairingPlatform,
  type WslDetectionDeps,
} from "../src/config.js";

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
  it("is false on native linux (no WSL markers)", () => {
    expect(isWsl(deps())).toBe(false);
  });

  it("is false on native windows (platform never reaches WSL checks)", () => {
    expect(isWsl(deps({ platform: () => "win32", env: { WSL_DISTRO_NAME: "Ubuntu" } }))).toBe(false);
  });

  it("is false on macOS", () => {
    expect(isWsl(deps({ platform: () => "darwin" }))).toBe(false);
  });

  it("detects WSL via WSL_DISTRO_NAME env var", () => {
    expect(isWsl(deps({ env: { WSL_DISTRO_NAME: "Ubuntu" } }))).toBe(true);
  });

  it("detects WSL via WSL_INTEROP env var", () => {
    expect(isWsl(deps({ env: { WSL_INTEROP: "/run/WSL/1_interop" } }))).toBe(true);
  });

  it("detects WSL2 via kernel release string even when the MCP client strips WSL_* env vars", () => {
    expect(isWsl(deps({ env: {}, release: () => "5.15.167.4-microsoft-standard-WSL2" }))).toBe(true);
  });

  it("detects WSL1 via /proc/version mentioning Microsoft", () => {
    expect(
      isWsl(
        deps({
          readProcVersion: () =>
            "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) ...",
        }),
      ),
    ).toBe(true);
  });

  it("is case-insensitive when matching markers", () => {
    expect(isWsl(deps({ release: () => "5.15.0-WSL2-standard" }))).toBe(true);
  });

  it("does not throw when os.release() or /proc/version are unreadable", () => {
    const broken = deps({
      release: () => {
        throw new Error("boom");
      },
    });
    expect(() => isWsl(broken)).not.toThrow();
    expect(isWsl(broken)).toBe(false);
  });
});

describe("resolvePairingPlatform", () => {
  it("pairs with Windows Chrome under WSL", () => {
    expect(resolvePairingPlatform(deps({ env: { WSL_DISTRO_NAME: "Ubuntu" } }))).toEqual({
      platform: "win",
      source: "wsl",
    });
  });

  it("pairs with the host OS when not under WSL, normalized like the extension does", () => {
    expect(resolvePairingPlatform(deps())).toEqual({ platform: "linux", source: "os" });
    expect(resolvePairingPlatform(deps({ platform: () => "darwin" }))).toEqual({ platform: "mac", source: "os" });
    expect(resolvePairingPlatform(deps({ platform: () => "win32" }))).toEqual({ platform: "win", source: "os" });
  });

  it("CHROMANCHE_BROWSER_PLATFORM beats WSL detection (Chromium inside WSL via WSLg)", () => {
    const r = resolvePairingPlatform(
      deps({ env: { WSL_DISTRO_NAME: "Ubuntu", CHROMANCHE_BROWSER_PLATFORM: "linux" } }),
    );
    expect(r).toEqual({ platform: "linux", source: "override" });
  });

  it("accepts the same spellings as the shared normalizer, trimmed and case-insensitive", () => {
    expect(resolvePairingPlatform(deps({ env: { CHROMANCHE_BROWSER_PLATFORM: " Windows " } }))).toEqual({
      platform: "win",
      source: "override",
    });
    expect(resolvePairingPlatform(deps({ env: { CHROMANCHE_BROWSER_PLATFORM: "darwin" } })).platform).toBe("mac");
    expect(resolvePairingPlatform(deps({ env: { CHROMANCHE_BROWSER_PLATFORM: "cros" } })).platform).toBe("cros");
  });

  it("treats an empty override as unset", () => {
    expect(resolvePairingPlatform(deps({ env: { CHROMANCHE_BROWSER_PLATFORM: "  " } }))).toEqual({
      platform: "linux",
      source: "os",
    });
  });

  it("rejects an unknown override loudly instead of silently pairing as 'other'", () => {
    expect(() =>
      resolvePairingPlatform(deps({ env: { CHROMANCHE_BROWSER_PLATFORM: "beos" } })),
    ).toThrow(/CHROMANCHE_BROWSER_PLATFORM must be one of win, mac, linux, cros \(got: beos\)/);
  });
});

describe("describePairing", () => {
  it("explains the WSL choice and how to undo it", () => {
    const line = describePairing({ timezone: "Europe/Rome", platform: "win", source: "wsl" });
    expect(line).toContain("timezone=Europe/Rome platform=win");
    expect(line).toContain("WSL detected");
    expect(line).toContain("CHROMANCHE_BROWSER_PLATFORM=linux");
  });

  it("credits the override", () => {
    const line = describePairing({ timezone: "UTC", platform: "linux", source: "override" });
    expect(line).toBe("[chromanche] pairing inputs: timezone=UTC platform=linux (from CHROMANCHE_BROWSER_PLATFORM)");
  });

  it("is a bare summary for the host-OS case", () => {
    const line = describePairing({ timezone: "UTC", platform: "mac", source: "os" });
    expect(line).toBe("[chromanche] pairing inputs: timezone=UTC platform=mac");
  });
});

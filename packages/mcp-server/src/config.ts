import { mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";
import { derivePairing, getTimezone, normalizePlatform } from "@chromanche/shared";

export type BrowserPlatform = ReturnType<typeof normalizePlatform>;

/**
 * Why the server pairs with the platform it does:
 *   - "override": CHROMANCHE_BROWSER_PLATFORM is set
 *   - "wsl":      running under WSL, so the browser is Chrome on Windows
 *   - "os":       the browser runs on the same OS as this server
 */
export type PairingPlatformSource = "override" | "wsl" | "os";

/** What the derived token + port are computed from. Logged at startup. */
export interface PairingInputs {
  timezone: string;
  /** Normalized platform of the browser we expect to pair with. */
  platform: BrowserPlatform;
  source: PairingPlatformSource;
}

export interface Config {
  port: number;
  timeoutMs: number;
  token: string;
  tokenFile: string;
  /** True when the token was derived (zero-config pairing) rather than explicit. */
  derived: boolean;
  pairing: PairingInputs;
  /** Under WSL: how long to wait for an extension before printing troubleshooting hints. */
  wslHintMs: number;
}

/** Injectable OS probes so WSL detection is unit-testable without mocking node:os/node:fs. */
export interface WslDetectionDeps {
  platform: () => string;
  release: () => string;
  env: Record<string, string | undefined>;
  readProcVersion: () => string;
}

const defaultWslDeps: WslDetectionDeps = {
  platform,
  release,
  env: process.env,
  readProcVersion: () => readFileSync("/proc/version", "utf8"),
};

/**
 * WSL runs a real Linux kernel, so node:os.platform() reports "linux" — but
 * the user's actual browser is almost always native Windows Chrome, whose
 * extension reports platform "win" via chrome.runtime.getPlatformInfo().
 * Left uncorrected, the two sides derive different pairing fingerprints
 * (different port + token) and silently fail to pair, even though WSL2's
 * default localhost forwarding makes this server's 127.0.0.1 listener
 * reachable from Windows. Detect WSL so we pair as Windows instead.
 *
 * The kernel-string checks matter as much as the env vars: several MCP
 * clients spawn servers with a whitelisted environment (the MCP TypeScript
 * SDK's default keeps only HOME/LOGNAME/PATH/SHELL/TERM/USER), so
 * WSL_DISTRO_NAME / WSL_INTEROP often never reach us.
 */
export function isWsl(deps: WslDetectionDeps = defaultWslDeps): boolean {
  if (deps.platform() !== "linux") return false;
  if (deps.env.WSL_DISTRO_NAME || deps.env.WSL_INTEROP) return true;
  try {
    if (/microsoft|wsl/i.test(deps.release())) return true;
  } catch {
    // os.release() failing is not expected, but don't let it crash startup.
  }
  try {
    if (/microsoft|wsl/i.test(deps.readProcVersion())) return true;
  } catch {
    // /proc/version is Linux-only and may be unreadable in sandboxed environments.
  }
  return false;
}

/**
 * Pick the browser platform the pairing is derived for. CHROMANCHE_BROWSER_PLATFORM
 * wins (e.g. "linux" for Chromium running inside WSL via WSLg); otherwise WSL
 * pairs with Windows Chrome and everything else with the host OS.
 */
export function resolvePairingPlatform(
  deps: WslDetectionDeps = defaultWslDeps,
): { platform: BrowserPlatform; source: PairingPlatformSource } {
  const override = deps.env.CHROMANCHE_BROWSER_PLATFORM?.trim();
  if (override) {
    const normalized = normalizePlatform(override);
    if (normalized === "other") {
      throw new Error(
        `CHROMANCHE_BROWSER_PLATFORM must be one of win, mac, linux, cros (got: ${override})`,
      );
    }
    return { platform: normalized, source: "override" };
  }
  if (isWsl(deps)) return { platform: "win", source: "wsl" };
  return { platform: normalizePlatform(deps.platform()), source: "os" };
}

/** One-line, stderr-friendly summary of the pairing inputs. */
export function describePairing(p: PairingInputs): string {
  const why =
    p.source === "wsl"
      ? " (WSL detected: pairing with Chrome on Windows; set CHROMANCHE_BROWSER_PLATFORM=linux if Chrome runs inside WSL)"
      : p.source === "override"
        ? " (from CHROMANCHE_BROWSER_PLATFORM)"
        : "";
  return `[chromanche] pairing inputs: timezone=${p.timezone} platform=${p.platform}${why}`;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`CHROMANCHE_PORT is not a valid TCP port: ${raw}`);
  }
  return n;
}

function parsePositiveMs(name: string, raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} is not a positive number: ${raw}`);
  }
  return n;
}

/**
 * Load config, defaulting token+port to values derived from a stable fingerprint
 * (timezone + normalized browser platform). The extension computes the same
 * values independently, so pairing is zero-config. Env vars still override.
 */
export async function loadConfig(): Promise<Config> {
  const timezone = getTimezone();
  const { platform: browserPlatform, source } = resolvePairingPlatform();
  const derived = await derivePairing({ timezone, platform: browserPlatform });
  const port = parsePort(process.env.CHROMANCHE_PORT) ?? derived.port;
  const timeoutMs = parsePositiveMs("CHROMANCHE_TIMEOUT_MS", process.env.CHROMANCHE_TIMEOUT_MS, 20000);
  // Undocumented on purpose: lets integration tests shorten the WSL hint delay.
  const wslHintMs = parsePositiveMs("CHROMANCHE_WSL_HINT_MS", process.env.CHROMANCHE_WSL_HINT_MS, 15000);
  const envToken = process.env.CHROMANCHE_TOKEN;
  const token = envToken ?? derived.token;
  const isDerived = !envToken;

  // Persist the token to disk so operators can inspect/override with an editor
  // even in derived mode. Mode 0o600 atomically (no world-readable window).
  const dir = join(homedir(), ".chromanche");
  mkdirSync(dir, { recursive: true });
  const tokenFile = join(dir, "token");
  const fd = openSync(tokenFile, "w", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return {
    port,
    timeoutMs,
    token,
    tokenFile,
    derived: isDerived,
    pairing: { timezone, platform: browserPlatform, source },
    wslHintMs,
  };
}

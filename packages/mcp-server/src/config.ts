import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { derivePairing, getTimezone } from "@chromanche/shared";
import { WSL_PORT, ensureWslToken, isWsl, wslPairingHelp } from "./wsl.js";

/**
 * How the token/port were chosen:
 *   - "derived":  zero-config pairing from timezone + platform (the extension
 *                 computes the same values on its side)
 *   - "explicit": CHROMANCHE_TOKEN set in the environment
 *   - "wsl":      running under WSL: fixed port + random token, pasted into the
 *                 extension popup once (WSL and Chrome often disagree on the
 *                 timezone, so derived values wouldn't match)
 */
export type PairingMode = "derived" | "explicit" | "wsl";

export interface Config {
  port: number;
  timeoutMs: number;
  token: string;
  tokenFile: string;
  pairingMode: PairingMode;
  /** Set under WSL: how to pair by hand. Logged at startup and returned by tools while nothing is connected. */
  pairingHelp?: string;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`CHROMANCHE_PORT is not a valid TCP port: ${raw}`);
  }
  return n;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CHROMANCHE_TIMEOUT_MS is not a positive number: ${raw}`);
  }
  return n;
}

function writeTokenFile(tokenFile: string, token: string): void {
  // Mode 0o600 atomically (no world-readable window).
  const fd = openSync(tokenFile, "w", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
}

/**
 * Load config. Outside WSL, token + port default to values derived from a
 * stable fingerprint (timezone + platform) that the extension computes
 * independently, so pairing is zero-config. Under WSL they default to a fixed
 * port and a persisted random token instead. Env vars override both.
 *
 * ~/.chromanche/token always holds the token in use, so operators can inspect
 * it (and, under WSL, copy it into the extension popup).
 */
export async function loadConfig(): Promise<Config> {
  const timeoutMs = parsePositiveMs(process.env.CHROMANCHE_TIMEOUT_MS, 20000);
  const envPort = parsePort(process.env.CHROMANCHE_PORT);
  const envToken = process.env.CHROMANCHE_TOKEN;
  const dir = join(homedir(), ".chromanche");
  mkdirSync(dir, { recursive: true });
  const tokenFile = join(dir, "token");

  if (isWsl()) {
    const port = envPort ?? WSL_PORT;
    let token: string;
    if (envToken) {
      token = envToken;
      writeTokenFile(tokenFile, token);
    } else {
      token = ensureWslToken(tokenFile);
    }
    return {
      port,
      timeoutMs,
      token,
      tokenFile,
      pairingMode: envToken ? "explicit" : "wsl",
      pairingHelp: wslPairingHelp(port, tokenFile),
    };
  }

  const derived = await derivePairing({ timezone: getTimezone(), platform: platform() });
  const token = envToken ?? derived.token;
  writeTokenFile(tokenFile, token);
  return {
    port: envPort ?? derived.port,
    timeoutMs,
    token,
    tokenFile,
    pairingMode: envToken ? "explicit" : "derived",
  };
}

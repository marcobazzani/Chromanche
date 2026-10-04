import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { platform, release } from "node:os";

/**
 * Bridge port when the MCP server runs under WSL. Automatic pairing derives
 * the port from the timezone, and WSL and Chrome on Windows often disagree on
 * it (WSL may sit on UTC while Chrome reports Europe/Berlin), so under WSL the
 * port is fixed and the user pairs the extension by hand once. Below Windows'
 * dynamic port range (49152+), where Hyper-V/WinNAT reserve port blocks.
 */
export const WSL_PORT = 48765;

/** Tokens we generate for WSL. Anything else in the token file (e.g. a derived token from an older version) is replaced. */
export const WSL_TOKEN_RE = /^wsl_[0-9a-f]{64}$/;

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
 * WSL runs a real Linux kernel, so node:os.platform() reports "linux". The
 * kernel-string checks matter as much as the env vars: several MCP clients
 * spawn servers with a whitelisted environment (the MCP TypeScript SDK's
 * default keeps only HOME/LOGNAME/PATH/SHELL/TERM/USER), so WSL_DISTRO_NAME /
 * WSL_INTEROP often never reach us.
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
    // /proc/version may be unreadable in sandboxed environments.
  }
  return false;
}

/**
 * Return the WSL pairing token stored in `file`, generating it on first use.
 * Random (unlike derived tokens, a web page can't compute it), 0600, and
 * reused across restarts and re-installs so the value pasted into the
 * extension popup stays valid. install.sh applies the same rule.
 */
export function ensureWslToken(file: string): string {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (WSL_TOKEN_RE.test(existing)) return existing;
  } catch {
    // No token yet.
  }
  const token = `wsl_${randomBytes(32).toString("hex")}`;
  const fd = openSync(file, "w", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600); // openSync's mode only applies when it creates the file
  return token;
}

/**
 * How to pair by hand, for the startup log and for "no extension connected"
 * tool errors. Never includes the token itself: tool errors reach the model
 * and the LLM backend.
 */
export function wslPairingHelp(port: number, tokenFile: string): string {
  return [
    "The MCP server runs in WSL, so the Chrome extension has to be paired by hand once:",
    `open the Chromanche extension popup in Chrome, expand "Advanced — override pairing", set Port to ${port} and Token to the contents of ${tokenFile} (run: cat ${tokenFile}), then click "Save override".`,
    `If it still doesn't connect, check from Windows PowerShell that the port is reachable: Test-NetConnection 127.0.0.1 -Port ${port}`,
  ].join("\n");
}

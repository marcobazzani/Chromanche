/**
 * Under WSL, Chrome on Windows reaches this server through WSL's localhost
 * forwarding: a hop whose failure modes are invisible from inside WSL. If no
 * extension has connected after a grace period, print the checks that tell
 * them apart. Callers must write it to stderr: stdout carries MCP frames.
 */
export function formatWslConnectHint(opts: { port: number; timezone: string; waitedMs: number }): string {
  const { port, timezone } = opts;
  const secs = Math.max(1, Math.round(opts.waitedMs / 1000));
  return [
    `[chromanche] WSL: no extension has connected on port ${port} after ${secs}s. If Chrome is running on Windows with the extension enabled:`,
    `[chromanche]   - The extension popup should show "port ${port}". A different port means the two sides derived different pairings: Chrome's timezone (DevTools console: Intl.DateTimeFormat().resolvedOptions().timeZone) must be exactly "${timezone}".`,
    `[chromanche]   - PowerShell: Test-NetConnection 127.0.0.1 -Port ${port}. False means WSL isn't forwarding the port: check localhostForwarding in %UserProfile%\\.wslconfig, or run "wsl --shutdown" and retry.`,
    `[chromanche]   - PowerShell: netsh interface ipv4 show excludedportrange protocol=tcp. If ${port} falls in a listed range, Windows has reserved it: set CHROMANCHE_PORT to a free port and enter the same port in the extension popup.`,
    `[chromanche]   - A Chromanche server started natively on Windows takes the same port and hides this one.`,
    `[chromanche]   - If Chrome runs inside WSL instead, set CHROMANCHE_BROWSER_PLATFORM=linux for this server.`,
  ].join("\n");
}

/**
 * Print the hint once after `delayMs` unless cancelled first (call the
 * returned function when an extension connects). The timer is unref'd so it
 * never keeps the process alive on its own.
 */
export function scheduleWslConnectHint(opts: {
  delayMs: number;
  port: number;
  timezone: string;
  log: (msg: string) => void;
}): () => void {
  const timer = setTimeout(() => {
    opts.log(formatWslConnectHint({ port: opts.port, timezone: opts.timezone, waitedMs: opts.delayMs }));
  }, opts.delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

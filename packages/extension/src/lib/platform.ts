/**
 * OS of the browser running this extension.
 *
 * Always derived from chrome.runtime.getPlatformInfo — never from the MCP
 * server's platform: under WSL the server runs on Linux while Chrome runs on
 * Windows, and keyboard shortcuts must follow the browser (⌘ on macOS, Ctrl on
 * Windows / Linux / ChromeOS).
 */
export type BrowserOs = "mac" | "win" | "linux" | "cros" | "android" | "openbsd" | "fuchsia" | "unknown";

let cached: { chromeRef: unknown; os: BrowserOs } | undefined;

export async function getBrowserOs(): Promise<BrowserOs> {
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  // Keyed on the chrome object so unit tests that swap the global get a fresh answer.
  if (cached && cached.chromeRef === c) return cached.os;
  let os: BrowserOs = "unknown";
  try {
    if (c?.runtime?.getPlatformInfo) {
      const info = await c.runtime.getPlatformInfo();
      if (info?.os) os = info.os as BrowserOs;
    }
  } catch {
    // Unavailable → "unknown", which behaves like Windows/Linux (Ctrl shortcuts).
  }
  cached = { chromeRef: c, os };
  return os;
}

export async function isMacBrowser(): Promise<boolean> {
  return (await getBrowserOs()) === "mac";
}

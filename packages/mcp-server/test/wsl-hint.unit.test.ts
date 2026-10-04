import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatWslConnectHint, scheduleWslConnectHint } from "../src/wsl-hint.js";

describe("formatWslConnectHint", () => {
  const hint = formatWslConnectHint({ port: 53123, timezone: "Europe/Rome", waitedMs: 15000 });

  it("names the port and the wait", () => {
    expect(hint).toContain("no extension has connected on port 53123 after 15s");
  });

  it("gives the popup/timezone check with the server's timezone", () => {
    expect(hint).toContain('popup should show "port 53123"');
    expect(hint).toContain('must be exactly "Europe/Rome"');
  });

  it("gives copy-pasteable PowerShell checks for forwarding and Hyper-V reserved ports", () => {
    expect(hint).toContain("Test-NetConnection 127.0.0.1 -Port 53123");
    expect(hint).toContain("netsh interface ipv4 show excludedportrange protocol=tcp");
    expect(hint).toContain("localhostForwarding");
  });

  it("mentions the WSLg escape hatch", () => {
    expect(hint).toContain("CHROMANCHE_BROWSER_PLATFORM=linux");
  });

  it("prefixes every line so it is greppable in client logs", () => {
    for (const line of hint.split("\n")) expect(line.startsWith("[chromanche]")).toBe(true);
  });
});

describe("scheduleWslConnectHint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the hint once after the delay when nothing cancelled it", () => {
    const log = vi.fn();
    scheduleWslConnectHint({ delayMs: 15000, port: 50001, timezone: "UTC", log });
    vi.advanceTimersByTime(14999);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("port 50001");
    vi.advanceTimersByTime(60000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("stays silent when cancelled before the delay (extension connected)", () => {
    const log = vi.fn();
    const cancel = scheduleWslConnectHint({ delayMs: 15000, port: 50001, timezone: "UTC", log });
    vi.advanceTimersByTime(5000);
    cancel();
    vi.advanceTimersByTime(60000);
    expect(log).not.toHaveBeenCalled();
  });

  it("cancel is idempotent (bridge calls it on every extension connect)", () => {
    const log = vi.fn();
    const cancel = scheduleWslConnectHint({ delayMs: 1000, port: 50001, timezone: "UTC", log });
    cancel();
    expect(() => cancel()).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(log).not.toHaveBeenCalled();
  });
});

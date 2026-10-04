import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { build, type Options } from "tsup";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { derivePairing } from "@chromanche/shared";
import tsupConfig from "../tsup.config.js";
import { isWsl } from "../src/config.js";

/**
 * Spawns the real MCP server binary (built from the current sources, so a
 * stale dist/ can't mask a regression) the way an MCP client does, with a
 * minimal, explicit environment, then plays the extension over the real
 * WebSocket using independently derived credentials.
 *
 * WSL is simulated with WSL_DISTRO_NAME, which only takes effect on Linux
 * (isWsl() short-circuits elsewhere), so the WSL cases run in CI (Ubuntu)
 * and are skipped on macOS dev machines.
 *
 * TZ is pinned to an exotic zone so the derived ports can never collide with
 * a live Chromanche instance on the developer's machine.
 */
const TZ = "Antarctica/Troll";
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

let buildDir: string;
let entry: string;

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "chromanche-pairing-build-"));
  await build({
    ...(tsupConfig as Options),
    entry: [join(PKG_DIR, "src", "index.ts")],
    outDir: buildDir,
    outExtension: () => ({ js: ".cjs" }),
    dts: false,
    clean: false,
    silent: true,
    config: false,
  });
  entry = join(buildDir, "index.cjs");
}, 60_000);

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** Also the pre-flight check: fail loudly rather than talk to a stranger on our port. */
async function waitPortFree(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await portIsFree(port))) {
    if (Date.now() > deadline) throw new Error(`port ${port} is still in use; cannot run pairing test hermetically`);
    await sleep(50);
  }
}

interface Spawned {
  client: Client;
  home: string;
  stderr: () => string;
  close: () => Promise<void>;
}

async function spawnServer(port: number, extraEnv: Record<string, string>): Promise<Spawned> {
  await waitPortFree(port);
  const home = mkdtempSync(join(tmpdir(), "chromanche-pairing-home-"));
  // Deliberately minimal, like MCP clients that whitelist env vars. No
  // CHROMANCHE_* or WSL_* leaks in from the developer's shell.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TZ,
    ...extraEnv,
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  const client = new Client({ name: "pairing-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  let buf = "";
  // Paused-mode stream: anything written before this listener is buffered, not lost.
  transport.stderr?.on("data", (d: Buffer) => {
    buf += d.toString();
  });
  return {
    client,
    home,
    stderr: () => buf,
    close: async () => {
      await client.close();
      // The SDK's close() doesn't wait for the child to exit; the next test
      // may reuse this port, so wait until the server has really let go.
      await waitPortFree(port);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function connectExtension(port: number, token: string, profile: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token, profile, label: profile }));
  return ws;
}

async function listProfileTags(client: Client): Promise<string[]> {
  const r = await client.callTool({ name: "chromanche_list_profiles", arguments: {} });
  const content = r.content as Array<{ type: string; text: string }>;
  return (JSON.parse(content[0]!.text) as Array<{ tag: string }>).map((p) => p.tag);
}

const WAIT = { timeout: 5000, interval: 50 };
const HINT = "WSL: no extension has connected";

describe.runIf(process.platform === "linux")("pairing under WSL (simulated on Linux)", () => {
  it("derives the Windows pairing, so Chrome on Windows authenticates on the derived port", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: "win" });
    const s = await spawnServer(expected.port, { WSL_DISTRO_NAME: "Ubuntu-Test", CHROMANCHE_WSL_HINT_MS: "60000" });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${expected.port}`), WAIT);
      expect(s.stderr()).toContain(`pairing inputs: timezone=${TZ} platform=win (WSL detected`);
      expect(readFileSync(join(s.home, ".chromanche", "token"), "utf8")).toBe(expected.token);

      // Play the Windows extension: it derives with platform "win" on its side.
      const ws = await connectExtension(expected.port, expected.token, "win-chrome");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["win-chrome"]), WAIT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
    }
  }, 20_000);

  it("prints the troubleshooting hint when no extension connects in time", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: "win" });
    const s = await spawnServer(expected.port, { WSL_DISTRO_NAME: "Ubuntu-Test", CHROMANCHE_WSL_HINT_MS: "300" });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`${HINT} on port ${expected.port}`), WAIT);
      expect(s.stderr()).toContain(`Test-NetConnection 127.0.0.1 -Port ${expected.port}`);
      expect(s.stderr()).toContain(`must be exactly "${TZ}"`);
    } finally {
      await s.close();
    }
  }, 20_000);

  it("stays quiet when the extension connects before the deadline", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: "win" });
    const s = await spawnServer(expected.port, { WSL_DISTRO_NAME: "Ubuntu-Test", CHROMANCHE_WSL_HINT_MS: "1000" });
    try {
      const ws = await connectExtension(expected.port, expected.token, "win-chrome");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["win-chrome"]), WAIT);
        // Disconnecting afterwards must not resurrect the hint: forwarding worked.
        ws.close();
        await sleep(1500);
        expect(s.stderr()).not.toContain(HINT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
    }
  }, 20_000);

  it("CHROMANCHE_BROWSER_PLATFORM=linux keeps Chromium-inside-WSL working: Linux pairing, no Windows hint", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: "linux" });
    const s = await spawnServer(expected.port, {
      WSL_DISTRO_NAME: "Ubuntu-Test",
      CHROMANCHE_BROWSER_PLATFORM: "linux",
      CHROMANCHE_WSL_HINT_MS: "300",
    });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${expected.port}`), WAIT);
      expect(s.stderr()).toContain("platform=linux (from CHROMANCHE_BROWSER_PLATFORM)");
      const ws = await connectExtension(expected.port, expected.token, "wslg-chromium");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["wslg-chromium"]), WAIT);
      } finally {
        ws.close();
      }
      await sleep(800);
      expect(s.stderr()).not.toContain(HINT);
    } finally {
      await s.close();
    }
  }, 20_000);
});

describe("pairing on any host", () => {
  it("CHROMANCHE_BROWSER_PLATFORM overrides the derived pairing end-to-end", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: "cros" });
    const s = await spawnServer(expected.port, { CHROMANCHE_BROWSER_PLATFORM: "cros" });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${expected.port}`), WAIT);
      expect(s.stderr()).toContain(`pairing inputs: timezone=${TZ} platform=cros (from CHROMANCHE_BROWSER_PLATFORM)`);
      expect(readFileSync(join(s.home, ".chromanche", "token"), "utf8")).toBe(expected.token);
      const ws = await connectExtension(expected.port, expected.token, "chromebook");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["chromebook"]), WAIT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
    }
  }, 20_000);

  // On a real WSL dev box the kernel string marks us as WSL even with a clean env.
  it.runIf(!isWsl())("without WSL markers the server pairs with its own OS and never hints", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: process.platform });
    const s = await spawnServer(expected.port, { CHROMANCHE_WSL_HINT_MS: "300" });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${expected.port}`), WAIT);
      expect(s.stderr()).not.toContain("WSL detected");
      await sleep(800);
      expect(s.stderr()).not.toContain(HINT);
    } finally {
      await s.close();
    }
  }, 20_000);

  it("an unknown CHROMANCHE_BROWSER_PLATFORM is fatal at startup with a clear message", () => {
    const home = mkdtempSync(join(tmpdir(), "chromanche-pairing-home-"));
    try {
      const r = spawnSync(process.execPath, [entry], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TZ, CHROMANCHE_BROWSER_PLATFORM: "beos" },
        encoding: "utf8",
        input: "",
        timeout: 10_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("CHROMANCHE_BROWSER_PLATFORM must be one of win, mac, linux, cros (got: beos)");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

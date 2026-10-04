import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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
import { WSL_PORT, WSL_TOKEN_RE, isWsl } from "../src/wsl.js";

/**
 * Spawns the real MCP server binary (built from the current sources, so a
 * stale dist/ can't mask a regression) the way an MCP client does, with a
 * minimal, explicit environment, then plays the extension over the real
 * WebSocket with the credentials a user would use.
 *
 * WSL is simulated with WSL_DISTRO_NAME, which only takes effect on Linux
 * (isWsl() short-circuits elsewhere), so the WSL cases run in CI (Ubuntu)
 * and are skipped on macOS dev machines.
 *
 * TZ is pinned to an exotic zone so derived ports can never collide with a
 * live Chromanche instance on the developer's machine.
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

const newHome = () => mkdtempSync(join(tmpdir(), "chromanche-pairing-home-"));
const tokenFile = (home: string) => join(home, ".chromanche", "token");

interface Spawned {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

async function spawnServer(port: number, home: string, extraEnv: Record<string, string> = {}): Promise<Spawned> {
  await waitPortFree(port);
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
    stderr: () => buf,
    close: async () => {
      await client.close();
      // The SDK's close() doesn't wait for the child to exit; the next test
      // may reuse this port, so wait until the server has really let go.
      await waitPortFree(port);
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
const WSL_ENV = { WSL_DISTRO_NAME: "Ubuntu-Test" };

describe.runIf(process.platform === "linux")("pairing under WSL (simulated on Linux)", () => {
  it("listens on the fixed port with a random token; pasting it into the extension pairs", async () => {
    const home = newHome();
    const s = await spawnServer(WSL_PORT, home, WSL_ENV);
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${WSL_PORT}.`), WAIT);
      expect(s.stderr()).toContain(`(wsl; file: ${tokenFile(home)})`);
      expect(s.stderr()).toContain(`[chromanche] open the Chromanche extension popup in Chrome, expand "Advanced — override pairing", set Port to ${WSL_PORT}`);
      const token = readFileSync(tokenFile(home), "utf8");
      expect(token).toMatch(WSL_TOKEN_RE);
      expect(statSync(tokenFile(home)).mode & 0o777).toBe(0o600);

      // What the user does in the popup: port + token from ~/.chromanche/token.
      const ws = await connectExtension(WSL_PORT, token, "win-chrome");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["win-chrome"]), WAIT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects the timezone-derived token a not-yet-paired extension would send", async () => {
    const home = newHome();
    const s = await spawnServer(WSL_PORT, home, WSL_ENV);
    try {
      const derived = await derivePairing({ timezone: TZ, platform: "win" });
      const ws = await connectExtension(WSL_PORT, derived.token, "unpaired");
      const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
      expect(code).toBe(4003);
      expect(await listProfileTags(s.client)).toEqual([]);
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps the same token across restarts, so the popup never has to be re-paired", async () => {
    const home = newHome();
    try {
      const first = await spawnServer(WSL_PORT, home, WSL_ENV);
      const token = readFileSync(tokenFile(home), "utf8");
      await first.close();

      const second = await spawnServer(WSL_PORT, home, WSL_ENV);
      try {
        expect(readFileSync(tokenFile(home), "utf8")).toBe(token);
        const ws = await connectExtension(WSL_PORT, token, "win-chrome");
        try {
          await vi.waitFor(async () => expect(await listProfileTags(second.client)).toEqual(["win-chrome"]), WAIT);
        } finally {
          ws.close();
        }
      } finally {
        await second.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("replaces a legacy derived token file from an earlier version", async () => {
    const home = newHome();
    mkdirSync(join(home, ".chromanche"), { recursive: true });
    writeFileSync(tokenFile(home), "2fe10176".repeat(8));
    const s = await spawnServer(WSL_PORT, home, WSL_ENV);
    try {
      expect(readFileSync(tokenFile(home), "utf8")).toMatch(WSL_TOKEN_RE);
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("while nothing is connected, tool calls return the pairing steps (but never the token)", async () => {
    const home = newHome();
    const s = await spawnServer(WSL_PORT, home, WSL_ENV);
    try {
      const token = readFileSync(tokenFile(home), "utf8");
      let message = "";
      try {
        const r = await s.client.callTool({ name: "tabs_list", arguments: {} });
        message = JSON.stringify(r);
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("no extension connected");
      expect(message).toContain(`set Port to ${WSL_PORT}`);
      expect(message).toContain(`cat ${tokenFile(home)}`);
      expect(message).not.toContain(token);
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("CHROMANCHE_PORT / CHROMANCHE_TOKEN still override under WSL", async () => {
    const home = newHome();
    const port = WSL_PORT + 1;
    const s = await spawnServer(port, home, { ...WSL_ENV, CHROMANCHE_PORT: String(port), CHROMANCHE_TOKEN: "explicit-token-123" });
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${port}.`), WAIT);
      expect(s.stderr()).toContain("(explicit; file:");
      expect(s.stderr()).toContain(`set Port to ${port}`);
      const ws = await connectExtension(port, "explicit-token-123", "env-paired");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["env-paired"]), WAIT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

// On a real WSL dev box the kernel string marks us as WSL even with a clean env.
describe.runIf(!isWsl())("pairing outside WSL stays automatic", () => {
  it("derives port + token from timezone + platform, exactly what the extension computes", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: process.platform });
    const home = newHome();
    const s = await spawnServer(expected.port, home);
    try {
      await vi.waitFor(() => expect(s.stderr()).toContain(`leader on ws://127.0.0.1:${expected.port}.`), WAIT);
      expect(s.stderr()).toContain("(derived; file:");
      expect(s.stderr()).not.toContain("paired by hand");
      expect(readFileSync(tokenFile(home), "utf8")).toBe(expected.token);
      const ws = await connectExtension(expected.port, expected.token, "auto-paired");
      try {
        await vi.waitFor(async () => expect(await listProfileTags(s.client)).toEqual(["auto-paired"]), WAIT);
      } finally {
        ws.close();
      }
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("a tool call with no extension gives the plain error, without WSL steps", async () => {
    const expected = await derivePairing({ timezone: TZ, platform: process.platform });
    const home = newHome();
    const s = await spawnServer(expected.port, home);
    try {
      let message = "";
      try {
        message = JSON.stringify(await s.client.callTool({ name: "tabs_list", arguments: {} }));
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("no extension connected");
      expect(message).not.toContain("Advanced");
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

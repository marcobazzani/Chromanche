import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BridgeServer } from "./bridge.js";
import { buildTools } from "./tools.js";
import { loadConfig, type Config } from "./config.js";
import { runProxy } from "./proxy.js";
import { WebSocketServerTransport } from "./ws-transport.js";

/** Build a fresh MCP Server wired to our tool set. One per stdio or proxy session. */
function buildMcpServer(bridge: BridgeServer, cfg: Config): Server {
  const tools = buildTools(bridge, { notConnectedHelp: cfg.pairingHelp });
  const server = new Server(
    { name: "chromanche", version: "0.13.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[req.params.name];
    if (!t) throw new Error(`unknown tool ${req.params.name}`);
    type P = Parameters<NonNullable<typeof t>["handler"]>[0];
    return (t.handler as (p: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>)(
      (req.params.arguments ?? {}) as P
    );
  });
  return server;
}

/** Leader role: bind the port, host extensions + proxies, speak stdio MCP to parent Claude Code. */
async function runLeader(cfg: Config): Promise<void> {
  const bridge = new BridgeServer({ token: cfg.token, timeoutMs: cfg.timeoutMs });
  await bridge.listen(cfg.port);
  console.error(
    `[chromanche] leader on ws://127.0.0.1:${cfg.port}. Token: ${cfg.token.slice(0, 8)}... (${cfg.pairingMode}; file: ${cfg.tokenFile})`,
  );
  if (cfg.pairingHelp) {
    for (const line of cfg.pairingHelp.split("\n")) console.error(`[chromanche] ${line}`);
  }

  // Accept follower Claude Code sessions via WS proxy handshake.
  bridge.setProxyHandler((ws) => {
    const server = buildMcpServer(bridge, cfg);
    const transport = new WebSocketServerTransport(ws);
    server.connect(transport).catch((err) =>
      console.error("[chromanche] proxy server connect error:", err),
    );
    console.error("[chromanche] accepted a follower MCP proxy connection.");
  });

  // Host this session's own stdio MCP as usual.
  const server = buildMcpServer(bridge, cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    bridge.close().catch((err) => console.error("[chromanche] close error:", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  const flags = new Set(process.argv.slice(2));

  // Explicit proxy mode: never bind, just join whoever's the leader.
  if (flags.has("--proxy")) {
    await runProxy(cfg);
    return;
  }

  // Default: try to become leader. On EADDRINUSE fall through to proxy.
  try {
    await runLeader(cfg);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      console.error(
        `[chromanche] port ${cfg.port} already in use — another Claude Code session is the leader. Joining as proxy.`,
      );
      await runProxy(cfg);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("[chromanche] fatal:", err);
  process.exit(1);
});

import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientHelloSchema,
  ProxyHelloSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcResponse,
  type ProfileInfo,
} from "@chromanche/shared";

export type ProxyHandler = (ws: WebSocket) => void;

export interface Correlator {
  register<T = unknown>(id: number): Promise<T>;
  resolve(resp: RpcResponse): void;
  rejectAll(err: Error): void;
}

export function createCorrelator(opts: { timeoutMs: number }): Correlator {
  const pending = new Map<
    number | string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  return {
    register<T>(id: number) {
      return new Promise<T>((resolve, reject) => {
        const prev = pending.get(id);
        if (prev) {
          clearTimeout(prev.timer);
          prev.reject(new Error(`id ${id} reused before previous request resolved`));
          pending.delete(id);
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request ${id} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      });
    },
    resolve(resp: RpcResponse) {
      const entry = pending.get(resp.id);
      if (!entry) return; // unknown id → drop silently
      clearTimeout(entry.timer);
      pending.delete(resp.id);
      if (resp.error) entry.reject(new Error(resp.error.message));
      else entry.resolve(resp.result);
    },
    rejectAll(err: Error) {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    },
  };
}

interface ExtensionEntry {
  ws: WebSocket;
  label: string;
  connectedAt: number;
  corr: Correlator;
  nextId: number;
}

const DEFAULT_PROFILE = "default";

export class BridgeServer {
  private wss?: WebSocketServer;
  // Map of profile tag → extension entry. Anonymous connections (no profile)
  // are stored under "default" so legacy (v0.5.x) extensions keep working.
  private extensions = new Map<string, ExtensionEntry>();
  private token: string;
  private timeoutMs: number;
  private proxyHandler?: ProxyHandler;

  constructor(opts: { token: string; timeoutMs: number }) {
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Register a callback invoked whenever a follower Claude Code session's MCP
   * proxy authenticates. The caller is expected to adopt the socket and run an
   * MCP Server on it (see WebSocketServerTransport). If no handler is set,
   * proxy connections are rejected.
   */
  setProxyHandler(handler: ProxyHandler): void {
    this.proxyHandler = handler;
  }

  async listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port });
      const onStartupError = (err: Error) => reject(err);
      this.wss.once("listening", () => {
        this.wss!.off("error", onStartupError);
        const addr = this.wss!.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("failed to bind"));
      });
      this.wss.on("connection", (ws) => this.onConnection(ws));
      this.wss.once("error", onStartupError);
      this.wss.on("error", (err) => {
        console.error("[chromanche] wss error:", err);
      });
    });
  }

  private onConnection(ws: WebSocket) {
    let authed = false;
    let profile: string | undefined;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, "auth timeout");
    }, 3000);

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, "bad json");
        return;
      }
      if (!authed) {
        // Try proxy-hello first: follower Claude Code sessions use this to
        // adopt their MCP stdio onto this hub's tool registry.
        const proxy = ProxyHelloSchema.safeParse(parsed);
        if (proxy.success) {
          const expected = Buffer.from(this.token, "utf8");
          const actual = Buffer.from(proxy.data.token, "utf8");
          const match =
            expected.length === actual.length && timingSafeEqual(expected, actual);
          if (!match) {
            ws.close(4003, "bad token");
            return;
          }
          if (!this.proxyHandler) {
            ws.close(4011, "proxy not supported on this hub");
            return;
          }
          clearTimeout(authTimer);
          authed = true;
          // Remove our message listeners — ownership transfers to proxy handler.
          ws.removeAllListeners("message");
          ws.removeAllListeners("close");
          this.proxyHandler(ws);
          return;
        }
        const hello = ClientHelloSchema.safeParse(parsed);
        if (!hello.success) {
          ws.close(4003, "bad token");
          return;
        }
        const expected = Buffer.from(this.token, "utf8");
        const actual = Buffer.from(hello.data.token, "utf8");
        const match =
          expected.length === actual.length && timingSafeEqual(expected, actual);
        if (!match) {
          ws.close(4003, "bad token");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        profile = hello.data.profile ?? DEFAULT_PROFILE;
        const label = hello.data.label ?? profile.slice(0, 12);
        // If a prior connection held this tag, evict it cleanly (takeover).
        const prev = this.extensions.get(profile);
        if (prev) {
          prev.corr.rejectAll(new Error("replaced by new connection"));
          try { prev.ws.close(4010, "replaced"); } catch { /* ignore */ }
        }
        const entry: ExtensionEntry = {
          ws,
          label,
          connectedAt: Date.now(),
          corr: createCorrelator({ timeoutMs: this.timeoutMs }),
          nextId: 1,
        };
        this.extensions.set(profile, entry);
        return;
      }
      // Keepalive frame from the extension — ignore. Receiving any frame resets
      // Chrome's SW idle timer on the extension side.
      if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "ping") {
        return;
      }
      // After auth: incoming frames are responses to our requests.
      const resp = RpcResponseSchema.safeParse(parsed);
      if (!resp.success || !profile) return;
      const entry = this.extensions.get(profile);
      if (entry && entry.ws === ws) entry.corr.resolve(resp.data);
    });

    ws.on("close", () => {
      if (profile === undefined) return;
      const entry = this.extensions.get(profile);
      if (entry && entry.ws === ws) {
        entry.corr.rejectAll(new Error("extension disconnected"));
        this.extensions.delete(profile);
      }
    });
  }

  /**
   * Send a JSON-RPC request to one of the connected extensions.
   *
   * Routing:
   *   - 0 extensions connected → throws "no extension connected"
   *   - 1 connected and no profile passed → auto-route
   *   - N connected and no profile passed → throws structured error listing profiles
   *   - profile passed and not connected → throws "profile X not connected"
   */
  async call<T = unknown>(method: string, params: unknown, profile?: string): Promise<T> {
    if (this.extensions.size === 0) {
      throw new Error("no extension connected");
    }
    let entry: ExtensionEntry | undefined;
    let tag: string | undefined;
    if (profile !== undefined) {
      entry = this.extensions.get(profile);
      if (!entry) {
        const available = [...this.extensions.keys()].join(", ") || "(none)";
        throw new Error(
          `profile "${profile}" is not connected. Connected profiles: ${available}`,
        );
      }
      tag = profile;
    } else if (this.extensions.size === 1) {
      const [first] = this.extensions.entries();
      [tag, entry] = first!;
    } else {
      const available = this.listProfiles()
        .map((p) => `${p.tag} (${p.label})`)
        .join(", ");
      throw new Error(
        `multiple profiles connected: ${available}. Call chromanche_list_profiles then pass profile="<tag>" to target one.`,
      );
    }
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`extension connection for profile "${tag}" is not open`);
    }
    const id = entry.nextId++;
    const req = { jsonrpc: "2.0" as const, id, method, params };
    RpcRequestSchema.parse(req);
    entry.ws.send(JSON.stringify(req));
    return entry.corr.register<T>(id);
  }

  isConnected(): boolean {
    for (const e of this.extensions.values()) {
      if (e.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  listProfiles(): ProfileInfo[] {
    const out: ProfileInfo[] = [];
    for (const [tag, e] of this.extensions) {
      if (e.ws.readyState === WebSocket.OPEN) {
        out.push({ tag, label: e.label, connectedAt: e.connectedAt });
      }
    }
    return out.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  async close(): Promise<void> {
    for (const e of this.extensions.values()) {
      e.corr.rejectAll(new Error("bridge closing"));
      try { e.ws.close(); } catch { /* ignore */ }
    }
    this.extensions.clear();
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = undefined;
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

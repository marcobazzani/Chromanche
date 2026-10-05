import type { Dispatcher } from "./dispatcher.js";
import { RpcRequestSchema } from "@chromanche/shared";

export function nextBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 30_000);
}

export interface WsClientOptions {
  url: string | (() => Promise<string>);
  getToken: () => Promise<string | null>;
  /** Optional — returns the profile tag + human label to send in the hello frame. */
  getIdentity?: () => Promise<{ profile: string; label: string } | null>;
  onStatus: (status: "connecting" | "open" | "authed" | "closed" | "badToken") => void;
}

/**
 * Single-connection WebSocket client with reconnect.
 *
 * Invariant: at most ONE connection attempt / reconnect loop is alive. The
 * service worker calls start() several times during startup (module load,
 * runtime.onInstalled / onStartup, a pairing change in storage) while
 * connect() is async; without single-flighting, parallel loops would each
 * schedule reconnects and periodically close the live socket — dropping
 * in-flight tool calls with "extension disconnected".
 */
export class WsClient {
  private ws?: WebSocket;
  private attempt = 0;
  private closedByUs = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pendingIdentity: { profile: string; label: string } | null = null;
  /** Bumped by every connect()/stop(); an in-flight connect() whose generation is stale aborts. */
  private generation = 0;
  /** True while connect() is between its first await and creating the socket. */
  private connecting = false;

  constructor(private opts: WsClientOptions, private dispatcher: Dispatcher) {}

  /**
   * Connect unless a connection is already open or being established.
   * After stop() (closedByUs) it always reconnects — that's how pairing
   * changes take effect.
   */
  start() {
    this.clearReconnectTimer();
    if (!this.closedByUs && (this.connecting || this.socketAlive())) return;
    this.closedByUs = false;
    void this.connect();
  }

  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
    }
  }

  stop() {
    this.closedByUs = true;
    this.clearReconnectTimer();
    this.generation++; // abort any in-flight connect()
    this.connecting = false;
    // Disown BEFORE closing: the close event arrives asynchronously — after a
    // following start() may already have reset closedByUs — and must not be
    // mistaken for a drop of the active socket (that would spawn a stray
    // reconnect loop).
    const ws = this.ws;
    this.ws = undefined;
    try { ws?.close(); } catch { /* ignore */ }
  }

  private socketAlive(): boolean {
    return !!this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    const delay = nextBackoffMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private async connect() {
    const gen = ++this.generation;
    this.connecting = true;
    try {
      const token = await this.opts.getToken();
      if (gen !== this.generation) return;
      if (!token) {
        this.opts.onStatus("badToken");
        return;
      }
      const identity = this.opts.getIdentity
        ? await this.opts.getIdentity().catch(() => null)
        : null;
      if (gen !== this.generation) return;
      this.pendingIdentity = identity;
      const url = typeof this.opts.url === "function" ? await this.opts.url() : this.opts.url;
      if (gen !== this.generation) return;
      // A lingering socket from an older generation: disown, then close, so
      // its close handler sees this.ws !== ws and skips reconnect-scheduling.
      if (this.ws) {
        const stale = this.ws;
        this.ws = undefined;
        try { stale.close(); } catch { /* ignore */ }
      }
      this.opts.onStatus("connecting");
      const ws = new WebSocket(url);
      this.ws = ws;
      this.attach(ws, token);
    } finally {
      if (gen === this.generation) this.connecting = false;
    }
  }

  private attach(ws: WebSocket, token: string) {
    // All listeners capture `ws` locally so a late event from a stale socket
    // can't act on the replacement socket.
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return; // stale socket — ignore
      if (ws.readyState !== WebSocket.OPEN) return;
      this.opts.onStatus("open");
      const hello: { type: "hello"; token: string; profile?: string; label?: string } = {
        type: "hello",
        token,
      };
      if (this.pendingIdentity) {
        hello.profile = this.pendingIdentity.profile;
        hello.label = this.pendingIdentity.label;
      }
      try {
        ws.send(JSON.stringify(hello));
      } catch {
        // racing close → let the close handler drive reconnect
        return;
      }
      this.opts.onStatus("authed");
      this.attempt = 0;
    });
    ws.addEventListener("message", async (ev) => {
      if (this.ws !== ws) return;
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data as string); } catch { return; }
      const req = RpcRequestSchema.safeParse(parsed);
      if (!req.success) return;
      const resp = await this.dispatcher.handle(req.data);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(resp)); } catch { /* ignore */ }
      }
    });
    ws.addEventListener("close", (ev) => {
      // Only the active socket's close drives reconnect.
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.opts.onStatus(ev.code === 4003 ? "badToken" : "closed");
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => { /* swallow; close will follow */ });
  }
}

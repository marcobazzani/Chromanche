import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BridgeServer } from "../src/bridge.js";

describe("BridgeServer integration", () => {
  let server: BridgeServer;
  let port: number;

  beforeEach(async () => {
    server = new BridgeServer({ token: "secret-token", timeoutMs: 1000 });
    port = await server.listen(0); // 0 = random free port
  });

  afterEach(async () => {
    await server.close();
  });

  it("rejects a client that sends wrong token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "WRONG" }));
    await new Promise<void>((r) => ws.once("close", () => r()));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("accepts auth and round-trips a method call", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "secret-token" }));

    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method === "tabs.list") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
      }
    });

    await vi.waitFor(() => {
      if (!server.isConnected()) throw new Error("not authed yet");
    });
    const result = await server.call("tabs.list", {});
    expect(result).toEqual([]);
    ws.close();
  });

  it("errors when no extension is connected", async () => {
    await expect(server.call("tabs.list", {})).rejects.toThrow(/no extension connected/i);
  });

  it("routes calls to the correct profile when multiple extensions are connected", async () => {
    // Two "extensions" with distinct profile tags.
    const wsA = new WebSocket(`ws://127.0.0.1:${port}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([
      new Promise<void>((r) => wsA.once("open", () => r())),
      new Promise<void>((r) => wsB.once("open", () => r())),
    ]);
    wsA.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "work", label: "Work" }));
    wsB.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "personal", label: "Personal" }));

    wsA.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method) wsA.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { from: "A" } }));
    });
    wsB.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method) wsB.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { from: "B" } }));
    });

    await vi.waitFor(() => {
      if (server.listProfiles().length < 2) throw new Error("not both authed yet");
    });

    expect(server.listProfiles().map((p) => p.tag).sort()).toEqual(["personal", "work"]);

    const resA = await server.call("tabs.list", {}, "work");
    const resB = await server.call("tabs.list", {}, "personal");
    expect(resA).toEqual({ from: "A" });
    expect(resB).toEqual({ from: "B" });

    // Ambiguous call with no profile should throw a structured message.
    await expect(server.call("tabs.list", {})).rejects.toThrow(/multiple profiles connected/i);

    wsA.close(); wsB.close();
  });

  it("anonymous hello (no profile field) uses 'default' tag — backwards compat", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "secret-token" }));  // no profile
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method) ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    });
    await vi.waitFor(() => { if (!server.isConnected()) throw new Error("not authed"); });
    expect(server.listProfiles()[0]!.tag).toBe("default");
    const r = await server.call("tabs.list", {});
    expect(r).toEqual({ ok: true });
    ws.close();
  });

  it("evicts prior connection with the same profile tag (takeover)", async () => {
    const wsA = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => wsA.once("open", () => r()));
    wsA.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "work" }));
    await vi.waitFor(() => { if (!server.isConnected()) throw new Error("A not authed"); });

    const wsB = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => wsB.once("open", () => r()));
    wsB.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "work" }));

    // A should get its socket closed by the server (close code 4010 = "replaced").
    await new Promise<void>((r) => wsA.once("close", () => r()));
    expect(wsA.readyState).toBe(WebSocket.CLOSED);

    // B is now the authoritative "work" connection.
    wsB.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method) wsB.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { from: "B" } }));
    });
    await vi.waitFor(() => { if (!server.isConnected()) throw new Error("B not authed"); });
    const r = await server.call("tabs.list", {}, "work");
    expect(r).toEqual({ from: "B" });
    wsB.close();
  });

  it("accepts an mcp-proxy-hello and hands off to the registered handler", async () => {
    const handoff = vi.fn();
    server.setProxyHandler((ws) => handoff(ws));

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "mcp-proxy-hello", token: "secret-token" }));

    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1));
    const [receivedWs] = handoff.mock.calls[0]!;
    expect(receivedWs.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("closes an mcp-proxy-hello with wrong token (4003)", async () => {
    server.setProxyHandler(() => { /* would be invoked on success */ });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "mcp-proxy-hello", token: "WRONG" }));
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(4003);
  });

  it("closes an mcp-proxy-hello (4011) when no handler is registered", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "mcp-proxy-hello", token: "secret-token" }));
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(4011);
  });

  it("after proxy handoff the socket is not in the extensions map", async () => {
    let handedOffWs: WebSocket | undefined;
    server.setProxyHandler((ws) => { handedOffWs = ws as unknown as WebSocket; });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "mcp-proxy-hello", token: "secret-token" }));
    await vi.waitFor(() => expect(handedOffWs).toBeDefined());

    expect(server.listProfiles()).toEqual([]);
    expect(server.isConnected()).toBe(false);
    ws.close();
  });

  it("regular extension hello still works after a failed proxy hello on a different socket", async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => bad.once("open", () => r()));
    bad.send(JSON.stringify({ type: "mcp-proxy-hello", token: "WRONG" }));
    await new Promise<void>((r) => bad.once("close", () => r()));

    const good = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => good.once("open", () => r()));
    good.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "work" }));
    good.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method) good.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    });
    await vi.waitFor(() => { if (!server.isConnected()) throw new Error("not authed"); });
    const r = await server.call("tabs.list", {}, "work");
    expect(r).toEqual({ ok: true });
    good.close();
  });

  it("ignores {type:'ping'} frames after auth without breaking pending calls", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "secret-token" }));
    await vi.waitFor(() => { if (!server.isConnected()) throw new Error("not authed"); });

    // Fire a ping BEFORE the call — must not affect the pending RPC.
    ws.send(JSON.stringify({ type: "ping" }));

    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method === "tabs.list") {
        // Another ping in the middle of handling — server must ignore.
        ws.send(JSON.stringify({ type: "ping" }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
      }
    });

    const result = await server.call("tabs.list", {});
    expect(result).toEqual([]);
    ws.close();
  });
});

import type { Dispatcher } from "../dispatcher.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { resolveTabId } from "../lib/active-tab.js";
import { resolveFrame } from "../lib/focus.js";
import {
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
  NetworkGetRequestParamsSchema,
  PageFetchParamsSchema,
} from "@chromanche/shared";

type RuntimeEvaluateResult = {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
};

type FetchBridgeResult = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  json: boolean;
  truncated: boolean;
  finalUrl: string;
  _error?: string;
};

export function registerDebugHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.evalJs", async (raw) => {
    const p = PageEvalJsParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    // frame: "top" (default) | "focused" | URL regex — reach into cross-origin iframes.
    const fr = await resolveFrame(mgr, tabId, p.frame);
    const r = await mgr.sendCommand<RuntimeEvaluateResult>(tabId, "Runtime.evaluate", {
      expression: p.expression,
      awaitPromise: p.awaitPromise,
      returnByValue: p.returnByValue,
      timeout: p.timeoutMs,
    }, fr.targetId);
    const frame = fr.frame ? { frame: fr.frame } : {};
    if (r.exceptionDetails) {
      // exceptionDetails.text is often just "Uncaught"; the description has the message.
      const detail = r.exceptionDetails.exception?.description;
      return { type: "exception", exception: detail ? `${r.exceptionDetails.text}: ${detail}` : r.exceptionDetails.text, ...frame };
    }
    return {
      type: r.result.type,
      value: r.result.value,
      description: r.result.description,
      ...frame,
    };
  });

  d.register("console.read", async (raw) => {
    const p = ConsoleReadParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    await mgr.attach(tabId);
    return mgr.readConsole(tabId, p.pattern, p.since, p.limit);
  });

  d.register("network.read", async (raw) => {
    const p = NetworkReadParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    await mgr.attach(tabId);
    return mgr.readNetwork(tabId, p.pattern, p.since, p.limit);
  });

  d.register("network.getRequest", async (raw) => {
    const p = NetworkGetRequestParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    await mgr.attach(tabId);
    return mgr.getRequestDetail(tabId, p.urlPattern, p.maxBytes);
  });

  d.register("page.fetch", async (raw) => {
    const p = PageFetchParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);

    // Compose the in-page fetch wrapper. We stringify the params as JSON and
    // interpolate into an async IIFE that runs in the page's execution context
    // (so cookies, CSRF tokens, and same-origin policy all work naturally).
    // We use AbortController for a per-call timeout independent of CDP's.
    const bodyStr =
      typeof p.body === "string" ? p.body :
      p.body === undefined ? undefined :
      JSON.stringify(p.body);
    const cfg = {
      url: p.url,
      method: p.method,
      headers: p.headers ?? {},
      body: bodyStr,
      credentials: p.credentials,
      timeoutMs: p.timeoutMs,
      maxBytes: p.maxBytes,
    };
    const expression = `(async () => {
      const cfg = ${JSON.stringify(cfg)};
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const init = {
          method: cfg.method,
          headers: cfg.headers,
          credentials: cfg.credentials,
          signal: ctrl.signal,
        };
        if (cfg.body !== undefined && cfg.body !== null) init.body = cfg.body;
        const r = await fetch(cfg.url, init);
        const text = await r.text();
        const truncated = text.length > cfg.maxBytes;
        const out = truncated ? text.slice(0, cfg.maxBytes) : text;
        const headers = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        let body = out;
        let json = false;
        if (ct.includes('json') || ct.includes('+json')) {
          try { body = JSON.parse(out); json = true; } catch (e) { /* keep raw */ }
        }
        return {
          ok: r.ok, status: r.status, statusText: r.statusText,
          headers, body, json, truncated, finalUrl: r.url,
        };
      } catch (e) {
        return {
          ok: false, status: 0, statusText: '',
          headers: {}, body: null, json: false, truncated: false, finalUrl: cfg.url,
          _error: (e && e.message) ? String(e.message) : String(e),
        };
      } finally {
        clearTimeout(tid);
      }
    })()`;

    const r = await mgr.sendCommand<RuntimeEvaluateResult>(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: p.timeoutMs + 2000,
    });
    if (r.exceptionDetails) {
      throw new Error(`page.fetch threw in page context: ${r.exceptionDetails.text}`);
    }
    const val = r.result.value as FetchBridgeResult | undefined;
    if (!val) {
      throw new Error("page.fetch returned no value");
    }
    if (val._error) {
      throw new Error(`page.fetch failed: ${val._error}`);
    }
    // Strip internal error field from the response shape.
    const { _error: _ignored, ...clean } = val;
    return clean;
  });
}

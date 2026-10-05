import { describe, expect, it } from "vitest";
import {
  ClientHelloSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  TabsListResultSchema,
  TabsCreateParamsSchema,
  PageNavigateParamsSchema,
  PageSnapshotParamsSchema,
  PageScreenshotParamsSchema,
  PageScreenshotResultSchema,
  SessionClaimResultSchema,
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PagePasteParamsSchema,
  PageWaitParamsSchema,
  PageWaitForDownloadParamsSchema,
  PageHoverParamsSchema,
  PageFocusParamsSchema,
  PageFocusResultSchema,
  PageClickXyParamsSchema,
  PagePressKeyParamsSchema,
  PageFocusStateParamsSchema,
  PageFocusStateResultSchema,
  PageFillFormParamsSchema,
  PageHandleDialogParamsSchema,
  PageSelectParamsSchema,
  PageUploadFileParamsSchema,
  PageDragParamsSchema,
  PageFetchParamsSchema,
  PageEvalJsParamsSchema,
  PageEvalJsResultSchema,
  PageClickXyResultSchema,
  PagePasteResultSchema,
  PageTypeResultSchema,
  PagePressKeyResultSchema,
  FocusSummarySchema,
  ConsoleReadParamsSchema,
  ConsoleReadResultSchema,
  NetworkReadParamsSchema,
  NetworkReadResultSchema,
  NetworkGetRequestParamsSchema,
} from "../src/protocol.js";

describe("protocol round-trip", () => {
  it("validates client hello", () => {
    const msg = { type: "hello" as const, token: "abc12345" };
    expect(ClientHelloSchema.parse(msg)).toEqual(msg);
  });

  it("validates tabs.list request with no params", () => {
    const req = { jsonrpc: "2.0" as const, id: 1, method: "tabs.list" };
    expect(RpcRequestSchema.parse(req)).toEqual(req);
  });

  it("validates tabs.list result", () => {
    const result = [{ tabId: 17, url: "https://example.com", title: "Example", active: true }];
    expect(TabsListResultSchema.parse(result)).toEqual(result);
  });

  it("validates tabs.create params", () => {
    const params = { url: "https://example.com", active: true };
    expect(TabsCreateParamsSchema.parse(params)).toEqual(params);
  });

  it("rejects tabs.create with non-http(s) url", () => {
    expect(() =>
      TabsCreateParamsSchema.parse({ url: "javascript:alert(1)" })
    ).toThrow();
  });

  it("validates page.navigate params with default waitUntil", () => {
    const parsed = PageNavigateParamsSchema.parse({ tabId: 1, url: "https://example.com" });
    expect(parsed.waitUntil).toBe("load");
  });

  it("validates session.claim result", () => {
    const result = { ok: true as const, groupId: 42 };
    expect(SessionClaimResultSchema.parse(result)).toEqual(result);
  });

  it("rpc response with error excludes result", () => {
    const err = {
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };
    expect(RpcResponseSchema.parse(err)).toEqual(err);
  });

  it("rejects rpc response with both result and error", () => {
    expect(() =>
      RpcResponseSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        result: { anything: true },
        error: { code: -32000, message: "nope" },
      })
    ).toThrow();
  });

  it("rejects rpc response with neither result nor error", () => {
    expect(() =>
      RpcResponseSchema.parse({ jsonrpc: "2.0", id: 1 })
    ).toThrow();
  });

  it("rejects tabs.create params with unknown fields (strict)", () => {
    expect(() =>
      TabsCreateParamsSchema.parse({ url: "https://example.com", bogus: true })
    ).toThrow();
  });

  it("page.snapshot params default mode=a11y and maxBytes=80000", () => {
    const parsed = PageSnapshotParamsSchema.parse({ tabId: 1 });
    expect(parsed.mode).toBe("a11y");
    expect(parsed.maxBytes).toBe(80_000);
    expect(parsed.includeBounds).toBe(false);
    expect(parsed.since).toBe("full");
  });
  it("page.snapshot params accept since=last", () => {
    expect(PageSnapshotParamsSchema.parse({ tabId: 1, since: "last" }).since).toBe("last");
  });

  it("page.snapshot params accept no tabId (active-tab fallback)", () => {
    const parsed = PageSnapshotParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });

  it("page.screenshot params default format=jpeg and quality=60", () => {
    const parsed = PageScreenshotParamsSchema.parse({ tabId: 1 });
    expect(parsed.format).toBe("jpeg");
    expect(parsed.quality).toBe(60);
  });

  it("page.screenshot params accept no tabId (active-tab fallback)", () => {
    const parsed = PageScreenshotParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });

  it("page.screenshot result accepts viewport metadata", () => {
    const parsed = PageScreenshotResultSchema.parse({
      format: "jpeg",
      base64: "AAAA",
      viewport: { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 10, scrollY: 20 },
    });
    expect(parsed.viewport?.width).toBe(1280);
  });

  // --- click: uid OR selector ---
  it("page.click accepts uid", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, uid: "e42" });
    expect(p.uid).toBe("e42");
    expect(p.selector).toBeUndefined();
  });
  it("page.click accepts selector", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, selector: "#go" });
    expect(p.selector).toBe("#go");
  });
  it("page.click rejects when neither uid nor selector", () => {
    expect(() => PageClickParamsSchema.parse({ tabId: 1 })).toThrow();
  });
  it("page.click defaults button=left, scrollIntoView=true, includeSnapshot=false", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, uid: "e1" });
    expect(p.button).toBe("left");
    expect(p.scrollIntoView).toBe(true);
    expect(p.includeSnapshot).toBe(false);
  });

  // --- type: uid OR selector ---
  it("page.type accepts uid", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, uid: "e5", text: "hello" });
    expect(p.uid).toBe("e5");
  });
  it("page.type accepts selector", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, selector: "#q", text: "hi" });
    expect(p.selector).toBe("#q");
  });
  // No-target typing is the canonical "click a coordinate then type"
  // primitive: dispatches keystrokes at the current focus. Schema accepts it.
  it("page.type accepts no uid/selector (types at current focus)", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, text: "hi" });
    expect(p.uid).toBeUndefined();
    expect(p.selector).toBeUndefined();
    expect(p.text).toBe("hi");
  });
  it("page.type defaults submit=false, clear=true, includeSnapshot=false", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, uid: "e1", text: "hi" });
    expect(p.submit).toBe(false);
    expect(p.clear).toBe(true);
    expect(p.requireEmpty).toBe(false);
    expect(p.includeSnapshot).toBe(false);
  });

  // --- scroll ---
  it("page.scroll rejects params with no scroll target", () => {
    expect(() => PageScrollParamsSchema.parse({ tabId: 1 })).toThrow();
  });
  it("page.scroll rejects params that combine dy + selector", () => {
    expect(() => PageScrollParamsSchema.parse({ tabId: 1, dy: 100, selector: "#x" })).toThrow();
  });
  it("page.scroll accepts a selector-only scroll", () => {
    const p = PageScrollParamsSchema.parse({ tabId: 1, selector: "#footer" });
    expect(p.selector).toBe("#footer");
    expect(p.smooth).toBe(false);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.scroll accepts {to: 'bottom'}", () => {
    const p = PageScrollParamsSchema.parse({ tabId: 1, to: "bottom" });
    expect(p.to).toBe("bottom");
  });

  // --- hover ---
  it("page.hover accepts uid", () => {
    const p = PageHoverParamsSchema.parse({ tabId: 1, uid: "e7" });
    expect(p.uid).toBe("e7");
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.hover accepts selector", () => {
    const p = PageHoverParamsSchema.parse({ tabId: 1, selector: ".menu-trigger" });
    expect(p.selector).toBe(".menu-trigger");
  });
  it("page.hover rejects when neither uid nor selector", () => {
    expect(() => PageHoverParamsSchema.parse({ tabId: 1 })).toThrow();
  });

  // --- focus (loud, verifying) ---
  it("page.focus defaults mode to auto", () => {
    const p = PageFocusParamsSchema.parse({ tabId: 1, uid: "e9" });
    expect(p.mode).toBe("auto");
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.focus accepts every documented mode", () => {
    for (const mode of ["auto", "js", "click", "blur+click"] as const) {
      const p = PageFocusParamsSchema.parse({ tabId: 1, uid: "e9", mode });
      expect(p.mode).toBe(mode);
    }
  });
  it("page.focus rejects unknown mode", () => {
    expect(() => PageFocusParamsSchema.parse({ tabId: 1, uid: "e9", mode: "yolo" })).toThrow();
  });
  it("page.focus rejects when neither uid nor selector", () => {
    expect(() => PageFocusParamsSchema.parse({ tabId: 1 })).toThrow();
  });
  // --- click_xy (coordinate click for virtual canvases) ---
  it("page.clickXy validates with x/y and defaults button=left", () => {
    const p = PageClickXyParamsSchema.parse({ tabId: 1, x: 45, y: 107 });
    expect(p.x).toBe(45);
    expect(p.y).toBe(107);
    expect(p.button).toBe("left");
    expect(p.clickCount).toBe(1);
  });
  it("page.clickXy rejects negative coordinates", () => {
    expect(() => PageClickXyParamsSchema.parse({ tabId: 1, x: -1, y: 0 })).toThrow();
  });
  it("page.clickXy accepts middle/right button", () => {
    const r = PageClickXyParamsSchema.parse({ tabId: 1, x: 5, y: 5, button: "right" });
    expect(r.button).toBe("right");
  });
  it("page.clickXy accepts double-click", () => {
    const p = PageClickXyParamsSchema.parse({ tabId: 1, x: 5, y: 5, clickCount: 2 });
    expect(p.clickCount).toBe(2);
  });

  it("page.focus result round-trips with focused=false + actual fields", () => {
    const r = PageFocusResultSchema.parse({
      ok: true,
      focused: false,
      modeUsed: "blur+click",
      actualTag: "input",
      actualRole: "combobox",
      actualName: "Casella Nome",
    });
    expect(r.focused).toBe(false);
    expect(r.actualName).toBe("Casella Nome");
  });

  // --- pressKey ---
  it("page.pressKey validates with key only", () => {
    const p = PagePressKeyParamsSchema.parse({ tabId: 1, key: "Enter" });
    expect(p.key).toBe("Enter");
    expect(p.modifiers).toEqual([]);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.pressKey accepts modifiers", () => {
    const p = PagePressKeyParamsSchema.parse({ tabId: 1, key: "a", modifiers: ["Control"] });
    expect(p.modifiers).toEqual(["Control"]);
  });
  it("page.pressKey rejects invalid modifier", () => {
    expect(() => PagePressKeyParamsSchema.parse({ tabId: 1, key: "a", modifiers: ["Hyper"] })).toThrow();
  });

  it("page.focusState validates params and result", () => {
    const p = PageFocusStateParamsSchema.parse({ tabId: 1 });
    expect(p.tabId).toBe(1);
    const r = PageFocusStateResultSchema.parse({
      ok: true,
      targetId: "grid-frame",
      url: "https://grid.example/",
      title: "Grid",
      documentHasFocus: true,
      activeTag: "div",
      activeRole: "gridcell",
      activeName: "Row 3 Column 2",
      activeText: "existing",
      activeDescendant: "cell-r3-c2",
      activeDescendantRole: "gridcell",
      activeDescendantName: "B3",
      activeDescendantText: "existing",
      activeDescendantRowIndex: "3",
      activeDescendantColIndex: "2",
      activeDescendantBounds: { x: 120, y: 240, width: 80, height: 24 },
      ariaRowIndex: "3",
      ariaColIndex: "2",
    });
    expect(r.activeDescendantText).toBe("existing");
  });

  // --- fillForm ---
  it("page.fillForm accepts array of uid-targeted fields", () => {
    const p = PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [
        { uid: "e1", value: "Alice" },
        { uid: "e2", value: "alice@example.com" },
      ],
    });
    expect(p.fields).toHaveLength(2);
    expect(p.submit).toBe(false);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.fillForm accepts selector-targeted fields", () => {
    const p = PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [{ selector: "#name", value: "Bob" }],
    });
    expect(p.fields[0].selector).toBe("#name");
  });
  it("page.fillForm rejects field without uid or selector", () => {
    expect(() => PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [{ value: "no target" }],
    })).toThrow();
  });
  it("page.fillForm rejects empty fields array", () => {
    expect(() => PageFillFormParamsSchema.parse({ tabId: 1, fields: [] })).toThrow();
  });

  // --- evalJs ---
  it("page.evalJs accepts no tabId (active-tab fallback)", () => {
    const parsed = PageEvalJsParamsSchema.parse({ expression: "1+1" });
    expect(parsed.tabId).toBeUndefined();
  });
  it("page.evalJs defaults awaitPromise=true, returnByValue=true, timeoutMs=5000", () => {
    const p = PageEvalJsParamsSchema.parse({ tabId: 1, expression: "1+1" });
    expect(p.awaitPromise).toBe(true);
    expect(p.returnByValue).toBe(true);
    expect(p.timeoutMs).toBe(5_000);
  });
  it("page.evalJs rejects empty expression", () => {
    expect(() => PageEvalJsParamsSchema.parse({ tabId: 1, expression: "" })).toThrow();
  });
  it("page.evalJs rejects timeoutMs over 30000", () => {
    expect(() => PageEvalJsParamsSchema.parse({ tabId: 1, expression: "1", timeoutMs: 99999 })).toThrow();
  });

  // --- console/network ---
  it("console.read accepts no tabId (active-tab fallback)", () => {
    const parsed = ConsoleReadParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });
  it("network.read accepts no tabId (active-tab fallback)", () => {
    const parsed = NetworkReadParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });
  it("console.read defaults limit=500", () => {
    expect(ConsoleReadParamsSchema.parse({ tabId: 1 }).limit).toBe(500);
  });
  it("console.read rejects limit over 2000", () => {
    expect(() => ConsoleReadParamsSchema.parse({ tabId: 1, limit: 9999 })).toThrow();
  });
  it("console.read result accepts array of entries", () => {
    const r = [{ ts: 1, level: "error" as const, text: "boom" }];
    expect(ConsoleReadResultSchema.parse(r)).toEqual(r);
  });
  it("network.read accepts optional status and durationMs", () => {
    const r = [{ ts: 1, method: "GET", url: "https://a", type: "Document" }];
    expect(NetworkReadResultSchema.parse(r)).toEqual(r);
  });

  // --- network.getRequest ---
  it("network.getRequest requires urlPattern, defaults maxBytes", () => {
    const p = NetworkGetRequestParamsSchema.parse({ urlPattern: "/api/graph" });
    expect(p.urlPattern).toBe("/api/graph");
    expect(p.maxBytes).toBe(200_000);
  });
  it("network.getRequest rejects missing urlPattern", () => {
    expect(() => NetworkGetRequestParamsSchema.parse({})).toThrow();
  });

  // --- handle_dialog ---
  it("page.handleDialog defaults action=accept", () => {
    const p = PageHandleDialogParamsSchema.parse({ tabId: 1 });
    expect(p.action).toBe("accept");
  });
  it("page.handleDialog accepts promptText for prompt dialogs", () => {
    const p = PageHandleDialogParamsSchema.parse({ tabId: 1, action: "accept", promptText: "yes" });
    expect(p.promptText).toBe("yes");
  });
  it("page.handleDialog rejects invalid action", () => {
    expect(() => PageHandleDialogParamsSchema.parse({ tabId: 1, action: "maybe" })).toThrow();
  });

  // --- select ---
  it("page.select accepts uid + values", () => {
    const p = PageSelectParamsSchema.parse({ tabId: 1, uid: "e5", values: ["opt1"] });
    expect(p.values).toEqual(["opt1"]);
  });
  it("page.select rejects missing target", () => {
    expect(() => PageSelectParamsSchema.parse({ tabId: 1, values: ["opt1"] })).toThrow();
  });
  it("page.select rejects empty values", () => {
    expect(() => PageSelectParamsSchema.parse({ tabId: 1, uid: "e5", values: [] })).toThrow();
  });

  // --- upload_file ---
  it("page.uploadFile accepts selector + filePaths", () => {
    const p = PageUploadFileParamsSchema.parse({ tabId: 1, selector: "#file", filePaths: ["/tmp/a.png"] });
    expect(p.filePaths).toHaveLength(1);
  });
  it("page.uploadFile rejects empty filePaths", () => {
    expect(() => PageUploadFileParamsSchema.parse({ tabId: 1, uid: "e1", filePaths: [] })).toThrow();
  });

  // --- drag ---
  it("page.drag accepts fromUid + toUid", () => {
    const p = PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1", toUid: "e2" });
    expect(p.fromUid).toBe("e1");
    expect(p.toUid).toBe("e2");
    expect(p.steps).toBe(10);
  });
  it("page.drag rejects missing from target", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, toUid: "e2" })).toThrow();
  });
  it("page.drag rejects missing to target", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1" })).toThrow();
  });
  it("page.drag rejects steps over 50", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1", toUid: "e2", steps: 100 })).toThrow();
  });

  // --- fetch ---
  it("page.fetch defaults method=GET, credentials=include, timeoutMs=15000", () => {
    const p = PageFetchParamsSchema.parse({ url: "/api/foo" });
    expect(p.method).toBe("GET");
    expect(p.credentials).toBe("include");
    expect(p.timeoutMs).toBe(15_000);
    expect(p.maxBytes).toBe(200_000);
  });
  it("page.fetch accepts JSON body as object", () => {
    const p = PageFetchParamsSchema.parse({ url: "/api", method: "POST", body: { a: 1 } });
    expect(p.body).toEqual({ a: 1 });
  });
  it("page.fetch accepts body as string", () => {
    const p = PageFetchParamsSchema.parse({ url: "/api", method: "POST", body: "raw=text" });
    expect(p.body).toBe("raw=text");
  });
  it("page.fetch rejects unknown HTTP method", () => {
    expect(() => PageFetchParamsSchema.parse({ url: "/api", method: "TRACE" })).toThrow();
  });
  it("page.fetch rejects timeoutMs > 60000", () => {
    expect(() => PageFetchParamsSchema.parse({ url: "/api", timeoutMs: 999999 })).toThrow();
  });

  // --- paste ---
  it("page.paste accepts text + tabId, defaults target=current", () => {
    const p = PagePasteParamsSchema.parse({ tabId: 1, text: "Alice\t30\nBob\t25" });
    expect(p.target).toBe("current");
    expect(p.text).toContain("Alice");
  });
  it("page.paste accepts target=uid with a uid", () => {
    const p = PagePasteParamsSchema.parse({ tabId: 1, text: "x", target: "uid", uid: "e5" });
    expect(p.target).toBe("uid");
  });
  it("page.paste rejects target=uid without uid", () => {
    expect(() => PagePasteParamsSchema.parse({ tabId: 1, text: "x", target: "uid" })).toThrow();
  });
  it("page.paste rejects target=xy without coordinates", () => {
    expect(() => PagePasteParamsSchema.parse({ tabId: 1, text: "x", target: "xy" })).toThrow();
  });
  it("page.paste rejects empty text", () => {
    expect(() => PagePasteParamsSchema.parse({ tabId: 1, text: "" })).toThrow();
  });

  // --- wait ---
  it("page.wait uid mode round-trips with default state=visible", () => {
    const p = PageWaitParamsSchema.parse({ tabId: 1, for: "uid", uid: "e7" });
    expect(p.for).toBe("uid");
    expect(p.state).toBe("visible");
    expect(p.timeoutMs).toBe(10_000);
  });
  it("page.wait uid mode requires uid", () => {
    expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "uid" })).toThrow();
  });
  it("page.wait selector mode round-trips (fallback path)", () => {
    expect(PageWaitParamsSchema.parse({ tabId: 1, for: "selector", selector: "#ok" }).selector).toBe("#ok");
  });
  it("page.wait function mode requires expression", () => {
    expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "function" })).toThrow();
  });
  it("page.wait response mode requires urlPattern", () => {
    expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "response" })).toThrow();
  });
  it("page.wait loadstate accepts load/domcontentloaded/networkidle", () => {
    expect(PageWaitParamsSchema.parse({ tabId: 1, for: "loadstate", loadState: "networkidle" }).loadState).toBe("networkidle");
  });
  it("page.wait text mode round-trips", () => {
    const p = PageWaitParamsSchema.parse({ tabId: 1, for: "text", text: "Payment complete" });
    expect(p.for).toBe("text");
    expect(p.text).toBe("Payment complete");
  });
  it("page.wait text mode requires text", () => {
    expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "text" })).toThrow();
  });

  // --- waitForDownload ---
  it("page.waitForDownload defaults timeoutMs=30000", () => {
    const p = PageWaitForDownloadParamsSchema.parse({});
    expect(p.timeoutMs).toBe(30_000);
  });
  it("page.waitForDownload accepts a filenamePattern", () => {
    const p = PageWaitForDownloadParamsSchema.parse({ filenamePattern: "\\.xlsx$" });
    expect(p.filenamePattern).toBe("\\.xlsx$");
  });
  it("page.waitForDownload rejects timeoutMs > 300000", () => {
    expect(() => PageWaitForDownloadParamsSchema.parse({ timeoutMs: 999_999 })).toThrow();
  });

  // --- click/type force + type modifiers ---
  it("page.click defaults force=false", () => {
    expect(PageClickParamsSchema.parse({ tabId: 1, uid: "e1" }).force).toBe(false);
  });
  it("page.click defaults timeoutMs=5000", () => {
    expect(PageClickParamsSchema.parse({ tabId: 1, uid: "e1" }).timeoutMs).toBe(5_000);
  });
  it("page.type defaults force=false and modifiers=[]", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, uid: "e1", text: "hi" });
    expect(p.force).toBe(false);
    expect(p.modifiers).toEqual([]);
    expect(p.timeoutMs).toBe(5_000);
  });
  it("page.navigate defaults timeoutMs=30000", () => {
    expect(PageNavigateParamsSchema.parse({ tabId: 1, url: "https://x" }).timeoutMs).toBe(30_000);
  });
  it("page.type accepts modifiers for chords", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, text: "a", modifiers: ["Control"] });
    expect(p.modifiers).toEqual(["Control"]);
  });

  // --- scroll wheel mode ---
  it("page.scroll defaults mode=js", () => {
    expect(PageScrollParamsSchema.parse({ tabId: 1, to: "bottom" }).mode).toBe("js");
  });
  it("page.scroll wheel mode round-trips with dx/dy + uid anchor", () => {
    const p = PageScrollParamsSchema.parse({ tabId: 1, mode: "wheel", dy: 400, uid: "e9" });
    expect(p.mode).toBe("wheel");
    expect(p.dy).toBe(400);
  });
  it("page.scroll wheel mode rejects missing deltas", () => {
    expect(() => PageScrollParamsSchema.parse({ tabId: 1, mode: "wheel" })).toThrow();
  });

  // --- coordinate-true screenshots ---
  it("page.screenshot defaults maxEdge=1568 and maxPixels=1.15MP, accepts a clip", () => {
    const p = PageScreenshotParamsSchema.parse({ tabId: 1 });
    expect(p.maxEdge).toBe(1568);
    expect(p.maxPixels).toBe(1_150_000);
    expect(p.clip).toBeUndefined();
    const c = PageScreenshotParamsSchema.parse({ tabId: 1, clip: { x: 10, y: 20, width: 300, height: 200 } });
    expect(c.clip).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });
  it("page.screenshot rejects a zero-size clip", () => {
    expect(() => PageScreenshotParamsSchema.parse({ tabId: 1, clip: { x: 0, y: 0, width: 0, height: 10 } })).toThrow();
  });
  it("page.screenshot result round-trips the image→viewport transform", () => {
    const r = {
      format: "jpeg" as const, base64: "AAAA",
      image: { width: 1568, height: 700 }, scale: 1.6327, origin: { x: 0, y: 0 }, capture: "cdp" as const,
    };
    const once = PageScreenshotResultSchema.parse(r);
    expect(PageScreenshotResultSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
  it("page.clickXy defaults space=screenshot and settle=true; accepts space=css", () => {
    const p = PageClickXyParamsSchema.parse({ tabId: 1, x: 5, y: 6 });
    expect(p.space).toBe("screenshot");
    expect(p.settle).toBe(true);
    expect(PageClickXyParamsSchema.parse({ tabId: 1, x: 5, y: 6, space: "css" }).space).toBe("css");
    expect(() => PageClickXyParamsSchema.parse({ tabId: 1, x: 5, y: 6, space: "device" })).toThrow();
  });
  it("page.clickXy result round-trips point/spaceUsed/focus", () => {
    const r = {
      ok: true as const, point: { x: 258.16, y: 300.4 }, spaceUsed: "screenshot" as const,
      focus: { frame: "https://app.example/editor", tag: "div", role: "textbox", activeDescendantName: "C5", settled: true, waitedMs: 180 },
    };
    expect(PageClickXyResultSchema.parse(JSON.parse(JSON.stringify(PageClickXyResultSchema.parse(r))))).toEqual(r);
  });
  it("page.paste defaults space=screenshot; result carries verified delivery", () => {
    expect(PagePasteParamsSchema.parse({ tabId: 1, text: "a", target: "xy", x: 1, y: 2 }).space).toBe("screenshot");
    const r = { ok: true as const, bytesWritten: 3, pasteDelivered: true, pasteHandledByPage: true };
    expect(PagePasteResultSchema.parse(r)).toEqual(r);
  });

  // --- multi-OS modifiers ---
  it("modifiers accept the portable ControlOrMeta on press_key and type", () => {
    expect(PagePressKeyParamsSchema.parse({ tabId: 1, key: "v", modifiers: ["ControlOrMeta"] }).modifiers).toEqual(["ControlOrMeta"]);
    expect(PageTypeParamsSchema.parse({ tabId: 1, text: "a", modifiers: ["ControlOrMeta", "Shift"] }).modifiers).toEqual(["ControlOrMeta", "Shift"]);
    expect(() => PagePressKeyParamsSchema.parse({ tabId: 1, key: "v", modifiers: ["Cmd"] })).toThrow();
  });
  it("press_key/type default settle=true and their results round-trip a focus summary", () => {
    expect(PagePressKeyParamsSchema.parse({ tabId: 1, key: "Enter" }).settle).toBe(true);
    expect(PageTypeParamsSchema.parse({ tabId: 1, text: "x" }).settle).toBe(true);
    const r = { ok: true as const, focus: { tag: "input", role: "combobox", value: "A12", settled: false, waitedMs: 2000 } };
    expect(PageTypeResultSchema.parse(r)).toEqual(r);
    expect(PagePressKeyResultSchema.parse(r)).toEqual(r);
    expect(FocusSummarySchema.parse(r.focus)).toEqual(r.focus);
  });

  // --- frame targeting ---
  it("page.evalJs and page.wait accept a frame selector; evalJs result labels the frame", () => {
    expect(PageEvalJsParamsSchema.parse({ expression: "1", frame: "focused" }).frame).toBe("focused");
    expect(PageWaitParamsSchema.parse({ tabId: 1, for: "function", expression: "true", frame: "app\\.example" }).frame).toBe("app\\.example");
    expect(() => PageEvalJsParamsSchema.parse({ expression: "1", frame: "" })).toThrow();
    const r = { type: "number", value: 2, frame: "https://app.example/editor" };
    expect(PageEvalJsResultSchema.parse(r)).toEqual(r);
  });

  // --- typed-text fidelity: inline completion + popups ---
  it("page.type defaults exact=true; the result round-trips a completion report", () => {
    expect(PageTypeParamsSchema.parse({ tabId: 1, text: "Ap" }).exact).toBe(true);
    expect(PageTypeParamsSchema.parse({ tabId: 1, text: "Ap", exact: false }).exact).toBe(false);
    const r = {
      ok: true as const,
      completion: { typed: "Ap", fieldShowed: "Apple", removed: true, fieldNow: "Ap" },
      focus: { tag: "div", role: "textbox", text: "Ap", settled: true, waitedMs: 180 },
    };
    expect(PageTypeResultSchema.parse(JSON.parse(JSON.stringify(PageTypeResultSchema.parse(r))))).toEqual(r);
    expect(() => PageTypeResultSchema.parse({ ok: true, completion: { typed: "Ap" } })).toThrow();
  });
  it("focus summaries and page.focusState carry popups (role/label/items) and expanded", () => {
    const summary = {
      tag: "input", role: "combobox", value: "=SOM", settled: true, waitedMs: 200,
      popups: [{ role: "listbox", items: 12 }, { role: "dialog", label: "Insert function" }], expanded: true,
    };
    expect(FocusSummarySchema.parse(summary)).toEqual(summary);
    expect(() => FocusSummarySchema.parse({ ...summary, popups: [{ role: "menu", items: 1.5 }] })).toThrow();
    const state = {
      ok: true as const, url: "https://a", title: "a", documentHasFocus: true, activeTag: "input",
      activeExpanded: "true", popups: [{ role: "menu", items: 3 }],
    };
    expect(PageFocusStateResultSchema.parse(state)).toEqual(state);
  });
});

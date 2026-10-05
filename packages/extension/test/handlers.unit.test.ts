import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before module imports — ensures chrome exists when DebuggerManager
// is constructed at module evaluation time inside debug.ts.
const _chromeStub = vi.hoisted(() => {
  (globalThis as any).chrome = {
    tabs: { onRemoved: { addListener: () => {} } },
    debugger: {
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
  };
  return null;
});

import { registerHandlers } from "../src/handlers/index.js";
import { Dispatcher } from "../src/dispatcher.js";
import { resetScreenshotTransforms } from "../src/lib/screenshot-transform.js";

function fakeChrome() {
  const state = {
    tabs: [{ id: 1, url: "https://a", title: "a", active: true, windowId: 1 }] as any[],
    groups: new Map<number, { title?: string; color?: string; tabs: number[] }>(),
    nextGroupId: 100,
    debuggerState: {
      attached: new Set<number | string>(),
      commands: [] as any[],
      onEventListeners: [] as Array<(src: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => void>,
      focusedTargetId: undefined as string | undefined,
      // waitForActionable predicate result; default = actionable & stable.
      actionable: { ok: true, x: 100, y: 100 } as Record<string, unknown>,
      // page.wait text-mode probe result; default = present.
      textPresent: true as boolean,
      // page.snapshot since=last: add an extra a11y node on demand.
      extraAxNode: false as boolean,
      // page.type clear handshake: element kind and what remains after clearing.
      // Default "empty" → nothing to clear, so keystroke-count tests stay exact.
      clearKind: "empty" as string,
      textAfterClear: "" as string,
      // page.paste probe readout (what the in-page paste observer saw).
      pasteProbe: { fired: true, prevented: true, target: "div" } as Record<string, unknown> | null,
      clipboardVia: "clipboard-api" as string,
      // Page.getLayoutMetrics css viewport + Page.captureScreenshot behaviour.
      cssViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 } as Record<string, number>,
      captureFails: false as boolean,
      // location.href per session (undefined targetId = top frame).
      frameUrls: {} as Record<string, string>,
      // Field text reads (successive values; the last one repeats): focused
      // element via Runtime.evaluate, resolved element via callFunctionOn.
      fieldTexts: [] as string[],
      elementFieldTexts: [] as string[],
      // Popups reported by the focus-state probe before/after any key event.
      keysSent: false as boolean,
      popupsBeforeKeys: [] as Array<Record<string, unknown>>,
      popupsAfterKeys: [] as Array<Record<string, unknown>>,
      expandedAfterKeys: null as string | null,
    },
  };
  const nextText = (list: string[]) => (list.length > 1 ? list.shift()! : list[0]);
  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async (q: { active?: boolean; lastFocusedWindow?: boolean }) => {
        if (q.active && q.lastFocusedWindow) return [{ id: 99, url: "https://active", title: "active", active: true, windowId: 1 }];
        return state.tabs;
      }),
      create: vi.fn(async ({ url }: { url: string }) => {
        const t = { id: state.tabs.length + 1, url, title: "", active: true, windowId: 1 };
        state.tabs.push(t);
        return t;
      }),
      update: vi.fn(async (_id: number, _p: unknown) => ({})),
      remove: vi.fn(async (_id: number) => {}),
      get: vi.fn(async (id: number) => state.tabs.find((t) => t.id === id) ?? { id, url: "https://a", title: "a", windowId: 1 }),
      captureVisibleTab: vi.fn(async (_winId: number, opts: { format: string }) => `data:image/${opts.format};base64,AAAA`),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      group: vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        if (groupId !== undefined && state.groups.has(groupId)) {
          const g = state.groups.get(groupId)!;
          for (const t of tabIds) if (!g.tabs.includes(t)) g.tabs.push(t);
          return groupId;
        }
        const gid = state.nextGroupId++;
        state.groups.set(gid, { tabs: [...tabIds] });
        return gid;
      }),
      ungroup: vi.fn(async (_ids: number[]) => {}),
    },
    tabGroups: {
      update: vi.fn(async (gid: number, props: { title?: string; color?: string; collapsed?: boolean }) => {
        const g = state.groups.get(gid);
        if (g) Object.assign(g, props);
        return g;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (opts: any) => {
        // For text/dom snapshot modes (injected function) and scroll.
        if (opts.func) {
          if (opts.func.name === "viewportSnapshot") {
            return [{ result: { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 10, scrollY: 20 } }];
          }
          if (opts.args?.length === 5) {
            return [{ result: { ok: true } }];
          }
          return [{ result: { mode: "text", url: "https://a", title: "a", content: "hello", truncated: false } }];
        }
        return [{ result: { ok: true } }];
      }),
    },
    action: {
      setBadgeText: vi.fn(async (_p) => {}),
      setBadgeBackgroundColor: vi.fn(async (_p) => {}),
    },
    debugger: {
      attach: vi.fn(async ({ tabId, targetId }: { tabId?: number; targetId?: string }) => {
        state.debuggerState.attached.add(targetId ?? tabId!);
      }),
      detach: vi.fn(async ({ tabId, targetId }: { tabId?: number; targetId?: string }) => {
        state.debuggerState.attached.delete(targetId ?? tabId!);
      }),
      sendCommand: vi.fn(async (target: any, method: string, params: any) => {
        state.debuggerState.commands.push({ target, method, params });
        if (method === "Input.dispatchKeyEvent") state.debuggerState.keysSent = true;
        if (method === "Runtime.enable" || method === "Network.enable" || method === "Accessibility.enable" || method === "Page.enable") return {};
        if (method === "Runtime.evaluate") {
          if (params?.expression === "document.hasFocus()") {
            return { result: { type: "boolean", value: target.targetId === state.debuggerState.focusedTargetId } };
          }
          // page.type exact-typing check: text of the focused field.
          if (typeof params?.expression === "string" && params.expression.includes("isContentEditable") &&
              params.expression.includes("document.activeElement")) {
            const v = nextText(state.debuggerState.fieldTexts);
            return v === undefined ? { result: { type: "undefined" } } : { result: { type: "string", value: v } };
          }
          if (params?.expression === "location.href") {
            const url = state.debuggerState.frameUrls[target.targetId ?? "top"] ?? (target.targetId ? "https://grid.example/" : "https://a/");
            return { result: { type: "string", value: url } };
          }
          // page.paste: probe arm / read / dispose, then the clipboard write.
          if (typeof params?.expression === "string" && params.expression.includes("__chromanchePasteProbe")) {
            if (params.expression.includes("addEventListener")) return { result: { type: "boolean", value: true } };
            if (params.expression.includes("dispose()")) return { result: { type: "boolean", value: true } };
            return { result: { type: "object", value: state.debuggerState.pasteProbe } };
          }
          if (typeof params?.expression === "string" && params.expression.includes("navigator.clipboard")) {
            return { result: { type: "string", value: state.debuggerState.clipboardVia } };
          }
          // page.wait text mode: an innerText.includes(...) probe. Honor a
          // per-test override so we can simulate text present/absent.
          if (typeof params?.expression === "string" && params.expression.includes(".innerText")) {
            return { result: { type: "boolean", value: state.debuggerState.textPresent } };
          }
          if (typeof params?.expression === "string" && params.expression.includes("activeElement")) {
            return {
              result: {
                type: "object",
                value: {
                  url: target.targetId ? "https://grid.example/" : "https://a",
                  title: target.targetId ? "Grid" : "a",
                  documentHasFocus: target.targetId === state.debuggerState.focusedTargetId,
                  activeTag: "div",
                  activeRole: "gridcell",
                  activeName: "Row 3 Column 2",
                  activeValue: undefined,
                  activeText: "existing",
                  selectedText: undefined,
                  activeDescendant: "cell-r3-c2",
                  activeDescendantTag: "div",
                  activeDescendantRole: "gridcell",
                  activeDescendantName: "B3",
                  activeDescendantText: "existing",
                  activeDescendantRowIndex: "3",
                  activeDescendantColIndex: "2",
                  activeDescendantBounds: { x: 120, y: 240, width: 80, height: 24 },
                  ariaRowIndex: "3",
                  ariaColIndex: "2",
                  activeExpanded: state.debuggerState.keysSent ? state.debuggerState.expandedAfterKeys : null,
                  popups: state.debuggerState.keysSent ? state.debuggerState.popupsAfterKeys : state.debuggerState.popupsBeforeKeys,
                },
              },
            };
          }
          return { result: { type: "string", value: "ok" } };
        }
        if (method === "Runtime.callFunctionOn") {
          // page.select uses returnByValue to return the picked values array.
          if (params?.functionDeclaration?.includes("page.select target") || params?.functionDeclaration?.includes("picked")) {
            return { result: { type: "object", value: ["opt1"] } };
          }
          // waitForActionable predicate: returns { ok, x, y } / { ok:false, reason }.
          // Honor a per-test override so we can simulate hidden/disabled elements.
          if (params?.functionDeclaration?.includes("getBoundingClientRect") && params?.functionDeclaration?.includes("isConnected")) {
            return { result: { type: "object", value: state.debuggerState.actionable } };
          }
          // page.type exact-typing check: text of the element typed into.
          if (params?.functionDeclaration?.includes("isContentEditable") && params?.functionDeclaration?.includes("return null")) {
            const v = nextText(state.debuggerState.elementFieldTexts);
            return v === undefined ? { result: { type: "undefined" } } : { result: { type: "string", value: v } };
          }
          // page.type clear handshake (kind detection → selection coverage → remaining text).
          if (params?.functionDeclaration?.includes("isContentEditable")) {
            return { result: { type: "string", value: state.debuggerState.clearKind } };
          }
          if (params?.functionDeclaration?.includes("selectionStart === 0")) {
            return { result: { type: "boolean", value: true } };
          }
          if (params?.functionDeclaration?.includes("String(this.value")) {
            return { result: { type: "string", value: state.debuggerState.textAfterClear } };
          }
          // verifyFocus: JS in the page returns { matches, actualTag?, ... }.
          // Default to "focus took" so happy-path tests don't have to special-case it.
          if (params?.functionDeclaration?.includes("doc.activeElement") || params?.functionDeclaration?.includes("matches: true")) {
            return { result: { type: "object", value: { matches: true } } };
          }
          return { result: { type: "undefined" } };
        }
        if (method === "Page.handleJavaScriptDialog") return {};
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: state.debuggerState.cssViewport };
        if (method === "Page.captureScreenshot") {
          if (state.debuggerState.captureFails) throw new Error("Unable to capture screenshot");
          return { data: "BBBB" };
        }
        if (method === "DOM.setFileInputFiles") return {};
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", backendDOMNodeId: 10, role: { type: "role", value: "WebArea" }, name: { type: "computedString", value: "Test Page" }, childIds: state.debuggerState.extraAxNode ? ["2", "3", "4"] : ["2", "3"] },
              { nodeId: "2", backendDOMNodeId: 20, role: { type: "role", value: "button" }, name: { type: "computedString", value: "Submit" }, properties: [{ name: "focusable", value: { type: "boolean", value: true } }] },
              { nodeId: "3", backendDOMNodeId: 30, role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "Email" }, properties: [{ name: "focusable", value: { type: "boolean", value: true } }] },
              ...(state.debuggerState.extraAxNode
                ? [{ nodeId: "4", backendDOMNodeId: 40, role: { type: "role", value: "button" }, name: { type: "computedString", value: "Confirm" }, properties: [{ name: "focusable", value: { type: "boolean", value: true } }] }]
                : []),
            ],
          };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-" + (params.backendNodeId ?? params.nodeId) } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: params.selector === "#missing" ? 0 : 42 };
        if (method === "DOM.getBoxModel") return { model: { content: [100, 100, 200, 100, 200, 200, 100, 200] } };
        if (method === "Input.dispatchMouseEvent") return {};
        if (method === "Input.dispatchKeyEvent") return {};
        if (method === "Input.insertText") return {};
        return {};
      }),
      onEvent: { addListener: vi.fn((listener) => state.debuggerState.onEventListeners.push(listener)) },
      onDetach: { addListener: vi.fn() },
    },
    downloads: {
      _created: [] as Array<(item: any) => void>,
      _changed: [] as Array<(delta: any) => void>,
      _items: new Map<number, any>(),
      onCreated: {
        addListener: vi.fn((l: any) => { (globalThis as any).chrome.downloads._created.push(l); }),
        removeListener: vi.fn((l: any) => {
          const a = (globalThis as any).chrome.downloads._created;
          const i = a.indexOf(l); if (i >= 0) a.splice(i, 1);
        }),
      },
      onChanged: {
        addListener: vi.fn((l: any) => { (globalThis as any).chrome.downloads._changed.push(l); }),
        removeListener: vi.fn((l: any) => {
          const a = (globalThis as any).chrome.downloads._changed;
          const i = a.indexOf(l); if (i >= 0) a.splice(i, 1);
        }),
      },
      search: vi.fn((q: { id: number }, cb: (items: any[]) => void) => {
        const item = (globalThis as any).chrome.downloads._items.get(q.id);
        cb(item ? [item] : []);
      }),
    },
  };
  return state;
}

describe("handlers", () => {
  let state: ReturnType<typeof fakeChrome>;
  let d: Dispatcher;

  beforeEach(() => {
    state = fakeChrome();
    resetScreenshotTransforms();
    d = new Dispatcher();
    registerHandlers(d);
  });
  afterEach(() => { delete (globalThis as any).chrome; });

  async function attachFocusedFrame(targetId = "grid-frame") {
    state.debuggerState.focusedTargetId = targetId;
    for (const listener of state.debuggerState.onEventListeners) {
      listener({ tabId: 1 }, "Target.attachedToTarget", {
        targetInfo: { targetId, type: "iframe", url: "https://grid.example/" },
      });
    }
    await Promise.resolve();
  }

  it("tabs.list returns all tabs", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 1, method: "tabs.list" });
    expect(resp.result).toHaveLength(1);
    expect((resp.result as any)[0].url).toBe("https://a");
  });

  it("tabs.create creates a tab and returns it", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 2, method: "tabs.create",
      params: { url: "https://example.com", active: true },
    });
    expect((resp.result as any).url).toBe("https://example.com");
  });

  it("session.claim groups the tab under an Agent orange group", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 3, method: "session.claim", params: { tabId: 1 } });
    expect((resp.result as any).ok).toBe(true);
    const gid = (resp.result as any).groupId;
    expect(state.groups.get(gid)?.title).toBe("Agent");
    expect(state.groups.get(gid)?.color).toBe("orange");
  });

  it("session.claim is idempotent (second call reuses group)", async () => {
    const a = await d.handle({ jsonrpc: "2.0", id: 4, method: "session.claim", params: { tabId: 1 } });
    const b = await d.handle({ jsonrpc: "2.0", id: 5, method: "session.claim", params: { tabId: 1 } });
    expect((a.result as any).groupId).toBe((b.result as any).groupId);
  });

  it("session.claim injects overlay via executeScript({ func })", async () => {
    const spy = (globalThis as any).chrome.scripting.executeScript as ReturnType<typeof vi.fn>;
    spy.mockClear();
    await d.handle({ jsonrpc: "2.0", id: 10, method: "session.claim", params: { tabId: 1 } });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(typeof call.func).toBe("function");
    expect(call.files).toBeUndefined();
  });

  // --- page.snapshot ---
  it("page.snapshot mode=a11y returns CDP accessibility tree with uids", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 20, method: "page.snapshot", params: { tabId: 1 } });
    const result = resp.result as any;
    expect(result.mode).toBe("a11y");
    expect(result.content).toContain("button");
    expect(result.content).toContain("Submit");
    // UIDs should be present.
    expect(result.content).toMatch(/\[e\d+\]/);
  });

  it("page.snapshot mode=text returns innerText via executeScript", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 21, method: "page.snapshot", params: { tabId: 1, mode: "text" } });
    expect((resp.result as any).content).toBe("hello");
    expect((resp.result as any).mode).toBe("text");
  });

  it("page.snapshot a11y can include bounds for accessible grid positioning", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 23, method: "page.snapshot",
      params: { tabId: 1, includeBounds: true },
    });
    expect((resp.result as any).content).toContain("bbox=100,100,100,100");
  });

  it("page.snapshot since=last returns a full baseline on first call", async () => {
    // Fresh tab id with no prior snapshot baseline.
    const resp = await d.handle({
      jsonrpc: "2.0", id: 24, method: "page.snapshot",
      params: { tabId: 7, since: "last" },
    });
    const r = resp.result as any;
    expect(r.baseline).toBe(true);
    expect(r.content).toContain("Submit");
    expect(r.diff).toBeUndefined();
  });

  it("page.snapshot since=last returns only changed lines after a DOM change", async () => {
    // First snapshot establishes the baseline.
    await d.handle({ jsonrpc: "2.0", id: 25, method: "page.snapshot", params: { tabId: 8, since: "last" } });
    // Simulate a new node appearing.
    state.debuggerState.extraAxNode = true;
    const resp = await d.handle({
      jsonrpc: "2.0", id: 26, method: "page.snapshot",
      params: { tabId: 8, since: "last" },
    });
    const r = resp.result as any;
    expect(r.baseline).toBeUndefined();
    expect(r.diff.added).toBe(1);
    expect(r.diff.removed).toBe(0);
    expect(r.content).toContain("+ ");
    expect(r.content).toContain("Confirm");
    // Unchanged nodes are NOT re-emitted — the speed win.
    expect(r.content).not.toContain("Submit");
  });

  it("page.screenshot captures THIS tab via CDP and returns base64 + viewport metadata", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 22, method: "page.screenshot", params: { tabId: 1 } });
    expect((resp.result as any).base64).toBe("BBBB");
    expect((resp.result as any).format).toBe("jpeg");
    expect((resp.result as any).capture).toBe("cdp");
    expect((resp.result as any).viewport).toEqual({
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
      scrollX: 10,
      scrollY: 20,
    });
    // Not chrome.tabs.captureVisibleTab — that grabs whichever tab is visible in the window.
    expect((globalThis as any).chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("page.screenshot downscales wide viewports to fit vision limits and reports the transform", async () => {
    state.debuggerState.cssViewport = { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1143 };
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 27, method: "page.screenshot", params: { tabId: 1 } });
    const r = resp.result as any;
    const cap = state.debuggerState.commands.find((c: any) => c.method === "Page.captureScreenshot");
    // Long edge 2560 → 1568 (default maxEdge): scale 0.6125, also under 1.15 MP.
    expect(cap.params.clip).toMatchObject({ x: 0, y: 0, width: 2560, height: 1143 });
    expect(cap.params.clip.scale).toBeCloseTo(1568 / 2560, 5);
    expect(r.image).toEqual({ width: 1568, height: 700 });
    expect(r.scale).toBeCloseTo(2560 / 1568, 3);
    expect(r.origin).toEqual({ x: 0, y: 0 });
  });

  it("page.screenshot clip is captured in document coordinates (adds the scroll offset)", async () => {
    state.debuggerState.cssViewport = { pageX: 0, pageY: 900, clientWidth: 1000, clientHeight: 600 };
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 28, method: "page.screenshot",
      params: { tabId: 1, clip: { x: 100, y: 50, width: 400, height: 200 } },
    });
    const cap = state.debuggerState.commands.find((c: any) => c.method === "Page.captureScreenshot");
    expect(cap.params.clip).toMatchObject({ x: 100, y: 950, width: 400, height: 200, scale: 1 });
    expect((resp.result as any).origin).toEqual({ x: 100, y: 50 });
  });

  it("page.screenshot refuses to return another tab's pixels when a background tab can't render", async () => {
    state.tabs[0].active = false;
    state.debuggerState.captureFails = true;
    const resp = await d.handle({ jsonrpc: "2.0", id: 29, method: "page.screenshot", params: { tabId: 1 } });
    expect(resp.error?.message).toMatch(/background/);
    expect(resp.error?.message).toMatch(/tabs_activate/);
    expect((globalThis as any).chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("page.screenshot falls back to the visible-tab capture only when this tab IS the visible one", async () => {
    state.debuggerState.captureFails = true;
    const resp = await d.handle({ jsonrpc: "2.0", id: 30, method: "page.screenshot", params: { tabId: 1 } });
    expect((resp.result as any).base64).toBe("AAAA");
    expect((resp.result as any).capture).toBe("visibleTab");
  });

  it("page.snapshot with no tabId resolves to the active tab", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 60, method: "page.snapshot", params: {} });
    expect(resp.error).toBeUndefined();
  });

  /** Helper: take a snapshot and extract uids from the content. */
  async function snapshotUids(tabId: number): Promise<string[]> {
    const resp = await d.handle({ jsonrpc: "2.0", id: Date.now(), method: "page.snapshot", params: { tabId } });
    const content = (resp.result as any).content as string;
    return [...content.matchAll(/\[(e\d+)\]/g)].map(m => m[1]);
  }

  // --- page.click (CDP-based) ---
  it("page.click with uid dispatches CDP mouse events", async () => {
    const uids = await snapshotUids(1);
    expect(uids.length).toBeGreaterThanOrEqual(2);
    const resp = await d.handle({
      jsonrpc: "2.0", id: 71, method: "page.click",
      params: { tabId: 1, uid: uids[0] },
    });
    expect((resp.result as any).ok).toBe(true);
    const mouseEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.length).toBeGreaterThanOrEqual(2); // mousePressed + mouseReleased
  });

  it("page.click with selector resolves via DOM.querySelector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 72, method: "page.click",
      params: { tabId: 1, selector: "#go" },
    });
    expect((resp.result as any).ok).toBe(true);
    const qsCalls = state.debuggerState.commands.filter((c: any) => c.method === "DOM.querySelector");
    expect(qsCalls.length).toBe(1);
    expect(qsCalls[0].params.selector).toBe("#go");
  });

  it("page.click rejects when neither uid nor selector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 73, method: "page.click",
      params: { tabId: 1 },
    });
    expect(resp.error).toBeDefined();
  });

  // page.clickXy: vision-driven escape hatch. Dispatches at the supplied
  // (x, y) without resolving any element — used after the model has read a
  // screenshot and computed coordinates for a virtual-canvas widget cell.
  it("page.clickXy hovers, then fires mousePressed + mouseReleased at exact coordinates", async () => {
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 200, method: "page.clickXy",
      params: { tabId: 1, x: 45, y: 107 },
    });
    expect((resp.result as any).ok).toBe(true);
    const mouse = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent");
    expect(mouse.map((m: any) => m.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1].params).toMatchObject({ type: "mousePressed", x: 45, y: 107, button: "left", buttons: 1 });
    expect(mouse[2].params).toMatchObject({ type: "mouseReleased", x: 45, y: 107, button: "left" });
    // No screenshot yet for this tab → coordinates were taken as CSS px.
    expect((resp.result as any).spaceUsed).toBe("css");
  });

  it("page.clickXy honors button=right (buttons bitmask 2) and never resolves a uid (no DOM lookup)", async () => {
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 201, method: "page.clickXy",
      params: { tabId: 1, x: 200, y: 50, button: "right" },
    });
    const pressed = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
    );
    expect(pressed.params.button).toBe("right");
    expect(pressed.params.buttons).toBe(2);
    // Critical: no DOM.resolveNode / DOM.getBoxModel — clickXy bypasses element resolution.
    const dom = state.debuggerState.commands.filter((c: any) => /^DOM\./.test(c.method));
    expect(dom.length).toBe(0);
  });

  it("page.clickXy supports double-click at exact coordinates", async () => {
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 202, method: "page.clickXy",
      params: { tabId: 1, x: 88, y: 144, clickCount: 2 },
    });
    const clicks = state.debuggerState.commands.filter(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type !== "mouseMoved",
    );
    expect(clicks.length).toBe(4);
    expect(clicks.map((c: any) => c.params.clickCount)).toEqual([1, 1, 2, 2]);
    expect(clicks.every((c: any) => c.params.x === 88 && c.params.y === 144)).toBe(true);
  });

  it("page.clickXy maps screenshot pixels back to CSS px using the last screenshot's transform", async () => {
    // 2560px-wide viewport → screenshot downscaled to 1568px (scale 2560/1568).
    state.debuggerState.cssViewport = { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1143 };
    await d.handle({ jsonrpc: "2.0", id: 203, method: "page.screenshot", params: { tabId: 1 } });
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 204, method: "page.clickXy",
      params: { tabId: 1, x: 158, y: 184 },
    });
    const pressed = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
    );
    const s = 2560 / 1568;
    expect(pressed.params.x).toBeCloseTo(158 * s, 1);
    expect(pressed.params.y).toBeCloseTo(184 * s, 1);
    expect((resp.result as any).spaceUsed).toBe("screenshot");
    expect((resp.result as any).point.x).toBeCloseTo(158 * s, 1);
  });

  it("page.clickXy space=css bypasses the screenshot transform", async () => {
    state.debuggerState.cssViewport = { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1143 };
    await d.handle({ jsonrpc: "2.0", id: 205, method: "page.screenshot", params: { tabId: 1 } });
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 206, method: "page.clickXy",
      params: { tabId: 1, x: 2000, y: 900, space: "css" },
    });
    const pressed = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
    );
    expect(pressed.params).toMatchObject({ x: 2000, y: 900 });
  });

  it("page.clickXy rejects screenshot coordinates outside the last image (likely CSS px)", async () => {
    state.debuggerState.cssViewport = { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1143 };
    await d.handle({ jsonrpc: "2.0", id: 207, method: "page.screenshot", params: { tabId: 1 } });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 208, method: "page.clickXy",
      params: { tabId: 1, x: 2000, y: 900 },
    });
    expect(resp.error?.message).toMatch(/outside the last screenshot/);
    expect(resp.error?.message).toMatch(/space:"css"/);
  });

  it("page.clickXy reports where focus settled afterwards", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 209, method: "page.clickXy",
      params: { tabId: 1, x: 10, y: 10 },
    });
    const focus = (resp.result as any).focus;
    expect(focus).toMatchObject({ tag: "div", role: "gridcell", activeDescendantName: "B3", settled: true });
  });

  // --- page.type (CDP-based) ---
  it("page.type with uid focuses and types each character as a real keystroke", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const text = "hello@test.com";
    const resp = await d.handle({
      jsonrpc: "2.0", id: 81, method: "page.type",
      params: { tabId: 1, uid: uids[1], text },
    });
    expect((resp.result as any).ok).toBe(true);
    // Real keystrokes (not Input.insertText) — required for apps that
    // bypass standard text-insertion (Office365, Excel, Sheets, Figma).
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(text.length * 2); // keyDown + keyUp per char
    expect(keyEvents[0].params.type).toBe("keyDown");
    expect(keyEvents[0].params.key).toBe("h");
    expect(keyEvents[0].params.text).toBe("h");
    expect(keyEvents[1].params.type).toBe("keyUp");
    // Reconstruct the text from the keyDown events.
    const typed = keyEvents.filter((c: any) => c.params.type === "keyDown").map((c: any) => c.params.key).join("");
    expect(typed).toBe(text);
    // No Input.insertText anymore.
    const insertCalls = state.debuggerState.commands.filter((c: any) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(0);
  });

  // page.type throws a structured, actionable error when focus verification
  // fails after escalation — the model gets diagnostic info instead of
  // silently typing into the wrong element. Excel/Sheets/Figma scenario.
  it("page.type throws with diagnostic info when focus never takes", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    // Override the Runtime.callFunctionOn stub to report focus mismatch with
    // a specific actualName, simulating Excel pinning focus on the Name Box.
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("doc.activeElement")) {
        return { result: { type: "object", value: { matches: false, actualTag: "input", actualRole: "combobox", actualName: "Casella Nome" } } };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 84, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "x", clear: false },
    });
    (globalThis as any).chrome.debugger.sendCommand = origSend;
    expect(resp.error).toBeDefined();
    expect(resp.error?.message).toMatch(/couldn't focus/i);
    expect(resp.error?.message).toMatch(/Casella Nome/);
    expect(resp.error?.message).toMatch(/blur\+click|Name Box|Cmd\+G/);
  });

  // page.focus reports the actual activeElement when focus didn't take —
  // observable signal the model can act on without seeing a thrown error.
  it("page.focus mode=js returns focused=false with actual fields when mismatch", async () => {
    const uids = await snapshotUids(1);
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("doc.activeElement")) {
        return { result: { type: "object", value: { matches: false, actualTag: "div", actualRole: "grid", actualName: "Foglio1" } } };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 85, method: "page.focus",
      params: { tabId: 1, uid: uids[1], mode: "js" },
    });
    (globalThis as any).chrome.debugger.sendCommand = origSend;
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).focused).toBe(false);
    expect((resp.result as any).modeUsed).toBe("js");
    expect((resp.result as any).actualName).toBe("Foglio1");
    expect((resp.result as any).actualRole).toBe("grid");
  });

  // page.focus mode=blur+click first blurs the active element then coordinate-clicks.
  // Strongest dislodge for apps that sticky-pin focus.
  it("page.focus mode=blur+click runs blur then dispatches a real click", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 86, method: "page.focus",
      params: { tabId: 1, uid: uids[0], mode: "blur+click" },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).focused).toBe(true);
    expect((resp.result as any).modeUsed).toBe("blur+click");
    // The handler should have issued a blur() call (matches "blur") and a
    // mouse press + release pair (the coordinate click).
    const blurCalls = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.callFunctionOn" &&
        typeof c.params?.functionDeclaration === "string" &&
        c.params.functionDeclaration.includes(".blur()"),
    );
    expect(blurCalls.length).toBeGreaterThan(0);
    const mouseDowns = state.debuggerState.commands.filter(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
    );
    expect(mouseDowns.length).toBe(1);
  });

  // Idempotent focus: page.type must not unconditionally re-focus the target.
  // Excel for the Web treats every focus() on its grid textbox as a focus
  // enter event that advances cell selection by one — consecutive page.type
  // calls between Tab presses end up scattered across cells with gaps.
  it("page.type uses idempotent focus (skips this.focus() when already active)", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 83, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "x", clear: false },
    });
    const focusCalls = state.debuggerState.commands.filter(
      (c: any) =>
        c.method === "Runtime.callFunctionOn" &&
        typeof c.params?.functionDeclaration === "string" &&
        c.params.functionDeclaration.includes("this.focus()"),
    );
    expect(focusCalls.length).toBeGreaterThan(0);
    // The focus snippet must guard with an activeElement check, not blindly call focus().
    for (const f of focusCalls) {
      expect(f.params.functionDeclaration).toMatch(/activeElement/);
    }
  });

  // page.type WITHOUT uid/selector dispatches at current focus — the
  // canonical primitive for "click a coordinate then type" virtual-canvas
  // workflows. No element resolution, no focus verification, just keystrokes.
  it("page.type without uid/selector dispatches keys at current focus (no DOM lookup)", async () => {
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 322, method: "page.type",
      params: { tabId: 1, text: "ab", clear: false },
    });
    expect((resp.result as any).ok).toBe(true);
    // No element resolution should have happened.
    const dom = state.debuggerState.commands.filter(
      (c: any) => c.method === "DOM.resolveNode" || c.method === "DOM.querySelector",
    );
    expect(dom.length).toBe(0);
    // No JS focus call either.
    const focus = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.callFunctionOn" &&
        typeof c.params?.functionDeclaration === "string" &&
        c.params.functionDeclaration.includes("focus"),
    );
    expect(focus.length).toBe(0);
    // Just keystrokes for the 2 chars (down + up each).
    const keys = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keys.length).toBe(4);
  });

  // Punctuation must NOT dispatch as virtual keys. Before this fix, "." was
  // sent with keyCode 46 — same as the Delete key — so Excel for the Web
  // interpreted it as forward-delete inside edit mode and ate every period
  // in emails, URLs, decimals, etc. Regression guard.
  it("page.type with periods uses keyCode 190 (Period), not 46 (Delete)", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 320, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "alice@example.com", clear: false },
    });
    const downs = state.debuggerState.commands.filter(
      (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown",
    );
    const period = downs.find((c: any) => c.params.text === ".");
    expect(period).toBeDefined();
    expect(period!.params.windowsVirtualKeyCode).toBe(190);
    expect(period!.params.code).toBe("Period");
    expect(period!.params.windowsVirtualKeyCode).not.toBe(46); // not Delete
    // The @ character has no deterministic punctuation entry; should send
    // windowsVirtualKeyCode 0 (avoid firing shortcut handlers).
    const at = downs.find((c: any) => c.params.text === "@");
    expect(at).toBeDefined();
    expect(at!.params.windowsVirtualKeyCode).toBe(0);
  });

  it("page.type maps common punctuation to correct virtual key codes", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 321, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: ",;'/[\\]-=", clear: false },
    });
    const downs = state.debuggerState.commands
      .filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown")
      .map((c: any) => ({ text: c.params.text, kc: c.params.windowsVirtualKeyCode, code: c.params.code }));
    const expected: Array<[string, number, string]> = [
      [",",  188, "Comma"],
      [";",  186, "Semicolon"],
      ["'",  222, "Quote"],
      ["/",  191, "Slash"],
      ["[",  219, "BracketLeft"],
      ["\\", 220, "Backslash"],
      ["]",  221, "BracketRight"],
      ["-",  189, "Minus"],
      ["=",  187, "Equal"],
    ];
    for (const [text, kc, code] of expected) {
      const got = downs.find((d: { text: string }) => d.text === text);
      expect(got, `missing keydown for ${text}`).toBeDefined();
      expect(got!.kc).toBe(kc);
      expect(got!.code).toBe(code);
    }
  });

  // \t → Tab key, \n → Enter key. Lets a single page.type call enter a
  // whole grid row or multi-line form (Excel for the Web, Google Sheets,
  // chat composers) without per-cell round-trips through the bridge.
  it("page.type expands \\t to Tab and \\n to Enter as real keys", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 82, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "a\tb\nc" },
    });
    expect((resp.result as any).ok).toBe(true);
    const downs = state.debuggerState.commands
      .filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown")
      .map((c: any) => ({ key: c.params.key, code: c.params.code }));
    expect(downs).toEqual([
      { key: "a",     code: "KeyA"  },
      { key: "Tab",   code: "Tab"   },
      { key: "b",     code: "KeyB"  },
      { key: "Enter", code: "Enter" },
      { key: "c",     code: "KeyC"  },
    ]);
  });

  // --- page.hover ---
  it("page.hover dispatches mouseMoved event", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 91, method: "page.hover",
      params: { tabId: 1, uid: uids[0] },
    });
    expect((resp.result as any).ok).toBe(true);
    const hoverEvents = state.debuggerState.commands.filter((c: any) =>
      c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseMoved"
    );
    expect(hoverEvents.length).toBe(1);
  });

  // --- page.pressKey ---
  it("page.pressKey dispatches keyDown + keyUp", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 100, method: "page.pressKey",
      params: { tabId: 1, key: "Enter" },
    });
    expect((resp.result as any).ok).toBe(true);
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(2);
    expect(keyEvents[0].params.type).toBe("keyDown");
    expect(keyEvents[1].params.type).toBe("keyUp");
    expect(keyEvents[0].params.key).toBe("Enter");
  });

  it("page.pressKey maps function keys to real virtual key codes", async () => {
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 103, method: "page.pressKey",
      params: { tabId: 1, key: "F2" },
    });
    expect((resp.result as any).ok).toBe(true);
    const keyDown = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown",
    );
    expect(keyDown.params).toMatchObject({
      key: "F2",
      code: "F2",
      windowsVirtualKeyCode: 113,
      nativeVirtualKeyCode: 113,
    });
  });

  it("page.pressKey dispatches to the focused OOPIF frame for virtual grid movement", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 101, method: "page.pressKey",
      params: { tabId: 1, key: "ArrowRight" },
    });
    expect((resp.result as any).ok).toBe(true);
    const focusChecks = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.evaluate" && c.params.expression === "document.hasFocus()",
    );
    expect(focusChecks.some((c: any) => c.target?.targetId === "grid-frame")).toBe(true);
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(2);
    expect(keyEvents[0].target).toEqual({ targetId: "grid-frame" });
    expect(keyEvents[0].params).toMatchObject({ type: "keyDown", key: "ArrowRight" });
  });

  it("page.type without uid dispatches text to the focused OOPIF frame", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 102, method: "page.type",
      params: { tabId: 1, text: "A1", clear: false },
    });
    expect((resp.result as any).ok).toBe(true);
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(4);
    expect(keyEvents.every((c: any) => c.target?.targetId === "grid-frame")).toBe(true);
    expect(keyEvents.filter((c: any) => c.params.type === "keyDown").map((c: any) => c.params.key)).toEqual(["A", "1"]);
  });

  it("page.type requireEmpty refuses to overwrite non-empty active descendants", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 105, method: "page.type",
      params: { tabId: 1, text: "replacement", requireEmpty: true },
    });
    expect(resp.error?.message).toMatch(/requireEmpty refused/i);
    expect(resp.error?.message).toContain("cell-r3-c2");
    expect(resp.error?.message).toContain("existing");
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(0);
  });

  it("page.focusState reports active element state from the focused OOPIF frame", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 104, method: "page.focusState",
      params: { tabId: 1 },
    });
    expect((resp.result as any)).toMatchObject({
      ok: true,
      targetId: "grid-frame",
      documentHasFocus: true,
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
  });

  // --- page.fillForm ---
  it("page.fillForm fills multiple fields in one call", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 111, method: "page.fillForm",
      params: {
        tabId: 1,
        fields: [
          { uid: uids[0], value: "Alice" },
          { uid: uids[1], value: "alice@example.com" },
        ],
      },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).filledCount).toBe(2);
    // Real keystrokes per char across both fields: "Alice" + "alice@example.com"
    // = 22 chars × 2 events (keyDown + keyUp).
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(("Alice".length + "alice@example.com".length) * 2);
    const insertCalls = state.debuggerState.commands.filter((c: any) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(0);
  });

  // --- page.scroll ---
  it("page.scroll to=bottom passes correct args", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 33, method: "page.scroll",
      params: { tabId: 1, to: "bottom" },
    });
    expect((resp.result as any).ok).toBe(true);
  });

  it("page.scroll rejects params that mix dy + selector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 34, method: "page.scroll",
      params: { tabId: 1, dy: 100, selector: "#x" },
    });
    expect(resp.error?.message).toMatch(/exactly one/i);
  });

  // --- page.evalJs ---
  it("page.evalJs forwards to Runtime.evaluate", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 40, method: "page.evalJs",
      params: { tabId: 1, expression: "document.title" },
    });
    const cmd = state.debuggerState.commands.find((c: any) => c.method === "Runtime.evaluate");
    expect(cmd).toBeDefined();
    expect(cmd.params.expression).toBe("document.title");
    expect((resp.result as any).type).toBe("string");
  });

  it("page.evalJs returns {type:'exception', exception} on exceptionDetails", async () => {
    const origSendCommand = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (_target: any, method: string, params: any) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object" }, exceptionDetails: { text: "Uncaught ReferenceError" } };
      }
      // Delegate everything else to original.
      return origSendCommand(_target, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 41, method: "page.evalJs",
      params: { tabId: 1, expression: "nope()" },
    });
    expect((resp.result as any).type).toBe("exception");
    expect((resp.result as any).exception).toMatch(/ReferenceError/);
    // Restore.
    (globalThis as any).chrome.debugger.sendCommand = origSendCommand;
  });

  // --- console / network ---
  it("console.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 42, method: "console.read",
      params: { tabId: 2 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
    expect((globalThis as any).chrome.debugger.attach).toHaveBeenCalled();
  });

  it("network.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 43, method: "network.read",
      params: { tabId: 3 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
  });

  it("session.claim sets the toolbar badge when overlay injection fails", async () => {
    const spy = (globalThis as any).chrome.scripting.executeScript as ReturnType<typeof vi.fn>;
    spy.mockImplementationOnce(async () => { throw new Error("CSP blocked"); });

    await d.handle({ jsonrpc: "2.0", id: 50, method: "session.claim", params: { tabId: 1 } });

    const badge = (globalThis as any).chrome.action.setBadgeText as ReturnType<typeof vi.fn>;
    expect(badge).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1, text: "●" }));
  });

  // --- page.handleDialog ---
  it("page.handleDialog returns handled=false when no dialog pending", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 200, method: "page.handleDialog",
      params: { tabId: 1, action: "accept" },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).handled).toBe(false);
  });

  // --- page.select ---
  it("page.select calls Runtime.callFunctionOn on a resolved element", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 210, method: "page.select",
      params: { tabId: 1, uid: uids[0], values: ["opt1"] },
    });
    expect((resp.result as any).ok).toBe(true);
    const fnCalls = state.debuggerState.commands.filter((c: any) => c.method === "Runtime.callFunctionOn");
    expect(fnCalls.length).toBeGreaterThanOrEqual(1);
  });

  // --- page.uploadFile ---
  it("page.uploadFile calls DOM.setFileInputFiles with the given paths", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 220, method: "page.uploadFile",
      params: { tabId: 1, uid: uids[0], filePaths: ["/tmp/a.png"] },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).uploadedCount).toBe(1);
    const sffiCalls = state.debuggerState.commands.filter((c: any) => c.method === "DOM.setFileInputFiles");
    expect(sffiCalls.length).toBe(1);
    expect(sffiCalls[0].params.files).toEqual(["/tmp/a.png"]);
  });

  // --- cross-extension fallback in page.type ---
  it("page.type falls back to coordinate click when focus hits 'chrome-extension://' error", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("focus()")) {
        throw new Error("Cannot access a chrome-extension:// URL of different extension");
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 300, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "secret123" },
    });
    // Should succeed via fallback
    expect((resp.result as any).ok).toBe(true);
    // Real keystrokes must still have run after the coordinate-click fallback.
    const calls = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls.map((a: any[]) => a[1]);
    expect(calls).toContain("Input.dispatchKeyEvent");
    // Coordinate-click (mousePressed + mouseReleased) must have been used
    const mouseEvents = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls
      .filter((a: any[]) => a[1] === "Input.dispatchMouseEvent")
      .map((a: any[]) => a[2].type);
    expect(mouseEvents).toContain("mousePressed");
    expect(mouseEvents).toContain("mouseReleased");
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  it("page.type surfaces a human-readable error when cross-extension blocks everything", async () => {
    const uids = await snapshotUids(1);
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (_t: any, method: string, _p: any) => {
      if (method === "Runtime.enable" || method === "Network.enable" || method === "Accessibility.enable" || method === "Page.enable") return {};
      throw new Error("Cannot access a chrome-extension:// URL of different extension");
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 301, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "x" },
    });
    expect(resp.error?.message).toMatch(/interaction blocked by another Chrome extension/i);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- DebuggerManager retry broadened ---
  it("sendCommand retries once on 'Detached while handling command'", async () => {
    // Re-use the pending pair manager indirectly via any CDP-using handler.
    let calls = 0;
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Accessibility.getFullAXTree") {
        calls++;
        if (calls === 1) throw new Error("Detached while handling command.");
        return origSend(t, method, params);
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({ jsonrpc: "2.0", id: 310, method: "page.snapshot", params: { tabId: 1 } });
    expect(resp.error).toBeUndefined();
    expect(calls).toBe(2);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- page.drag ---
  // --- page.fetch ---
  it("page.fetch runs Runtime.evaluate with a fetch() wrapper and returns the in-page response", async () => {
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("await fetch(cfg.url")) {
        return {
          result: {
            type: "object",
            value: {
              ok: true, status: 200, statusText: "OK",
              headers: { "content-type": "application/json" },
              body: { id: 42 }, json: true, truncated: false, finalUrl: "https://x/api/y",
            },
          },
        };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 500, method: "page.fetch",
      params: { tabId: 1, url: "/api/y", method: "POST", body: { q: 1 } },
    });
    const r = resp.result as any;
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.json).toBe(true);
    expect(r.body).toEqual({ id: 42 });
    // Ensure the body we embedded in the expression was stringified JSON
    const evalCall = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls
      .find((a: any[]) => a[1] === "Runtime.evaluate");
    expect(evalCall[2].expression).toContain('"method":"POST"');
    expect(evalCall[2].expression).toContain('"body":"{\\"q\\":1}"');
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  it("page.fetch surfaces an in-page fetch failure via _error", async () => {
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("await fetch(cfg.url")) {
        return {
          result: {
            type: "object",
            value: {
              ok: false, status: 0, statusText: "",
              headers: {}, body: null, json: false, truncated: false,
              finalUrl: "/api/y", _error: "NetworkError: Failed to fetch",
            },
          },
        };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 501, method: "page.fetch",
      params: { tabId: 1, url: "/api/y" },
    });
    expect(resp.error?.message).toMatch(/NetworkError|failed/i);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- page.drag ---
  it("page.drag dispatches press + moves + release mouse events", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 230, method: "page.drag",
      params: { tabId: 1, fromUid: uids[0], toUid: uids[1], steps: 5 },
    });
    expect((resp.result as any).ok).toBe(true);
    const mouseEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent");
    const pressed = mouseEvents.filter((c: any) => c.params.type === "mousePressed");
    const moved = mouseEvents.filter((c: any) => c.params.type === "mouseMoved");
    const released = mouseEvents.filter((c: any) => c.params.type === "mouseReleased");
    expect(pressed.length).toBe(1);
    expect(moved.length).toBe(5);
    expect(released.length).toBe(1);
  });

  // --- actionability gate on click/type ---
  it("page.click throws when the target is not actionable (hidden)", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.actionable = { ok: false, reason: "hidden" };
    // Small timeoutMs makes the gate fail fast — no fake timers needed.
    const resp = await d.handle({
      jsonrpc: "2.0", id: 300, method: "page.click",
      params: { tabId: 1, uid: uids[0], timeoutMs: 120 },
    });
    expect(resp.error?.message).toMatch(/not actionable: hidden/);
  });

  it("page.click with force=true bypasses the actionability gate", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.actionable = { ok: false, reason: "hidden" };
    const resp = await d.handle({
      jsonrpc: "2.0", id: 301, method: "page.click",
      params: { tabId: 1, uid: uids[0], force: true },
    });
    expect((resp.result as any).ok).toBe(true);
  });

  it("page.type with force=true types into a not-yet-actionable element", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.actionable = { ok: false, reason: "hidden" };
    const resp = await d.handle({
      jsonrpc: "2.0", id: 302, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "hi", force: true },
    });
    expect((resp.result as any).ok).toBe(true);
  });

  // --- page.type modifiers (chords) ---
  it("page.type with modifiers sets the modifier flag on dispatched keys", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    await d.handle({
      jsonrpc: "2.0", id: 310, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "a", modifiers: ["Control"], clear: false },
    });
    const keys = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.code === "KeyA");
    expect(keys.length).toBeGreaterThan(0);
    // Control flag = 2.
    expect(keys[0].params.modifiers).toBe(2);
  });

  // --- page.scroll wheel mode ---
  it("page.scroll wheel mode dispatches a mouseWheel event with the deltas", async () => {
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 320, method: "page.scroll",
      params: { tabId: 1, mode: "wheel", dy: 500 },
    });
    expect((resp.result as any).ok).toBe(true);
    const wheel = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseWheel");
    expect(wheel.length).toBe(1);
    expect(wheel[0].params.deltaY).toBe(500);
  });

  // --- page.paste ---
  it("page.paste on Windows/Linux sends Ctrl+V without macOS editing commands and verifies delivery", async () => {
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 330, method: "page.paste",
      params: { tabId: 1, text: "Alice\t30\nBob\t25" },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).bytesWritten).toBe("Alice\t30\nBob\t25".length);
    expect((resp.result as any).pasteDelivered).toBe(true);
    expect((resp.result as any).pasteHandledByPage).toBe(true);
    const clip = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.evaluate" &&
        typeof c.params?.expression === "string" &&
        c.params.expression.includes("clipboard"),
    );
    expect(clip.length).toBeGreaterThan(0);
    // Clipboard write runs with a user gesture so the async Clipboard API / copy command is allowed.
    expect(clip.some((c: any) => c.params.userGesture === true)).toBe(true);
    const vKeys = state.debuggerState.commands.filter(
      (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.code === "KeyV",
    );
    expect(vKeys.length).toBe(2); // keyDown + keyUp
    expect(vKeys[0].params.modifiers).toBe(2); // Control
    expect(vKeys[0].params.commands).toBeUndefined();
    expect(vKeys[0].params.text).toBeUndefined(); // a chord, not a "v"
  });

  it("page.paste on macOS sends Cmd+V carrying the Blink 'paste' editing command", async () => {
    (globalThis as any).chrome.runtime = { getPlatformInfo: vi.fn(async () => ({ os: "mac" })) };
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 331, method: "page.paste",
      params: { tabId: 1, text: "x\ty" },
    });
    expect((resp.result as any).ok).toBe(true);
    const down = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.code === "KeyV" && c.params.type === "keyDown",
    );
    expect(down.params.modifiers).toBe(4); // Meta
    expect(down.params.commands).toEqual(["paste"]);
  });

  it("page.paste throws instead of reporting success when no paste event reached the page", async () => {
    state.debuggerState.pasteProbe = { fired: false, prevented: null, target: null };
    const resp = await d.handle({
      jsonrpc: "2.0", id: 332, method: "page.paste",
      params: { tabId: 1, text: "nope" },
    });
    expect(resp.error?.message).toMatch(/no paste event reached/);
    expect(resp.error?.message).toMatch(/Ctrl\+V/);
  }, 10_000);

  it("page.paste fails loudly when the clipboard can't be written", async () => {
    state.debuggerState.clipboardVia = "failed";
    const resp = await d.handle({
      jsonrpc: "2.0", id: 333, method: "page.paste",
      params: { tabId: 1, text: "nope" },
    });
    expect(resp.error?.message).toMatch(/couldn't write to the clipboard/);
    const vKeys = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(vKeys.length).toBe(0);
  });

  it("page.paste arms its probe and writes the clipboard in the focused OOPIF frame", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 334, method: "page.paste", params: { tabId: 1, text: "a\tb" } });
    const inFrame = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.evaluate" && c.target?.targetId === "grid-frame" &&
        (c.params.expression.includes("__chromanchePasteProbe") || c.params.expression.includes("navigator.clipboard")),
    );
    expect(inFrame.length).toBeGreaterThanOrEqual(3); // arm, write, read (+ dispose)
    const v = state.debuggerState.commands.find((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.code === "KeyV");
    expect(v.target).toEqual({ targetId: "grid-frame" });
  });

  it("page.paste target=xy converts screenshot coordinates before clicking", async () => {
    state.debuggerState.cssViewport = { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1143 };
    await d.handle({ jsonrpc: "2.0", id: 335, method: "page.screenshot", params: { tabId: 1 } });
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 336, method: "page.paste", params: { tabId: 1, text: "a", target: "xy", x: 100, y: 100 } });
    const pressed = state.debuggerState.commands.find(
      (c: any) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
    );
    expect(pressed.params.x).toBeCloseTo(100 * (2560 / 1568), 1);
  });

  // --- multi-OS keyboard ---
  it("page.pressKey ControlOrMeta resolves to Control on Windows/Linux", async () => {
    (globalThis as any).chrome.runtime = { getPlatformInfo: vi.fn(async () => ({ os: "win" })) };
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 337, method: "page.pressKey", params: { tabId: 1, key: "a", modifiers: ["ControlOrMeta"] } });
    const down = state.debuggerState.commands.find((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(down.params.modifiers).toBe(2);
    expect(down.params.commands).toBeUndefined();
  });

  it("page.pressKey ControlOrMeta resolves to Meta + selectAll command on macOS", async () => {
    (globalThis as any).chrome.runtime = { getPlatformInfo: vi.fn(async () => ({ os: "mac" })) };
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 338, method: "page.pressKey", params: { tabId: 1, key: "a", modifiers: ["ControlOrMeta"] } });
    const down = state.debuggerState.commands.find((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(down.params.modifiers).toBe(4);
    expect(down.params.commands).toEqual(["selectAll"]);
    expect(down.params.text).toBeUndefined();
  });

  it("page.pressKey Meta+z on macOS carries the undo command; Shift+Meta+z carries redo", async () => {
    (globalThis as any).chrome.runtime = { getPlatformInfo: vi.fn(async () => ({ os: "mac" })) };
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 339, method: "page.pressKey", params: { tabId: 1, key: "z", modifiers: ["Meta"] } });
    await d.handle({ jsonrpc: "2.0", id: 340, method: "page.pressKey", params: { tabId: 1, key: "z", modifiers: ["Meta", "Shift"] } });
    const downs = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(downs[0].params.commands).toEqual(["undo"]);
    expect(downs[1].params.commands).toEqual(["redo"]);
  });

  it("page.pressKey maps single punctuation to its real virtual key (\".\" is Period, not Delete)", async () => {
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 341, method: "page.pressKey", params: { tabId: 1, key: "." } });
    const down = state.debuggerState.commands.find((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(down.params).toMatchObject({ code: "Period", windowsVirtualKeyCode: 190, text: "." });
  });

  it("page.pressKey returns the settled focus summary", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 342, method: "page.pressKey", params: { tabId: 1, key: "Tab" } });
    expect((resp.result as any).focus).toMatchObject({ tag: "div", settled: true });
    const none = await d.handle({ jsonrpc: "2.0", id: 343, method: "page.pressKey", params: { tabId: 1, key: "Tab", settle: false } });
    expect((none.result as any).focus).toBeUndefined();
  });

  // --- clearing through real input ---
  it("page.type clear=true empties an input by selecting it and pressing Backspace (no value assignment)", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.clearKind = "input";
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 344, method: "page.type", params: { tabId: 1, uid: uids[1], text: "new" } });
    expect((resp.result as any).ok).toBe(true);
    const downs = state.debuggerState.commands
      .filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown")
      .map((c: any) => c.params.key);
    expect(downs).toEqual(["Backspace", "n", "e", "w"]);
    const assignments = state.debuggerState.commands.filter(
      (c: any) => c.method === "Runtime.callFunctionOn" &&
        /this\.value\s*=\s*''|textContent\s*=\s*''/.test(c.params?.functionDeclaration ?? ""),
    );
    expect(assignments.length).toBe(0);
  });

  it("page.type clear=true on a contenteditable uses the platform select-all shortcut first", async () => {
    (globalThis as any).chrome.runtime = { getPlatformInfo: vi.fn(async () => ({ os: "linux" })) };
    const uids = await snapshotUids(1);
    state.debuggerState.clearKind = "editable";
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 345, method: "page.type", params: { tabId: 1, uid: uids[1], text: "x" } });
    const downs = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(downs[0].params).toMatchObject({ key: "a", modifiers: 2 }); // Ctrl+A on Linux
    expect(downs[1].params.key).toBe("Backspace");
    expect(downs[2].params.key).toBe("x");
  });

  it("page.type refuses to type when the field could not be cleared (no silent prepend)", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.clearKind = "editable";
    state.debuggerState.textAfterClear = "s3";
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 346, method: "page.type", params: { tabId: 1, uid: uids[1], text: "via-fbar" } });
    expect(resp.error?.message).toMatch(/couldn't clear the field/);
    expect(resp.error?.message).toContain("s3");
    const typed = state.debuggerState.commands.filter(
      (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown" && c.params.key === "v",
    );
    expect(typed.length).toBe(0);
  });

  // --- generic typed-text fidelity ---
  async function withFocusOverride(override: Record<string, unknown>, fn: () => Promise<void>) {
    const orig = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      const r = await orig(t, method, params);
      if (method === "Runtime.evaluate" && typeof params?.expression === "string" &&
          params.expression.includes("activeElement") && r?.result?.type === "object") {
        return { result: { type: "object", value: { ...r.result.value, ...override } } };
      }
      return r;
    });
    try { await fn(); } finally { (globalThis as any).chrome.debugger.sendCommand = orig; }
  }

  it("page.type requireEmpty only judges values/text — an accessible name alone is not content", async () => {
    await withFocusOverride({
      activeText: undefined, activeDescendant: "cell-readout",
      activeDescendantText: undefined, activeDescendantValue: undefined, activeDescendantName: "something . B2 .",
    }, async () => {
      const resp = await d.handle({ jsonrpc: "2.0", id: 347, method: "page.type", params: { tabId: 1, text: "x", requireEmpty: true } });
      expect((resp.result as any).ok).toBe(true);
    });
  });

  it("page.type drops an inline auto-completion so the field holds exactly the typed text", async () => {
    await attachFocusedFrame();
    state.debuggerState.fieldTexts = ["", "Apple", "Ap"]; // before typing, after typing, after Delete
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 348, method: "page.type", params: { tabId: 1, text: "Ap" } });
    expect((resp.result as any).completion).toEqual({ typed: "Ap", fieldShowed: "Apple", removed: true, fieldNow: "Ap" });
    const downs = state.debuggerState.commands
      .filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown")
      .map((c: any) => c.params.key);
    expect(downs).toEqual(["A", "p", "Delete"]);
    // Everything went to the focused frame.
    const keys = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keys.every((c: any) => c.target?.targetId === "grid-frame")).toBe(true);
  });

  it("page.type leaves text alone when the field already had content (caret position unknown)", async () => {
    state.debuggerState.fieldTexts = ["Hello ", "Hello Apple"];
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 349, method: "page.type", params: { tabId: 1, text: "Ap" } });
    expect((resp.result as any).completion).toBeUndefined();
    const downs = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(downs.map((c: any) => c.params.key)).toEqual(["A", "p"]);
  });

  it("page.type exact:false keeps an inline auto-completion", async () => {
    state.debuggerState.fieldTexts = ["", "Apple"];
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 350, method: "page.type", params: { tabId: 1, text: "Ap", exact: false } });
    expect((resp.result as any).completion).toBeUndefined();
    const del = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Delete");
    expect(del.length).toBe(0);
  });

  it("page.type skips the completion check for multi-field text (\\t / \\n move focus)", async () => {
    state.debuggerState.fieldTexts = ["", "Apple"];
    const resp = await d.handle({ jsonrpc: "2.0", id: 351, method: "page.type", params: { tabId: 1, text: "Ap\tb" } });
    expect((resp.result as any).completion).toBeUndefined();
  });

  it("page.type (uid path) drops an inline completion in the element it typed into", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.elementFieldTexts = ["", "Apple", "Ap"];
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 352, method: "page.type", params: { tabId: 1, uid: uids[1], text: "Ap" } });
    expect((resp.result as any).completion).toMatchObject({ fieldShowed: "Apple", removed: true });
  });

  it("page.type reports a suggestion list the typing opened (and only that one)", async () => {
    state.debuggerState.popupsBeforeKeys = [{ role: "dialog", label: "Always there" }];
    state.debuggerState.popupsAfterKeys = [{ role: "dialog", label: "Always there" }, { role: "listbox", items: 3 }];
    const resp = await d.handle({ jsonrpc: "2.0", id: 353, method: "page.type", params: { tabId: 1, text: "Ap" } });
    expect((resp.result as any).focus.popups).toEqual([{ role: "listbox", items: 3 }]);
  });

  it("page.pressKey reports popups that the key opened, plus aria-expanded", async () => {
    state.debuggerState.popupsBeforeKeys = [];
    state.debuggerState.popupsAfterKeys = [{ role: "menu", items: 12 }];
    state.debuggerState.expandedAfterKeys = "true";
    const resp = await d.handle({ jsonrpc: "2.0", id: 354, method: "page.pressKey", params: { tabId: 1, key: "ArrowDown" } });
    expect((resp.result as any).focus).toMatchObject({ popups: [{ role: "menu", items: 12 }], expanded: true });
  });

  // --- frame targeting ---
  it("page.evalJs frame=focused evaluates inside the focused OOPIF and labels the frame", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    const resp = await d.handle({ jsonrpc: "2.0", id: 349, method: "page.evalJs", params: { tabId: 1, expression: "1+1", frame: "focused" } });
    const ev = state.debuggerState.commands.find((c: any) => c.method === "Runtime.evaluate" && c.params.expression === "1+1");
    expect(ev.target).toEqual({ targetId: "grid-frame" });
    expect((resp.result as any).frame).toBe("https://grid.example/");
  });

  it("page.evalJs frame=<regex> picks the frame whose LIVE url matches", async () => {
    await attachFocusedFrame();
    state.debuggerState.frameUrls["grid-frame"] = "https://editor.app.example/frame.aspx?lang=it-IT";
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 350, method: "page.evalJs", params: { tabId: 1, expression: "2+2", frame: "editor\\.app\\.example" } });
    const ev = state.debuggerState.commands.find((c: any) => c.method === "Runtime.evaluate" && c.params.expression === "2+2");
    expect(ev.target).toEqual({ targetId: "grid-frame" });
  });

  it("page.evalJs frame=<regex> with no match lists the frames it saw", async () => {
    await attachFocusedFrame();
    const resp = await d.handle({ jsonrpc: "2.0", id: 351, method: "page.evalJs", params: { tabId: 1, expression: "1", frame: "nomatch\\.example" } });
    expect(resp.error?.message).toMatch(/no frame URL matches/);
    expect(resp.error?.message).toContain("grid.example");
  });

  it("page.wait function mode honours frame", async () => {
    await attachFocusedFrame();
    state.debuggerState.commands = [];
    await d.handle({ jsonrpc: "2.0", id: 352, method: "page.wait", params: { tabId: 1, for: "function", expression: "true", frame: "focused", timeoutMs: 500 } });
    const ev = state.debuggerState.commands.find((c: any) => c.method === "Runtime.evaluate" && c.params.expression === "true");
    expect(ev.target).toEqual({ targetId: "grid-frame" });
  });

  // --- stable uids ---
  it("page.snapshot keeps the same uid for the same DOM node across snapshots", async () => {
    const first = await snapshotUids(11);
    state.debuggerState.extraAxNode = true;
    const second = await snapshotUids(11);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.length).toBe(first.length + 1);
    // ...so a uid from the first snapshot still resolves after a since:"last" diff.
    const diff = await d.handle({ jsonrpc: "2.0", id: 353, method: "page.snapshot", params: { tabId: 11, since: "last" } });
    expect((diff.result as any).diff).toEqual({ added: 0, removed: 0 });
    const click = await d.handle({ jsonrpc: "2.0", id: 354, method: "page.click", params: { tabId: 11, uid: first[1] } });
    expect((click.result as any).ok).toBe(true);
  });

  // --- page.wait ---
  it("page.wait function mode resolves when the expression becomes truthy", async () => {
    // Use the default Runtime.evaluate fake (returns truthy "ok") so it resolves immediately.
    const resp = await d.handle({
      jsonrpc: "2.0", id: 340, method: "page.wait",
      params: { tabId: 1, for: "function", expression: "true", timeoutMs: 500, pollMs: 50 },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).matched).toBe(true);
  });

  it("page.wait selector mode times out when the element never appears", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 341, method: "page.wait",
      params: { tabId: 1, for: "selector", selector: "#never", timeoutMs: 150, pollMs: 50 },
    });
    expect(resp.error?.message).toMatch(/timed out/);
  });

  it("page.wait text mode resolves when the text is present", async () => {
    state.debuggerState.textPresent = true;
    const resp = await d.handle({
      jsonrpc: "2.0", id: 342, method: "page.wait",
      params: { tabId: 1, for: "text", text: "Payment complete", timeoutMs: 500, pollMs: 50 },
    });
    expect((resp.result as any).matched).toBe(true);
  });

  it("page.wait text mode times out when the text never appears", async () => {
    state.debuggerState.textPresent = false;
    const resp = await d.handle({
      jsonrpc: "2.0", id: 343, method: "page.wait",
      params: { tabId: 1, for: "text", text: "Nope", timeoutMs: 150, pollMs: 50 },
    });
    expect(resp.error?.message).toMatch(/timed out/);
  });

  it("page.wait text mode with state=hidden resolves when the text is absent", async () => {
    state.debuggerState.textPresent = false;
    const resp = await d.handle({
      jsonrpc: "2.0", id: 344, method: "page.wait",
      params: { tabId: 1, for: "text", text: "Spinner", state: "hidden", timeoutMs: 500, pollMs: 50 },
    });
    expect((resp.result as any).matched).toBe(true);
  });

  // --- page.waitForDownload (observational) ---
  it("page.waitForDownload resolves on a completed download armed after the call", async () => {
    const downloads = (globalThis as any).chrome.downloads;
    const promise = d.handle({
      jsonrpc: "2.0", id: 350, method: "page.waitForDownload",
      params: { timeoutMs: 1000 },
    });
    // Simulate Chrome creating then completing a download AFTER we armed.
    await Promise.resolve();
    const item = { id: 42, filename: "/Users/me/Downloads/export.xlsx", fileSize: 2048, mime: "application/x", finalUrl: "https://x/export", url: "https://x/export", state: "complete" };
    downloads._items.set(42, item);
    for (const l of downloads._created) l(item);
    for (const l of downloads._changed) l({ id: 42, state: { current: "complete" } });
    const resp = await promise;
    expect((resp.result as any).filename).toBe("export.xlsx");
    expect((resp.result as any).path).toBe("/Users/me/Downloads/export.xlsx");
    expect((resp.result as any).bytes).toBe(2048);
  });

  it("page.waitForDownload ignores downloads it didn't see created (pre-existing history)", async () => {
    const downloads = (globalThis as any).chrome.downloads;
    const promise = d.handle({
      jsonrpc: "2.0", id: 351, method: "page.waitForDownload",
      params: { timeoutMs: 200 },
    });
    await Promise.resolve();
    // A completed download whose id was NEVER announced via onCreated → must be ignored.
    downloads._items.set(7, { id: 7, filename: "/Users/me/Downloads/old.pdf", fileSize: 10, state: "complete" });
    for (const l of downloads._changed) l({ id: 7, state: { current: "complete" } });
    const resp = await promise;
    expect(resp.error?.message).toMatch(/timed out/);
  });
});

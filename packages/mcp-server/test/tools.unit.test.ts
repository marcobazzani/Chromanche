import { describe, expect, it, vi } from "vitest";
import { buildTools, PageBatchParamsSchema } from "../src/tools.js";

const fakeBridge = () => {
  const calls: Array<{ method: string; params: unknown; profile?: string }> = [];
  return {
    calls,
    bridge: {
      listProfiles: vi.fn(() => [
        { tag: "work", label: "Work", connectedAt: 1000 },
        { tag: "personal", label: "Personal", connectedAt: 2000 },
      ]),
      call: vi.fn(async (method: string, params: unknown, profile?: string) => {
        calls.push({ method, params, profile });
        if (method === "tabs.list") return [{ tabId: 1, url: "https://a", title: "a", active: true }];
        if (method === "tabs.create") return { tabId: 2, url: (params as any).url, title: "", active: true };
        if (method === "page.navigate") return { ok: true, finalUrl: (params as any).url };
        if (method === "session.claim") return { ok: true, groupId: 7 };
        if (method === "page.snapshot") return { mode: "a11y", url: "https://x", title: "x", content: "[e0] button \"Go\"", truncated: false };
        if (method === "page.screenshot") return { format: "png", base64: "aGk=" };
        if (method === "tabs.close")      return { ok: true };
        if (method === "tabs.activate")   return { ok: true };
        if (method === "session.release") return { ok: true };
        if (method === "page.click")      return { ok: true };
        if (method === "page.clickXy")    return { ok: true };
        if (method === "page.type")       return { ok: true };
        if (method === "page.paste")       return { ok: true, bytesWritten: ((params as any)?.text ?? "").length };
        if (method === "page.scroll")     return { ok: true };
        if (method === "page.wait")        return { ok: true, matched: true, waitedMs: 12 };
        if (method === "page.waitForDownload") return { ok: true, filename: "export.xlsx", path: "/Users/me/Downloads/export.xlsx", bytes: 2048, mime: "application/vnd...", finalUrl: "https://x/export" };
        if (method === "page.hover")      return { ok: true };
        if (method === "page.focus")      return { ok: true, focused: true, modeUsed: (params as any)?.mode === "auto" || !(params as any)?.mode ? "js" : (params as any).mode };
        if (method === "page.pressKey")   return { ok: true };
        if (method === "page.focusState") return { ok: true, url: "https://grid.example/", title: "Grid", documentHasFocus: true, activeTag: "div", activeRole: "gridcell", activeName: "Row 3 Column 2" };
        if (method === "page.fillForm")   return { ok: true, filledCount: 2 };
        if (method === "page.handleDialog") return { ok: true, handled: true, dialogType: "alert", dialogMessage: "hi" };
        if (method === "page.select")     return { ok: true, selected: ["opt1"] };
        if (method === "page.uploadFile") return { ok: true, uploadedCount: 1 };
        if (method === "page.drag")       return { ok: true };
        if (method === "page.fetch")      return { ok: true, status: 200, statusText: "OK", headers: {}, body: { hello: "world" }, json: true, truncated: false, finalUrl: "https://x/api" };
        if (method === "page.evalJs")    return { type: "string", value: "hi" };
        if (method === "console.read")   return [{ ts: 1, level: "error", text: "boom" }];
        if (method === "network.read")   return [{ ts: 1, method: "GET", url: "https://a", type: "Document", status: 200, durationMs: 12 }];
        if (method === "network.getRequest") return { method: "POST", url: "https://a/api", status: 500, requestHeaders: {}, responseHeaders: { "content-type": "application/json" }, body: "{\"e\":1}", base64Encoded: false, truncated: false };
        throw new Error("unexpected method " + method);
      }),
      isConnected: () => true,
    } as any,
  };
};

describe("tool adapters", () => {
  it("tabs_list forwards with empty params and returns the wire result", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.tabs_list.handler({});
    expect(calls).toEqual([{ method: "tabs.list", params: {} }]);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse((result.content[0] as any).text)).toEqual([
      { tabId: 1, url: "https://a", title: "a", active: true },
    ]);
  });

  it("tabs_create passes url through", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_create.handler({ url: "https://example.com" });
    expect(calls[0]).toEqual({
      method: "tabs.create",
      params: { url: "https://example.com", active: true },
    });
  });

  it("page_navigate auto-claims the tab (calls session.claim first)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_navigate.handler({ tabId: 2, url: "https://example.com" });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.navigate"]);
  });

  it("fails fast when bridge has no extension", async () => {
    const { bridge } = fakeBridge();
    (bridge as any).isConnected = () => false;
    const tools = buildTools(bridge);
    await expect(tools.tabs_list.handler({})).rejects.toThrow(/extension/i);
  });

  it("appends the configured pairing help (WSL) to the no-extension error", async () => {
    const { bridge } = fakeBridge();
    (bridge as any).isConnected = () => false;
    const tools = buildTools(bridge, { notConnectedHelp: "Pair by hand: set Port to 48765" });
    await expect(tools.page_navigate.handler({ tabId: 1, url: "https://example.com" })).rejects.toThrow(
      /^no extension connected[^\n]*\n\nPair by hand: set Port to 48765$/,
    );
    // page_batch guards up front too, so batches surface the same help.
    await expect(tools.page_batch.handler({ steps: [{ tool: "tabs_list", args: {} }] } as any)).rejects.toThrow(
      /Pair by hand: set Port to 48765/,
    );
  });

  it("tabs_create auto-claims the newly created tab", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_create.handler({ url: "https://example.com" });
    expect(calls.map((c) => c.method)).toEqual(["tabs.create", "session.claim"]);
    expect((calls[1]!.params as any).tabId).toBe(2);
  });

  it("page_snapshot auto-claims and forwards params", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_snapshot.handler({ tabId: 5 });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.snapshot"]);
  });

  it("page_screenshot returns MCP image content so multimodal models see the pixels", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.page_screenshot.handler({ tabId: 5 });
    // First item: image. The model receives this as a renderable image.
    const img = result.content.find((c: any) => c.type === "image") as any;
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/png");
    expect(typeof img.data).toBe("string");
    expect(img.data.length).toBeGreaterThan(0);
    // Companion text item carries lightweight metadata, not the bytes.
    const meta = result.content.find((c: any) => c.type === "text") as any;
    const parsedMeta = JSON.parse(meta.text);
    expect(parsedMeta.format).toBe("png");
    expect(typeof parsedMeta.byteLength).toBe("number");
    // Critically: base64 is NOT in the text item — it lives in the image item.
    expect(parsedMeta.base64).toBeUndefined();
  });

  it("page_navigate does not re-claim an already-claimed tab", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_navigate.handler({ tabId: 5, url: "https://a" });
    await tools.page_navigate.handler({ tabId: 5, url: "https://b" });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["session.claim", "page.navigate", "page.navigate"]);
  });

  it("tabs_close does NOT auto-claim (no session.claim call)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_close.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["tabs.close"]);
  });

  it("tabs_activate does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_activate.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["tabs.activate"]);
  });

  it("session_release does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.session_release.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["session.release"]);
  });

  it("page_click auto-claims and forwards uid", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, uid: "e42" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.click"]);
    expect((calls[1]!.params as any).uid).toBe("e42");
  });

  it("page_click auto-claims and forwards selector", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, selector: "#go" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.click"]);
    expect((calls[1]!.params as any).selector).toBe("#go");
    expect((calls[1]!.params as any).button).toBe("left");
  });

  it("page_type auto-claims and forwards uid + text", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_type.handler({ tabId: 7, uid: "e5", text: "hi" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.type"]);
    expect((calls[1]!.params as any).uid).toBe("e5");
    expect((calls[1]!.params as any).submit).toBe(false);
  });

  it("page_scroll auto-claims and forwards a selector scroll target", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_scroll.handler({ tabId: 7, selector: "#footer" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.scroll"]);
  });

  it("page_scroll rejects params with no scroll target", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    await expect(tools.page_scroll.handler({ tabId: 7 } as any)).rejects.toThrow();
  });

  it("page_scroll wheel mode forwards dx/dy", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_scroll.handler({ tabId: 7, mode: "wheel", dy: 600 });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.scroll"]);
    expect((calls[1]!.params as any).mode).toBe("wheel");
    expect((calls[1]!.params as any).dy).toBe(600);
  });

  it("page_paste auto-claims and forwards text + target", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_paste.handler({ tabId: 5, text: "Alice\t30\nBob\t25", target: "current" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.paste"]);
    expect((calls[1]!.params as any).text).toContain("Alice");
  });

  it("page_paste composes inside page_batch", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click_xy", args: { tabId: 1, x: 75, y: 156 } },
        { tool: "page_paste",    args: { tabId: 1, text: "x\ty\nz\tw" } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s: any) => s.tool)).toEqual(["page_click_xy", "page_paste"]);
  });

  it("page_wait uid mode claims then forwards", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_wait.handler({ tabId: 7, for: "uid", uid: "e7" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.wait"]);
  });

  it("page_wait response mode is observational — does NOT claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_wait.handler({ tabId: 7, for: "response", urlPattern: "/api/save" });
    expect(calls.map(c => c.method)).toEqual(["page.wait"]);
  });

  it("page_wait text mode claims then forwards the text", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_wait.handler({ tabId: 7, for: "text", text: "Payment complete" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.wait"]);
    expect((calls[1]!.params as any).text).toBe("Payment complete");
  });

  it("page_wait rejects text mode without text", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    await expect(tools.page_wait.handler({ tabId: 7, for: "text" } as any)).rejects.toThrow();
  });

  it("page_wait rejects function mode without expression", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    await expect(tools.page_wait.handler({ tabId: 7, for: "function" } as any)).rejects.toThrow();
  });

  it("page_wait_for_download is observational — does NOT claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_wait_for_download.handler({ timeoutMs: 5000 } as any);
    expect(calls.map(c => c.method)).toEqual(["page.waitForDownload"]);
    expect(JSON.parse((r.content[0] as any).text).filename).toBe("export.xlsx");
  });

  it("page_hover auto-claims and forwards uid", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_hover.handler({ tabId: 7, uid: "e10" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.hover"]);
    expect((calls[1]!.params as any).uid).toBe("e10");
  });

  it("page_press_key auto-claims and forwards key + modifiers", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_press_key.handler({ tabId: 7, key: "Enter" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.pressKey"]);
    expect((calls[1]!.params as any).key).toBe("Enter");
    expect((calls[1]!.params as any).modifiers).toEqual([]);
  });

  it("page_focus_state auto-claims and forwards tabId", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.page_focus_state.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.focusState"]);
    expect((calls[1]!.params as any).tabId).toBe(7);
    expect(JSON.parse((result.content[0] as any).text).activeRole).toBe("gridcell");
  });

  it("page_focus_state is batchable so verification can follow movement", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_press_key", args: { tabId: 1, key: "ArrowDown" } },
        { tool: "page_focus_state", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s: any) => s.tool)).toEqual(["page_press_key", "page_focus_state"]);
  });

  it("page_fill_form auto-claims and forwards fields", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_fill_form.handler({
      tabId: 7,
      fields: [
        { uid: "e1", value: "Alice" },
        { uid: "e2", value: "alice@example.com" },
      ],
    });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.fillForm"]);
    expect((calls[1]!.params as any).fields).toHaveLength(2);
  });

  it("page_eval_js auto-claims and forwards the expression", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_eval_js.handler({ tabId: 7, expression: "1+1" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.evalJs"]);
    expect((calls[1]!.params as any).expression).toBe("1+1");
  });

  it("console_read does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.console_read.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["console.read"]);
  });

  it("network_read does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.network_read.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["network.read"]);
  });

  it("network_get_request is observational (no claim) and returns headers+body", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.network_get_request.handler({ tabId: 7, urlPattern: "/api" });
    expect(calls.map(c => c.method)).toEqual(["network.getRequest"]);
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.status).toBe(500);
    expect(parsed.responseHeaders["content-type"]).toBe("application/json");
  });

  it("network_get_request rejects missing urlPattern", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    await expect(tools.network_get_request.handler({ tabId: 7 } as any)).rejects.toThrow();
  });

  it("console_read returns an array of entries in the text content block", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.console_read.handler({ tabId: 7 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toEqual([{ ts: 1, level: "error", text: "boom" }]);
  });

  it("page_handle_dialog auto-claims and forwards action+promptText", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_handle_dialog.handler({ tabId: 7, action: "accept", promptText: "yes" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.handleDialog"]);
    expect((calls[1]!.params as any).action).toBe("accept");
    expect((calls[1]!.params as any).promptText).toBe("yes");
  });

  it("page_select auto-claims and forwards values", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_select.handler({ tabId: 7, uid: "e5", values: ["opt1"] });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.select"]);
    expect((calls[1]!.params as any).values).toEqual(["opt1"]);
  });

  it("page_upload_file auto-claims and forwards filePaths", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_upload_file.handler({ tabId: 7, uid: "e5", filePaths: ["/tmp/a.png"] });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.uploadFile"]);
    expect((calls[1]!.params as any).filePaths).toEqual(["/tmp/a.png"]);
  });

  it("page_drag auto-claims and forwards both endpoints", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_drag.handler({ tabId: 7, fromUid: "e1", toUid: "e2" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.drag"]);
    expect((calls[1]!.params as any).fromUid).toBe("e1");
    expect((calls[1]!.params as any).toUid).toBe("e2");
  });

  it("page_fetch auto-claims (when tabId given) and forwards url+method+body", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.page_fetch.handler({
      tabId: 7,
      url: "/api/x",
      method: "POST",
      body: { a: 1 },
    });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.fetch"]);
    expect((calls[1]!.params as any).url).toBe("/api/x");
    expect((calls[1]!.params as any).method).toBe("POST");
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.json).toBe(true);
    expect(parsed.body).toEqual({ hello: "world" });
  });

  it("page_fetch without tabId does NOT auto-claim (observational)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_fetch.handler({ url: "/api/x" });
    expect(calls.map(c => c.method)).toEqual(["page.fetch"]);
  });

  // --- multi-profile ---
  it("chromanche_list_profiles returns the bridge's connected extensions", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.chromanche_list_profiles.handler({});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toEqual([
      { tag: "work", label: "Work", connectedAt: 1000 },
      { tag: "personal", label: "Personal", connectedAt: 2000 },
    ]);
  });

  it("threads profile through session.claim and the wire call", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, uid: "e1", profile: "work" });
    // session.claim should also carry profile
    expect(calls[0]).toEqual({ method: "session.claim", params: { tabId: 7 }, profile: "work" });
    expect(calls[1]!.method).toBe("page.click");
    expect(calls[1]!.profile).toBe("work");
    // `profile` must NOT leak into the wire params
    expect(Object.keys(calls[1]!.params as any)).not.toContain("profile");
  });

  it("same tabId on different profiles is claimed separately (no cross-profile cache hit)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, uid: "e1", profile: "work" });
    await tools.page_click.handler({ tabId: 7, uid: "e1", profile: "personal" });
    const claims = calls.filter(c => c.method === "session.claim");
    expect(claims.length).toBe(2);
    expect(claims.map(c => c.profile).sort()).toEqual(["personal", "work"]);
  });

  it("second call to same tabId+profile skips session.claim (claim cache)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, uid: "e1", profile: "work" });
    await tools.page_click.handler({ tabId: 7, uid: "e2", profile: "work" });
    const claims = calls.filter(c => c.method === "session.claim");
    expect(claims.length).toBe(1);
  });
});

describe("page_click_xy tool wrapper", () => {
  it("auto-claims and forwards x/y/button to page.clickXy", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click_xy.handler({ tabId: 5, x: 45, y: 107, button: "left" });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.clickXy"]);
    const xy = calls.find((c) => c.method === "page.clickXy")!;
    expect(xy.params).toMatchObject({ tabId: 5, x: 45, y: 107, button: "left" });
  });

  it("page_click_xy is in BATCHABLE_TOOLS so it composes inside page_batch", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_screenshot", args: { tabId: 1 } },
        { tool: "page_click_xy",   args: { tabId: 1, x: 45, y: 107 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s: any) => s.tool)).toEqual(["page_screenshot", "page_click_xy"]);
  });
});

describe("page_focus tool wrapper", () => {
  it("auto-claims and forwards mode + uid", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_focus.handler({ tabId: 9, uid: "e42", mode: "blur+click" });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.focused).toBe(true);
    expect(parsed.modeUsed).toBe("blur+click");
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.focus"]);
    const focusCall = calls.find((c) => c.method === "page.focus")!;
    expect((focusCall.params as any).uid).toBe("e42");
    expect((focusCall.params as any).mode).toBe("blur+click");
  });

  it("page_focus is in BATCHABLE_TOOLS so it composes inside page_batch", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_focus", args: { tabId: 1, uid: "e9", mode: "blur+click" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e9", text: "hi", clear: false } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s: any) => s.tool)).toEqual(["page_focus", "page_type"]);
    expect(parsed.results.every((s: any) => s.ok)).toBe(true);
  });
});

describe("PageBatchParamsSchema", () => {
  it("round-trips a 3-step batch with default stopOnError=true", () => {
    const parsed = PageBatchParamsSchema.parse({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    expect(parsed.stopOnError).toBe(true);
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]!.tool).toBe("page_click");
  });

  it("rejects an empty steps array", () => {
    expect(() => PageBatchParamsSchema.parse({ steps: [] })).toThrow();
  });

  it("rejects unknown tool names", () => {
    expect(() => PageBatchParamsSchema.parse({
      steps: [{ tool: "page_nope", args: {} }],
    })).toThrow();
  });

  it("rejects nested page_batch (no batches inside batches)", () => {
    expect(() => PageBatchParamsSchema.parse({
      steps: [{ tool: "page_batch", args: { steps: [] } }],
    })).toThrow();
  });
});

describe("page_batch handler", () => {
  it("registers page_batch in the tool map", () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    expect(Object.keys(tools)).toContain("page_batch");
  });

  it("runs steps sequentially and returns a per-step result array", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s) => s.tool)).toEqual(["page_click", "page_type"]);
    expect(parsed.results.every((s) => s.ok)).toBe(true);
    // Bridge saw the forwarded methods (plus the auto-claim).
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("page.click");
    expect(methods).toContain("page.type");
  });

  it("aborts on first failure when stopOnError=true (default)", async () => {
    const { bridge } = fakeBridge();
    bridge.call = vi.fn(async (method: string) => {
      if (method === "session.claim") return { ok: true, groupId: 1 };
      if (method === "page.click") return { ok: true };
      if (method === "page.type") throw new Error("boom");
      throw new Error("unexpected " + method);
    });
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[1]!.ok).toBe(false);
    expect(parsed.results[1]!.error).toMatch(/boom/);
  });

  it("continues past failures when stopOnError=false", async () => {
    const { bridge } = fakeBridge();
    bridge.call = vi.fn(async (method: string) => {
      if (method === "session.claim") return { ok: true, groupId: 1 };
      if (method === "page.click") return { ok: true };
      if (method === "page.type") throw new Error("boom");
      if (method === "page.screenshot") return { format: "png", base64: "aGk=" };
      throw new Error("unexpected " + method);
    });
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      stopOnError: false,
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results.map((s) => s.ok)).toEqual([true, false, true]);
  });

  it("forwards the batch-level profile to each step", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_batch.handler({
      profile: "work",
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
      ],
    });
    // Every forwarded bridge call carries profile=work.
    const profiles = new Set(calls.map((c) => c.profile));
    expect(profiles).toEqual(new Set(["work"]));
  });

  // page_screenshot inside a batch: the image content item is elided with a
  // sentinel so the batch's structured result stays small. Metadata (format,
  // byteLength) survives so the model can decide whether to call
  // page_screenshot directly to view the image.
  it("elides screenshot image content inside page_batch results (keeps batch small)", async () => {
    const { bridge } = fakeBridge();
    const big = "A".repeat(50_000);
    bridge.call = vi.fn(async (method: string) => {
      if (method === "session.claim") return { ok: true, groupId: 1 };
      if (method === "page.screenshot") return { format: "jpeg", base64: big };
      if (method === "page.click") return { ok: true };
      throw new Error("unexpected " + method);
    });
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; result?: { format?: string; byteLength?: number; image?: string } }>;
    };
    expect(parsed.ok).toBe(true);
    const shot = parsed.results[1]!.result!;
    expect(shot.format).toBe("jpeg");
    expect(shot.byteLength).toBe(50_000);
    expect(shot.image).toMatch(/elided/i);
    expect(shot.image).toMatch(/image\/jpeg/);
    // The full base64 is NOT in the batch result.
    const fullText = JSON.stringify(parsed);
    expect(fullText.length).toBeLessThan(2_000);
  });

  // Direct page_screenshot (outside a batch) returns full image content for the model to view.
  it("page_screenshot called directly returns full image content (not elided)", async () => {
    const { bridge } = fakeBridge();
    bridge.call = vi.fn(async (method: string) => {
      if (method === "session.claim") return { ok: true, groupId: 1 };
      if (method === "page.screenshot") return { format: "jpeg", base64: "/9j/RealImage" };
      throw new Error("unexpected " + method);
    });
    const tools = buildTools(bridge);
    const r = await tools.page_screenshot.handler({ tabId: 1 });
    const img = r.content.find((c: any) => c.type === "image") as any;
    expect(img.data).toBe("/9j/RealImage");
    expect(img.mimeType).toBe("image/jpeg");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../dist");
const serverEntry = resolve(here, "../../mcp-server/dist/index.cjs");

const SHOULD_RUN = process.env.CHROMANCHE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

const PORT = "59341";
// page_paste necessarily writes the SYSTEM clipboard (headed Chromium shares
// it with the OS). Only run those tests where that's harmless — CI under xvfb
// sets this — never by default on a developer's machine.
const CLIPBOARD_OK = process.env.CHROMANCHE_E2E_CLIPBOARD === "1";
const TOKEN = randomBytes(24).toString("hex");

async function setExtensionStorage(sw: Worker, data: Record<string, unknown>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await sw.evaluate(async (payload) => {
        if (typeof chrome === "undefined" || !chrome.storage?.local) throw new Error("chrome.storage unavailable");
        await chrome.storage.local.set(payload);
      }, data);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("timed out waiting for chrome.storage.local in extension SW");
}

async function waitForAuthed(sw: Worker, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sw
      .evaluate(async () => (await chrome.storage.local.get("status")).status as string | undefined)
      .catch(() => undefined);
    if (status === "authed") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("extension did not reach status=authed in time");
}

async function serve(html: string): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

/**
 * Inner (cross-origin → OOPIF) page with the generic widget behaviours that
 * break naive automation:
 *  - #rich: an editor with its OWN model. Edits that bypass input events are
 *    invisible to it; it re-renders from the model.
 *  - #sink: a paste-handling target (takes the paste over with preventDefault).
 *  - #ac: an input that inline-completes ("Ap" → "Apple", remainder selected).
 *  - #combo: a combobox that opens a role=listbox of suggestions while typing.
 *  - #t: a plain textarea.
 */
const INNER_HTML = `<!doctype html><html><head><title>inner-widgets</title></head><body>
<textarea id="t" rows="3" cols="30"></textarea>
<div id="rich" contenteditable="true" role="textbox" aria-label="rich editor" style="border:1px solid #888;min-height:22px;width:240px"></div>
<div id="sink" contenteditable="true" role="textbox" aria-label="paste target" style="width:240px;height:22px;border:1px solid #bbb"></div>
<input id="ac" aria-label="autocompleting field" style="width:240px">
<input id="combo" role="combobox" aria-label="suggesting field" aria-expanded="false" aria-controls="combo-list" style="width:240px">
<div id="combo-list" role="listbox" style="display:none;border:1px solid #444;width:240px">
  <div role="option" aria-selected="true">Apple</div><div role="option">Apricot</div><div role="option">Avocado</div>
</div>
<script>
  // --- model-backed rich editor ---
  const rich = document.getElementById("rich");
  let model = "s3";
  const render = () => { rich.textContent = model; };
  render();
  const selOffsets = () => {
    const s = getSelection();
    if (!s.rangeCount || !rich.contains(s.anchorNode)) return [model.length, model.length];
    const r = s.getRangeAt(0);
    const pre = document.createRange(); pre.selectNodeContents(rich); pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    return [start, start + r.toString().length];
  };
  const place = (pos) => {
    const node = rich.firstChild; if (!node) return;
    const r = document.createRange(); r.setStart(node, Math.min(pos, node.length)); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  rich.addEventListener("focus", () => setTimeout(() => place(0), 0));
  rich.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    let [a, b] = selOffsets();
    if (e.inputType === "deleteContentBackward") {
      if (a === b && a > 0) a -= 1;
      model = model.slice(0, a) + model.slice(b);
    } else if (e.inputType === "insertText") {
      model = model.slice(0, a) + (e.data || "") + model.slice(b);
      a += (e.data || "").length;
    } else { return; }
    render(); place(a);
    window.__richModel = model;
  });
  window.__richModel = model;

  // --- paste target ---
  window.__pastes = [];
  document.getElementById("sink").addEventListener("paste", (e) => {
    e.preventDefault();
    window.__pastes.push(e.clipboardData.getData("text/plain"));
  });

  // --- inline completion: suggest "Apple" for a typed prefix, remainder selected ---
  const ac = document.getElementById("ac");
  ac.addEventListener("input", (e) => {
    if (e.inputType !== "insertText") return;
    const typed = ac.value;
    if (typed && "Apple".startsWith(typed) && typed !== "Apple") {
      ac.value = "Apple";
      ac.setSelectionRange(typed.length, 5);
    }
  });

  // --- suggestion list ---
  const combo = document.getElementById("combo");
  const list = document.getElementById("combo-list");
  combo.addEventListener("input", () => {
    const open = combo.value.length > 0;
    list.style.display = open ? "block" : "none";
    combo.setAttribute("aria-expanded", String(open));
  });
</script></body></html>`;

describeE2E("input fidelity: coordinate-true screenshots, verified paste, real clearing, typed-text checks (multi-OS)", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcp: {
    callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>;
    close: () => Promise<void>;
  };
  let innerServer: Server;
  let outerServer: Server;
  let outerOrigin: string;
  let innerOrigin: string;

  async function call(name: string, args: unknown): Promise<any> {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  }
  async function callRaw(name: string, args: unknown) {
    // Tool errors surface as JSON-RPC errors (the SDK rejects) — normalise to isError.
    try {
      return await mcp.callTool({ name, arguments: args });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
    }
  }
  async function tabIdFor(url: string): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const id = await sw.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url === u)?.id;
      }, url);
      if (typeof id === "number") return id;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no tab with url ${url}`);
  }
  async function openFixture(): Promise<{ page: Page; tabId: number }> {
    const page = await ctx.newPage();
    // Unique URL per test → unambiguous tab lookup (the "active tab of the
    // last focused window" can be an earlier test's tab in headed runs).
    const url = `${outerOrigin}/?run=${randomBytes(4).toString("hex")}`;
    await page.goto(url);
    await page.frameLocator("#f").locator("#t").waitFor({ state: "attached", timeout: 10_000 });
    const tabId = await tabIdFor(url);
    // Wait until the OOPIF is attached and visible in the a11y tree.
    for (let i = 0; i < 20; i++) {
      const snap = await call("page_snapshot", { tabId });
      if (/paste target/.test(snap.content) && /rich editor/.test(snap.content)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    opened.push(page);
    return { page, tabId };
  }
  const opened: Page[] = [];
  const inner = (page: Page) => page.frames().find((f) => f.url().startsWith(innerOrigin))!;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);
    innerServer = await serve(INNER_HTML);
    const innerPort = (innerServer.address() as AddressInfo).port;
    innerOrigin = `http://inner.test:${innerPort}`;
    outerServer = await serve(`<!doctype html><html><head><title>outer</title></head><body style="margin:0">
      <button id="target" style="position:absolute;left:600px;top:400px;width:120px;height:60px">Target</button>
      <iframe id="f" src="${innerOrigin}/" style="position:absolute;left:0;top:0;width:420px;height:260px;border:0"></iframe>
      <script>window.__targetClicks = 0; document.getElementById("target").addEventListener("click", () => window.__targetClicks++);</script>
    </body></html>`);
    outerOrigin = `http://outer.test:${(outerServer.address() as AddressInfo).port}`;

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      viewport: { width: 1000, height: 700 },
      deviceScaleFactor: 2,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        `--host-resolver-rules=MAP outer.test 127.0.0.1, MAP inner.test 127.0.0.1`,
        `--site-per-process`,
      ],
    });
    // The test fixture origins are http:// — grant clipboard access like a user would.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    await setExtensionStorage(sw, { token: TOKEN, port: Number(PORT) });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, CHROMANCHE_PORT: PORT, CHROMANCHE_TOKEN: TOKEN },
    }));
    mcp = client as unknown as typeof mcp;
    await waitForAuthed(sw);
  }, 45_000);

  afterAll(async () => {
    for (const p of opened) await p.close().catch(() => {});
    await mcp?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await new Promise<void>((r) => outerServer?.close(() => r()));
    await new Promise<void>((r) => innerServer?.close(() => r()));
  });

  it("downscaled screenshot pixels map back to the right CSS point on a 2x display", async () => {
    const { page, tabId } = await openFixture();
    const shot = await callRaw("page_screenshot", { tabId, maxEdge: 500, format: "png" });
    const meta = JSON.parse(shot.content.find((c) => c.type === "text")!.text!);
    // 1000×700 CSS viewport capped to a 500px long edge → 500×350, 2 CSS px per image px.
    expect(meta.image).toEqual({ width: 500, height: 350 });
    expect(meta.scale).toBeCloseTo(2, 3);
    expect(meta.capture).toBe("cdp");
    // The button's centre is CSS (660, 430) → image (330, 215).
    const r = await call("page_click_xy", { tabId, x: 330, y: 215 });
    expect(r.spaceUsed).toBe("screenshot");
    expect(r.point.x).toBeCloseTo(660, 0);
    expect(await page.evaluate(() => (window as any).__targetClicks)).toBe(1);
  }, 30_000);

  it.skipIf(!CLIPBOARD_OK)("page_paste delivers a REAL paste into a cross-origin iframe (⌘V on macOS, Ctrl+V elsewhere)", async () => {
    const { page, tabId } = await openFixture();
    const snap = await call("page_snapshot", { tabId });
    const uid = snap.content.match(/\[(e\d+)\] textbox "paste target"/)?.[1];
    expect(uid, snap.content).toBeTruthy();
    const r = await call("page_paste", { tabId, target: "uid", uid, text: "p1a\tp1b\np2a\tp2b" });
    expect(r.pasteDelivered).toBe(true);
    expect(r.pasteHandledByPage).toBe(true);
    const pastes = await inner(page).evaluate(() => (window as any).__pastes);
    expect(pastes).toEqual(["p1a\tp1b\np2a\tp2b"]);
  }, 30_000);

  it.skipIf(!CLIPBOARD_OK)("page_paste fails loudly when nothing can receive the paste", async () => {
    const { tabId } = await openFixture();
    // Focus the top-level button (not editable, no paste handler) via a click.
    await call("page_click_xy", { tabId, x: 660, y: 430, space: "css" });
    const r = await callRaw("page_paste", { tabId, text: "orphan" });
    // A paste event may still be dispatched to the body on some platforms; what
    // must never happen is a silent "ok" when no paste event was observed.
    const text = r.content.find((c) => c.type === "text")!.text!;
    if (r.isError) expect(text).toMatch(/no paste event reached|clipboard/);
    else expect(JSON.parse(text).pasteDelivered).toBe(true);
  }, 30_000);

  it("clear=true empties a model-backed editor through real input (old text isn't merged in)", async () => {
    const { page, tabId } = await openFixture();
    const snap = await call("page_snapshot", { tabId });
    const uid = snap.content.match(/\[(e\d+)\] textbox "rich editor"/)?.[1];
    expect(uid, snap.content).toBeTruthy();
    const r = await call("page_type", { tabId, uid, text: "fresh" });
    expect(r.focus.frame).toContain("inner.test");
    expect(await inner(page).evaluate(() => (window as any).__richModel)).toBe("fresh");
  }, 30_000);

  it("page_type drops an inline auto-completion so the field holds exactly the typed text", async () => {
    const { page, tabId } = await openFixture();
    const snap = await call("page_snapshot", { tabId });
    const uid = snap.content.match(/\[(e\d+)\] textbox "autocompleting field"/)?.[1];
    expect(uid, snap.content).toBeTruthy();
    const r = await call("page_type", { tabId, uid, text: "Ap" });
    expect(r.completion).toEqual({ typed: "Ap", fieldShowed: "Apple", removed: true, fieldNow: "Ap" });
    expect(await inner(page).evaluate(() => (document.getElementById("ac") as HTMLInputElement).value)).toBe("Ap");
    // exact:false keeps the page's suggestion.
    const kept = await call("page_type", { tabId, uid, text: "Ap", exact: false });
    expect(kept.completion).toBeUndefined();
    expect(await inner(page).evaluate(() => (document.getElementById("ac") as HTMLInputElement).value)).toBe("Apple");
  }, 30_000);

  it("page_type reports the suggestion list its typing opened (Enter would pick from it)", async () => {
    const { tabId } = await openFixture();
    const snap = await call("page_snapshot", { tabId });
    const uid = snap.content.match(/\[(e\d+)\] combobox "suggesting field"/)?.[1];
    expect(uid, snap.content).toBeTruthy();
    const r = await call("page_type", { tabId, uid, text: "A" });
    expect(r.focus.popups).toEqual([{ role: "listbox", items: 3 }]);
    expect(r.focus.expanded).toBe(true);
    // Escape is the caller's choice; afterwards the list is gone from the report.
    const after = await call("page_press_key", { tabId, key: "Backspace" });
    expect(after.focus.popups).toBeUndefined();
  }, 30_000);

  it("ControlOrMeta+A selects all in a focused iframe textarea on this OS", async () => {
    const { page, tabId } = await openFixture();
    await inner(page).evaluate(() => {
      const t = document.getElementById("t") as HTMLTextAreaElement;
      t.value = "hello world"; t.focus(); t.setSelectionRange(0, 0);
    });
    const r = await call("page_press_key", { tabId, key: "a", modifiers: ["ControlOrMeta"] });
    expect(r.focus.tag).toBe("textarea");
    const sel = await inner(page).evaluate(() => {
      const t = document.getElementById("t") as HTMLTextAreaElement;
      return [t.selectionStart, t.selectionEnd];
    });
    expect(sel).toEqual([0, 11]);
  }, 30_000);

  it("page_eval_js frame=<regex> runs inside the cross-origin iframe", async () => {
    const { tabId } = await openFixture();
    const r = await call("page_eval_js", { tabId, expression: "document.title", frame: "inner\\.test" });
    expect(r.value).toBe("inner-widgets");
    expect(r.frame).toContain("inner.test");
    const top = await call("page_eval_js", { tabId, expression: "document.title" });
    expect(top.value).toBe("outer");
  }, 30_000);
});

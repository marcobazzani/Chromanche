/**
 * Focus & frame helpers shared by input, eval and wait handlers.
 *
 * Rich editors (grids, canvases, rich-text widgets) often keep their keyboard
 * surface inside cross-origin iframes (OOPIFs, each with its own CDP session)
 * and apply input asynchronously. These helpers answer: which frame owns
 * keyboard focus, which frame matches a selector, and — after an action —
 * where did focus settle, what does it contain, and what popup opened.
 */
import type { DebuggerManager, FrameTargetInfo } from "./debugger-manager.js";

export interface Popup {
  role: string;
  label?: string;
  items?: number;
}

export interface FocusState {
  ok: true;
  targetId?: string;
  url: string;
  title: string;
  documentHasFocus: boolean;
  activeTag: string;
  activeRole?: string | null;
  activeName?: string;
  activeValue?: string;
  activeText?: string;
  selectedText?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  activeDescendant?: string;
  activeDescendantTag?: string;
  activeDescendantRole?: string | null;
  activeDescendantName?: string;
  activeDescendantValue?: string;
  activeDescendantText?: string;
  activeDescendantRowIndex?: string;
  activeDescendantColIndex?: string;
  activeDescendantBounds?: { x: number; y: number; width: number; height: number };
  ariaRowIndex?: string;
  ariaColIndex?: string;
  activeExpanded?: string | null;
  popups?: Popup[];
}

export interface FocusSummary {
  frame?: string;
  tag: string;
  role?: string | null;
  name?: string;
  value?: string;
  text?: string;
  activeDescendantName?: string;
  popups?: Popup[];
  expanded?: boolean;
  settled: boolean;
  waitedMs: number;
}

/** Popups visible in a frame before an action, to report only what the action opened. */
export interface PopupBaseline {
  targetId?: string;
  popups: Popup[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function documentHasFocus(mgr: DebuggerManager, tabId: number, targetId?: string): Promise<boolean> {
  try {
    const r = await mgr.sendCommand<{ result: { value?: boolean } }>(
      tabId,
      "Runtime.evaluate",
      { expression: "document.hasFocus()", returnByValue: true },
      targetId,
    );
    return r.result.value === true;
  } catch {
    return false;
  }
}

function frameDepth(targetId: string, parents: Map<string, string | undefined>): number {
  let depth = 0;
  let cur: string | undefined = targetId;
  while (cur && depth < 32) {
    depth++;
    cur = parents.get(cur);
  }
  return depth;
}

/** Is frame f's owner <iframe> the activeElement of its parent document? */
async function ownerIsActive(mgr: DebuggerManager, tabId: number, f: FrameTargetInfo): Promise<boolean> {
  try {
    const owner = await mgr.sendCommand<{ backendNodeId?: number }>(
      tabId, "DOM.getFrameOwner", { frameId: f.targetId }, f.parentTargetId,
    );
    if (typeof owner.backendNodeId !== "number") return false;
    const node = await mgr.sendCommand<{ object?: { objectId?: string } }>(
      tabId, "DOM.resolveNode", { backendNodeId: owner.backendNodeId }, f.parentTargetId,
    );
    const objectId = node.object?.objectId;
    if (!objectId) return false;
    const r = await mgr.sendCommand<{ result: { value?: boolean } }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { return !!this.ownerDocument && this.ownerDocument.activeElement === this; }",
      returnByValue: true,
    }, f.parentTargetId);
    return r.result.value === true;
  } catch {
    return false;
  }
}

/**
 * The frame session that owns keyboard focus (undefined = top frame).
 *
 * Primary signal: document.hasFocus(), deepest frame first. When the browser
 * window itself is unfocused (the user is in another app) hasFocus() is false
 * everywhere, yet every document still tracks its activeElement — so we fall
 * back to walking the activeElement chain from the top: a frame owns focus
 * when its owner <iframe> is the activeElement of its parent document.
 */
export async function focusedKeyboardTarget(mgr: DebuggerManager, tabId: number): Promise<string | undefined> {
  await mgr.syncFrameTargets(tabId);
  const frames = mgr.getFrameTargets(tabId);
  if (frames.length === 0) return undefined;
  const parents = new Map(frames.map((f) => [f.targetId, f.parentTargetId]));
  const deepestFirst = [...frames].sort(
    (a, b) => frameDepth(b.targetId, parents) - frameDepth(a.targetId, parents),
  );
  for (const frame of deepestFirst) {
    if (await documentHasFocus(mgr, tabId, frame.targetId)) return frame.targetId;
  }
  let current: string | undefined = undefined;
  for (let depth = 0; depth < 8; depth++) {
    const children = frames.filter((f) => f.parentTargetId === current);
    let next: string | undefined;
    for (const f of children) {
      if (await ownerIsActive(mgr, tabId, f)) {
        next = f.targetId;
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
}

async function liveUrl(mgr: DebuggerManager, tabId: number, targetId?: string): Promise<string | undefined> {
  try {
    const r = await mgr.sendCommand<{ result: { value?: unknown } }>(
      tabId, "Runtime.evaluate", { expression: "location.href", returnByValue: true }, targetId,
    );
    return typeof r.result.value === "string" ? r.result.value : undefined;
  } catch {
    return undefined;
  }
}

/** origin + pathname — frame URLs can carry kilobytes of query string; keep labels readable. */
export function frameLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 200);
  }
}

export interface ResolvedFrame {
  /** undefined = top frame (tab session). */
  targetId?: string;
  /** Label for results; undefined for the top frame. */
  frame?: string;
}

/**
 * Resolve a frame selector: undefined/"top" → top frame; "focused" → frame
 * owning keyboard focus; anything else → regex over LIVE frame URLs (frames
 * navigate after attach). Preference among matches: the focused frame, then
 * the deepest iframe, then the top frame.
 */
export async function resolveFrame(mgr: DebuggerManager, tabId: number, selector?: string): Promise<ResolvedFrame> {
  if (!selector || selector === "top") return {};
  if (selector === "focused") {
    const targetId = await focusedKeyboardTarget(mgr, tabId);
    if (!targetId) return {};
    return { targetId, frame: frameLabel(await liveUrl(mgr, tabId, targetId)) };
  }
  let re: RegExp;
  try {
    re = new RegExp(selector);
  } catch (e) {
    throw new Error(`frame: invalid regex ${JSON.stringify(selector)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  await mgr.syncFrameTargets(tabId);
  const frames = mgr.getFrameTargets(tabId);
  const parents = new Map(frames.map((f) => [f.targetId, f.parentTargetId]));
  const seen: Array<{ targetId?: string; url: string }> = [];
  const matches: Array<{ targetId: string; url: string; depth: number }> = [];
  for (const f of frames) {
    const url = (await liveUrl(mgr, tabId, f.targetId)) ?? f.url;
    seen.push({ targetId: f.targetId, url });
    if (re.test(url)) matches.push({ targetId: f.targetId, url, depth: frameDepth(f.targetId, parents) });
  }
  if (matches.length > 0) {
    const focused = await focusedKeyboardTarget(mgr, tabId);
    const best = matches.find((m) => m.targetId === focused) ?? [...matches].sort((a, b) => b.depth - a.depth)[0]!;
    return { targetId: best.targetId, frame: frameLabel(best.url) };
  }
  const topUrl = (await liveUrl(mgr, tabId)) ?? "";
  if (re.test(topUrl)) return {};
  const listing = [`top=${frameLabel(topUrl) ?? "?"}`, ...seen.map((s) => frameLabel(s.url) ?? s.url)].join(", ");
  throw new Error(`frame: no frame URL matches /${selector}/. Frames: ${listing}`);
}

const READ_FOCUS_STATE_EXPR = `(() => {
  const doc = document;
  const active = doc.activeElement;
  const readAttr = (el, name) => el && el.getAttribute ? el.getAttribute(name) || undefined : undefined;
  const accessibleName = (el) => el ? (
    readAttr(el, "aria-label") ||
    readAttr(el, "placeholder") ||
    readAttr(el, "name") ||
    readAttr(el, "title") ||
    (el.textContent || "").trim().slice(0, 200) ||
    undefined
  ) : undefined;
  const elementValue = (el) => el && "value" in el ? String(el.value ?? "") : undefined;
  const elementText = (el, max = 500) => el ? (el.textContent || "").trim().slice(0, max) || undefined : undefined;
  const bounds = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
    const r = el.getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return undefined;
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const value = active && "value" in active ? String(active.value ?? "") : undefined;
  let selectionStart, selectionEnd;
  try { selectionStart = active && "selectionStart" in active ? active.selectionStart : undefined; } catch (e) {}
  try { selectionEnd = active && "selectionEnd" in active ? active.selectionEnd : undefined; } catch (e) {}
  let selectedText = "";
  if (typeof selectionStart === "number" && typeof selectionEnd === "number" && value !== undefined) {
    selectedText = value.slice(selectionStart, selectionEnd);
  } else {
    selectedText = String(doc.getSelection ? doc.getSelection() || "" : "");
  }
  const activeDescendant = readAttr(active, "aria-activedescendant");
  const descendant = activeDescendant ? doc.getElementById(activeDescendant) : null;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const popups = [...doc.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"],[role="alertdialog"]')]
    .filter(shown)
    .slice(0, 6)
    .map((el) => {
      const label = (el.getAttribute("aria-label") || "").trim().slice(0, 80);
      const items = el.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]').length;
      return { role: el.getAttribute("role"), ...(label ? { label } : {}), ...(items ? { items } : {}) };
    });
  return {
    url: location.href,
    title: doc.title,
    documentHasFocus: doc.hasFocus(),
    activeTag: active && active.tagName ? active.tagName.toLowerCase() : "body",
    activeRole: readAttr(active, "role") ?? null,
    activeName: accessibleName(active),
    activeValue: elementValue(active),
    activeText: elementText(active),
    selectedText: selectedText || undefined,
    selectionStart: selectionStart ?? undefined,
    selectionEnd: selectionEnd ?? undefined,
    activeDescendant,
    activeDescendantTag: descendant && descendant.tagName ? descendant.tagName.toLowerCase() : undefined,
    activeDescendantRole: readAttr(descendant, "role") ?? undefined,
    activeDescendantName: accessibleName(descendant),
    activeDescendantValue: elementValue(descendant),
    activeDescendantText: elementText(descendant),
    activeDescendantRowIndex: readAttr(descendant, "aria-rowindex"),
    activeDescendantColIndex: readAttr(descendant, "aria-colindex"),
    activeDescendantBounds: bounds(descendant),
    ariaRowIndex: readAttr(active, "aria-rowindex"),
    ariaColIndex: readAttr(active, "aria-colindex"),
    activeExpanded: readAttr(active, "aria-expanded") ?? null,
    popups,
  };
})()`;

export async function readFocusState(mgr: DebuggerManager, tabId: number, targetId?: string): Promise<FocusState> {
  const r = await mgr.sendCommand<{ result: { value: Omit<FocusState, "ok" | "targetId"> } }>(
    tabId,
    "Runtime.evaluate",
    { expression: READ_FOCUS_STATE_EXPR, returnByValue: true },
    targetId,
  );
  return { ok: true, targetId, ...r.result.value };
}

function fingerprint(s: FocusState): string {
  return JSON.stringify([
    s.url, s.activeTag, s.activeRole, s.activeName, s.activeValue, s.activeText,
    s.selectionStart, s.selectionEnd, s.activeDescendant, s.activeDescendantName,
    s.activeDescendantValue, s.activeDescendantText, s.activeExpanded, s.popups,
  ]);
}

const trunc = (s: string | undefined, n = 160): string | undefined =>
  s === undefined || s === "" ? undefined : s.length > n ? `${s.slice(0, n)}…` : s;

const popupKey = (p: Popup) => `${p.role}\u0000${p.label ?? ""}\u0000${p.items ?? 0}`;

/** Popups in `s` that weren't in the baseline (all of them when the baseline is for another frame). */
export function newPopups(s: FocusState, baseline?: PopupBaseline): Popup[] {
  const now = s.popups ?? [];
  if (!baseline || baseline.targetId !== s.targetId) return now;
  const before = new Set(baseline.popups.map(popupKey));
  return now.filter((p) => !before.has(popupKey(p)));
}

export function summarizeFocus(s: FocusState, settled: boolean, waitedMs: number, baseline?: PopupBaseline): FocusSummary {
  const out: FocusSummary = { tag: s.activeTag, settled, waitedMs };
  const frame = s.targetId ? frameLabel(s.url) : undefined;
  if (frame) out.frame = frame;
  if (s.activeRole !== undefined) out.role = s.activeRole;
  const name = trunc(s.activeName);
  if (name) out.name = name;
  const value = trunc(s.activeValue);
  if (value) out.value = value;
  if (s.activeText && s.activeText !== s.activeName) {
    const text = trunc(s.activeText);
    if (text) out.text = text;
  }
  const adn = trunc(s.activeDescendantName);
  if (adn) out.activeDescendantName = adn;
  const pops = newPopups(s, baseline);
  if (pops.length) out.popups = pops;
  if (s.activeExpanded === "true") out.expanded = true;
  return out;
}

export interface SettleOptions {
  /** Focus state must stay unchanged this long to count as settled. */
  quietMs?: number;
  /** Give up waiting after this long (report settled=false). */
  maxMs?: number;
  pollMs?: number;
}

/**
 * Wait until the focused element's observable state (value, text, active
 * descendant, open popups…) stops changing, then summarize it. Polling runs
 * from the extension, not page timers, so it works in throttled background
 * tabs too. With a `baseline`, only popups the action opened are reported.
 * Never throws: the action already happened; a failed probe just yields
 * undefined.
 */
export async function settleFocus(
  mgr: DebuggerManager,
  tabId: number,
  opts: SettleOptions = {},
  baseline?: PopupBaseline,
): Promise<FocusSummary | undefined> {
  const quietMs = opts.quietMs ?? 150;
  const maxMs = opts.maxMs ?? 2_000;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  try {
    let targetId = await focusedKeyboardTarget(mgr, tabId);
    let state = await readFocusState(mgr, tabId, targetId);
    let fp = fingerprint(state);
    let stableSince = Date.now();
    let settled = false;
    for (;;) {
      if (Date.now() - stableSince >= quietMs) {
        settled = true;
        break;
      }
      if (Date.now() - start >= maxMs) break;
      await sleep(pollMs);
      const next = await readFocusState(mgr, tabId, targetId);
      const nfp = fingerprint(next);
      if (nfp !== fp) {
        fp = nfp;
        state = next;
        stableSince = Date.now();
      }
    }
    // Focus may have hopped frames (e.g. Enter in an iframe dialog). Report where it is now.
    const finalTarget = await focusedKeyboardTarget(mgr, tabId);
    if (finalTarget !== targetId) {
      targetId = finalTarget;
      state = await readFocusState(mgr, tabId, targetId);
    }
    return summarizeFocus(state, settled, Date.now() - start, baseline);
  } catch {
    return undefined;
  }
}

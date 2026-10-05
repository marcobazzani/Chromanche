import type { Dispatcher } from "../dispatcher.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import {
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PageHoverParamsSchema,
  PagePressKeyParamsSchema,
  PageFillFormParamsSchema,
  PageHandleDialogParamsSchema,
  PageSelectParamsSchema,
  PageUploadFileParamsSchema,
  PageDragParamsSchema,
  PageFocusParamsSchema,
  PageClickXyParamsSchema,
  PageFocusStateParamsSchema,
  PagePasteParamsSchema,
} from "@chromanche/shared";
import { resolveUid } from "../lib/snapshot-manager.js";
import { takeA11ySnapshot } from "./page-read.js";
import {
  KEY_DEFS,
  MOD_SHIFT,
  charToKeyDef,
  dispatchKey,
  modifierFlags,
  resolveKey,
  shortcutModifier,
} from "../lib/keyboard.js";
import { isMacBrowser } from "../lib/platform.js";
import { focusedKeyboardTarget, readFocusState, settleFocus, type FocusState, type PopupBaseline } from "../lib/focus.js";
import { toCssPoint } from "../lib/screenshot-transform.js";

/* ---------- helpers ---------- */

interface ResolvedElement {
  objectId: string;
  /** undefined = main tab frame; otherwise the OOPIF's CDP targetId. */
  targetId?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve a uid to a CDP objectId.
 *
 * uid-based resolution picks up the element's target from the snapshot,
 * so elements inside OOPIFs route to their own CDP session. Selector-based
 * resolution always queries the main frame — selectors don't cross
 * iframe boundaries, and we don't want to introduce a surprise traversal.
 */
async function resolveElement(
  mgr: DebuggerManager,
  tabId: number,
  uid?: string,
  selector?: string,
): Promise<ResolvedElement> {
  if (uid) {
    const entry = resolveUid(tabId, uid);
    if (!entry) throw new Error(`uid "${uid}" not found — take a new snapshot first`);
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      entry.targetId,
    );
    if (!r.object?.objectId) throw new Error(`uid "${uid}" could not be resolved to a DOM node`);
    return { objectId: r.object.objectId, targetId: entry.targetId };
  }
  if (selector) {
    const doc = await mgr.sendCommand<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", {});
    const q = await mgr.sendCommand<{ nodeId: number }>(
      tabId,
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector },
    );
    if (!q.nodeId) throw new Error(`selector did not match: ${selector}`);
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { nodeId: q.nodeId },
    );
    if (!r.object?.objectId) throw new Error(`selector resolved but node has no JS object`);
    return { objectId: r.object.objectId };
  }
  throw new Error("provide either uid or selector");
}

/** Call a function with `this` = element (in its own frame session) and return its value. */
async function callOn<T>(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const r = await mgr.sendCommand<{ result: { value?: T } }>(tabId, "Runtime.callFunctionOn", {
    objectId: el.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  }, el.targetId);
  return r.result.value as T;
}

/**
 * Center of an element's content box, scrolled into view first.
 *
 * Coords are session-local: when `targetId` is set, x/y are relative to
 * the iframe's viewport and the caller must dispatch mouse events on
 * the same session for them to land.
 */
async function getElementCenter(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
  targetId?: string,
): Promise<{ x: number; y: number }> {
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.scrollIntoViewIfNeeded(true); }`,
    returnByValue: true,
  }, targetId);
  return boxCenter(mgr, tabId, objectId, targetId);
}

async function boxCenter(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
  targetId?: string,
): Promise<{ x: number; y: number }> {
  const box = await mgr.sendCommand<{ model: { content: number[] } }>(
    tabId,
    "DOM.getBoxModel",
    { objectId },
    targetId,
  );
  const q = box.model.content;
  return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
}

async function maybeSnapshot(
  mgr: DebuggerManager,
  tabId: number,
  include: boolean,
): Promise<string | undefined> {
  if (!include) return undefined;
  // Small delay to let the page react (e.g. form validation, dropdown open).
  await sleep(150);
  return takeA11ySnapshot(mgr, tabId);
}

/**
 * Chrome refuses CDP operations against objects inside an iframe owned by
 * another extension (typically 1Password, Bitwarden, or anti-phishing
 * overlays). We detect that error so we can fall back to coordinate-level
 * operations that don't require JS-context access to the element.
 */
function isCrossExtensionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /chrome-extension:\/\/.*different extension/i.test(msg);
}

/** Turn opaque CDP errors into actionable advice at the tool boundary. */
function translateCdpError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (isCrossExtensionError(e)) {
    return new Error(
      "interaction blocked by another Chrome extension injecting a chrome-extension:// iframe " +
      "over the target element (typically 1Password / Bitwarden autofill or an anti-phishing overlay). " +
      "Click somewhere neutral on the page to dismiss it and retry, or disable the conflicting extension " +
      "for this site. Original: " + msg,
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

type MouseButton = "left" | "right" | "middle";

/** DOM MouseEvent.buttons bitmask (what CDP's `buttons` expects): left=1, right=2, middle=4. */
function buttonsMask(button: MouseButton): number {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

/**
 * A human-shaped click: move the pointer there first (hover state, pointer
 * tracking — some grids ignore a press that arrives without a prior move),
 * then press/release `clickCount` times.
 */
async function mouseClickAt(
  mgr: DebuggerManager,
  tabId: number,
  x: number,
  y: number,
  button: MouseButton = "left",
  clickCount = 1,
  targetId?: string,
): Promise<void> {
  await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, targetId);
  for (let i = 1; i <= clickCount; i++) {
    await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button, buttons: buttonsMask(button), clickCount: i,
    }, targetId);
    await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button, buttons: 0, clickCount: i,
    }, targetId);
  }
}

/** Click at element coordinates without needing JS access (works through cross-extension overlays). */
async function coordinateClick(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
  targetId?: string,
): Promise<void> {
  const { x, y } = await boxCenter(mgr, tabId, objectId, targetId);
  await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  }, targetId);
  await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  }, targetId);
}

/* ---------- Focus verification + escalation ---------- */

interface FocusActualState {
  matches: boolean;
  actualTag?: string;
  actualRole?: string | null;
  actualName?: string;
}

/**
 * Ask the page whether `el` is its document's activeElement. When it isn't,
 * report what activeElement actually is — so the caller can either escalate
 * (coordinate-click, blur+click) or surface a structured error to the model.
 *
 * Runs in the element's own document via the same CDP session we used to
 * resolve it, which is critical for OOPIFs (editors that live inside
 * cross-origin iframes).
 */
async function verifyFocus(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
): Promise<FocusActualState> {
  const r = await mgr.sendCommand<{ result: { value: FocusActualState } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId: el.objectId,
      functionDeclaration: `function() {
        var doc = this.ownerDocument;
        var active = doc && doc.activeElement;
        if (active === this) return { matches: true };
        return {
          matches: false,
          actualTag: active && active.tagName ? active.tagName.toLowerCase() : 'body',
          actualRole: active && active.getAttribute ? active.getAttribute('role') : null,
          actualName: active ? (
            (active.getAttribute && (active.getAttribute('aria-label') || active.getAttribute('placeholder') || active.getAttribute('name'))) ||
            (active.textContent || '').trim().slice(0, 80)
          ) : ''
        };
      }`,
      returnByValue: true,
    },
    el.targetId,
  );
  return r.result.value;
}

/** Plain JS focus(), idempotent: skips when the element is already active. */
async function jsFocus(mgr: DebuggerManager, tabId: number, el: ResolvedElement): Promise<void> {
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: el.objectId,
    functionDeclaration: `function() { if (this.ownerDocument && this !== this.ownerDocument.activeElement) this.focus(); }`,
    returnByValue: true,
  }, el.targetId);
}

/** document.activeElement.blur() inside the element's own document — drops sticky focus. */
async function blurActive(mgr: DebuggerManager, tabId: number, el: ResolvedElement): Promise<void> {
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: el.objectId,
    functionDeclaration: `function() {
      var doc = this.ownerDocument;
      var a = doc && doc.activeElement;
      if (a && a !== this && typeof a.blur === 'function') a.blur();
    }`,
    returnByValue: true,
  }, el.targetId);
}

interface FocusOutcome {
  focused: boolean;
  modeUsed: "js" | "click" | "blur+click";
  actual?: FocusActualState;
}

/**
 * Auto mode: try the gentle JS focus, verify, escalate to coordinate-click on
 * mismatch, verify again. Returns the outcome — never throws on focus
 * mismatch; callers decide whether mismatch is fatal (page.type makes it so;
 * page.focus reports it back to the model).
 */
async function focusAuto(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
): Promise<FocusOutcome> {
  await jsFocus(mgr, tabId, el);
  let v = await verifyFocus(mgr, tabId, el);
  if (v.matches) return { focused: true, modeUsed: "js" };
  // Escalate: real coordinate click. Reaches the OS-level focus router and
  // dislodges most apps' internal focus management.
  await coordinateClick(mgr, tabId, el.objectId, el.targetId);
  v = await verifyFocus(mgr, tabId, el);
  return { focused: v.matches, modeUsed: "click", actual: v.matches ? undefined : v };
}

/* ---------- Actionability gate ---------- */

/**
 * A human doesn't click a control that's still spinning in, mid-animation, or
 * disabled — they wait the half-second until it's real. waitForActionable
 * mirrors that: poll (≤ timeoutMs) until the element is connected, has a
 * non-zero box, isn't visibility:hidden / display:none, isn't disabled /
 * aria-disabled, and has a stable position across two samples (catches
 * mid-animation). Runs in the element's own session, so it works inside
 * cross-origin iframes (OOPIFs).
 */
interface ActionableState {
  actionable: boolean;
  reason?: string;
}

export async function waitForActionable(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
  timeoutMs = 5_000,
): Promise<ActionableState> {
  const deadline = Date.now() + timeoutMs;
  let last: { x: number; y: number } | undefined;
  let lastReason = "not-ready";
  for (;;) {
    const r = await mgr.sendCommand<{ result: { value?: { ok: boolean; reason?: string; x?: number; y?: number } } }>(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: el.objectId,
        functionDeclaration: `function() {
          if (!(this instanceof Element)) return { ok:false, reason:"not-an-element" };
          if (!this.isConnected) return { ok:false, reason:"detached" };
          const r = this.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return { ok:false, reason:"zero-size" };
          const cs = getComputedStyle(this);
          if (cs.visibility === "hidden" || cs.display === "none") return { ok:false, reason:"hidden" };
          if (this.disabled || this.getAttribute("aria-disabled") === "true") return { ok:false, reason:"disabled" };
          return { ok:true, x:r.x, y:r.y };
        }`,
        returnByValue: true,
      },
      el.targetId,
    );
    // An exception inside the predicate yields no value — treat as not ready, never crash.
    const v = r.result?.value ?? { ok: false, reason: "not-inspectable" };
    if (v.ok) {
      // Require positional stability across two samples to avoid acting mid-animation.
      if (last && Math.abs(last.x - (v.x ?? 0)) <= 1 && Math.abs(last.y - (v.y ?? 0)) <= 1) {
        return { actionable: true };
      }
      last = { x: v.x ?? 0, y: v.y ?? 0 };
    } else {
      lastReason = v.reason ?? "not-ready";
      last = undefined;
    }
    if (Date.now() >= deadline) return { actionable: false, reason: lastReason };
    await sleep(60);
  }
}

// In-page scroll function (self-contained, no closures).
function inPageScroll(
  dx: number | undefined,
  dy: number | undefined,
  selector: string | undefined,
  to: "top" | "bottom" | undefined,
  smooth: boolean,
) {
  const behavior: ScrollBehavior = smooth ? "smooth" : ("instant" as ScrollBehavior);
  if (selector !== undefined) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`selector did not match: ${selector}`);
    el.scrollIntoView({ behavior, block: "center", inline: "center" });
  } else if (to === "top") {
    window.scrollTo({ top: 0, left: 0, behavior });
  } else if (to === "bottom") {
    window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior });
  } else {
    window.scrollBy({ left: dx ?? 0, top: dy ?? 0, behavior });
  }
  return { ok: true as const };
}

/* ---------- Emptiness guard (requireEmpty) ---------- */

/**
 * Generic content check on the focused element (or its active descendant):
 * value, text or selected text. Apps that expose content ONLY through an
 * accessible name are not covered — the caller can inspect
 * focus.activeDescendantName for those.
 */
function firstNonEmptyText(state: FocusState): { source: string; text: string } | undefined {
  const candidates: Array<[string, string | undefined]> = state.activeDescendant
    ? [
        ["activeDescendantValue", state.activeDescendantValue],
        ["activeDescendantText", state.activeDescendantText],
        ["activeValue", state.activeValue],
        ["selectedText", state.selectedText],
      ]
    : [
        ["activeValue", state.activeValue],
        ["activeText", state.activeText],
        ["selectedText", state.selectedText],
      ];

  for (const [source, text] of candidates) {
    const trimmed = text?.trim();
    if (trimmed) return { source, text: trimmed };
  }
  return undefined;
}

async function assertEmptyFocusTarget(
  mgr: DebuggerManager,
  tabId: number,
  targetId?: string,
): Promise<void> {
  const state = await readFocusState(mgr, tabId, targetId);
  const existing = firstNonEmptyText(state);
  if (!existing) return;
  const location = state.activeDescendant
    ? `active descendant ${state.activeDescendant}` +
      `${state.activeDescendantRowIndex ? ` row=${state.activeDescendantRowIndex}` : ""}` +
      `${state.activeDescendantColIndex ? ` col=${state.activeDescendantColIndex}` : ""}`
    : `active <${state.activeTag} role="${state.activeRole ?? ""}">`;
  throw new Error(
    `page.type requireEmpty refused to type because ${location} already has ${existing.source}="${existing.text.slice(0, 120)}". ` +
    `Use page_focus_state/page_screenshot to verify the target, then clear or choose another cell before typing.`,
  );
}

/* ---------- Clearing a field through real input ---------- */

type ClearOutcome = "cleared" | "already-empty" | "not-editable" | "failed";

const READ_EDITABLE_TEXT = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) return String(this.value || "");
  return String(this.textContent || "");
}`;

/**
 * Empty an input/textarea/contenteditable the way a person would: select its
 * contents, press Backspace, and verify. Assigning value/textContent directly
 * bypasses frameworks and rich editors that keep their own model (the next
 * typed text then gets merged with the old content).
 */
async function clearField(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
  mac: boolean,
): Promise<{ outcome: ClearOutcome; remaining?: string }> {
  const kind = await callOn<"input" | "editable" | "empty" | "none">(mgr, tabId, el, `function() {
    const textual = (this instanceof HTMLTextAreaElement) ||
      (this instanceof HTMLInputElement && !/^(checkbox|radio|file|button|submit|reset|image|color|range|hidden)$/i.test(this.type));
    if (textual) {
      if (this.value === "") return "empty";
      try { this.select(); } catch (e) {}
      return "input";
    }
    if (this.isContentEditable) return (this.textContent || "") === "" ? "empty" : "editable";
    return "none";
  }`);
  if (kind === "empty") return { outcome: "already-empty" };
  if (kind === "none") return { outcome: "not-editable" };

  const selectAllKey = { key: "a", code: "KeyA", keyCode: 65 };
  const selectAll = () => dispatchKey(mgr, tabId, selectAllKey, shortcutModifier(mac), el.targetId, mac);
  const backspace = () => dispatchKey(mgr, tabId, KEY_DEFS.Backspace!, 0, el.targetId, mac);
  const remaining = () => callOn<string>(mgr, tabId, el, READ_EDITABLE_TEXT);

  // Inputs: select() covers the value for text-like types; email/number reject
  // selection APIs, so fall back to the platform select-all shortcut.
  if (kind === "input") {
    const covered = await callOn<boolean>(mgr, tabId, el, `function() {
      try { return this.selectionStart === 0 && this.selectionEnd === this.value.length; } catch (e) { return false; }
    }`);
    if (!covered) await selectAll();
  } else {
    await selectAll();
  }
  await backspace();
  let left = await remaining();
  if (left === "") return { outcome: "cleared" };

  // Second chance for contenteditables whose app didn't scope select-all to
  // the element: select exactly the node's contents via the Selection API.
  if (kind === "editable") {
    await callOn(mgr, tabId, el, `function() {
      const doc = this.ownerDocument, sel = doc.getSelection(), range = doc.createRange();
      range.selectNodeContents(this); sel.removeAllRanges(); sel.addRange(range);
    }`);
    await backspace();
    left = await remaining();
    if (left === "") return { outcome: "cleared" };
  }
  return { outcome: "failed", remaining: left };
}

/* ---------- Typed-text fidelity (inline completion) ---------- */

/** Text of a field: input/textarea value, contenteditable text; null when not a text field. */
const READ_FIELD_TEXT = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) return String(this.value || "");
  if (this.isContentEditable) return String(this.textContent || "");
  return null;
}`;

const READ_ACTIVE_FIELD_TEXT = `(() => {
  const a = document.activeElement;
  if (!a) return null;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return String(a.value || "");
  if (a.isContentEditable) return String(a.textContent || "");
  return null;
})()`;

type FieldReader = () => Promise<string | null>;

function fieldReader(mgr: DebuggerManager, tabId: number, el: ResolvedElement | undefined, targetId: string | undefined): FieldReader {
  if (el) {
    return async () => {
      const v = await callOn<unknown>(mgr, tabId, el, READ_FIELD_TEXT).catch(() => null);
      return typeof v === "string" ? v : null;
    };
  }
  return async () => {
    try {
      const r = await mgr.sendCommand<{ result?: { value?: unknown } }>(
        tabId, "Runtime.evaluate", { expression: READ_ACTIVE_FIELD_TEXT, returnByValue: true }, targetId,
      );
      return typeof r.result?.value === "string" ? r.result.value : null;
    } catch {
      return null;
    }
  };
}

export interface CompletionReport {
  typed: string;
  fieldShowed: string;
  removed: boolean;
  fieldNow: string;
}

/**
 * Many widgets inline-complete what you type (search boxes, comboboxes,
 * address bars, spreadsheet cells): the field shows the typed text followed by
 * a suggested remainder, which Enter/Tab would then accept. When the field was
 * empty before typing and now holds the typed text plus more, press Delete —
 * the standard way to drop an inline suggestion — and report what happened.
 */
async function dropInlineCompletion(
  mgr: DebuggerManager,
  tabId: number,
  typed: string,
  read: FieldReader,
  targetId: string | undefined,
  mac: boolean,
): Promise<CompletionReport | undefined> {
  const shown = await read();
  if (shown === null || shown === typed || shown.length <= typed.length || !shown.startsWith(typed)) return undefined;
  await dispatchKey(mgr, tabId, KEY_DEFS.Delete!, 0, targetId, mac);
  let now = await read();
  for (let i = 0; i < 15 && now !== typed; i++) {
    await sleep(40);
    now = await read();
  }
  return { typed, fieldShowed: shown, removed: now === typed, fieldNow: now ?? "" };
}

/** Popups visible in a frame before an action — the baseline for "what did this action open?". */
async function popupBaseline(mgr: DebuggerManager, tabId: number, targetId: string | undefined): Promise<PopupBaseline | undefined> {
  try {
    const s = await readFocusState(mgr, tabId, targetId);
    return { targetId, popups: s.popups ?? [] };
  } catch {
    return undefined;
  }
}

/* ---------- Paste plumbing ---------- */

const PASTE_PROBE_KEY = "__chromanchePasteProbe";

/**
 * Arm a one-shot observer for the next TRUSTED paste event in a frame. Capture
 * phase records delivery; the bubble phase (or a 0ms timer when the page stops
 * propagation) records whether the page took it over (preventDefault).
 */
const ARM_PASTE_PROBE = `(() => {
  const K = ${JSON.stringify(PASTE_PROBE_KEY)};
  try { const prev = window[K]; if (prev && prev.dispose) prev.dispose(); } catch (e) {}
  const probe = { fired: false, prevented: null, target: null };
  const cap = (e) => {
    if (!e.isTrusted) return;
    probe.fired = true;
    const t = e.target;
    probe.target = t && t.tagName ? t.tagName.toLowerCase() : null;
    setTimeout(() => { if (probe.prevented === null) probe.prevented = e.defaultPrevented; }, 0);
  };
  const bub = (e) => { if (e.isTrusted) probe.prevented = e.defaultPrevented; };
  window.addEventListener("paste", cap, true);
  window.addEventListener("paste", bub, false);
  probe.dispose = () => {
    window.removeEventListener("paste", cap, true);
    window.removeEventListener("paste", bub, false);
  };
  Object.defineProperty(window, K, { value: probe, configurable: true, enumerable: false, writable: true });
  return true;
})()`;

const READ_PASTE_PROBE = `(() => {
  const p = window[${JSON.stringify(PASTE_PROBE_KEY)}];
  return p ? { fired: p.fired, prevented: p.prevented, target: p.target } : null;
})()`;

const DISPOSE_PASTE_PROBE = `(() => {
  const K = ${JSON.stringify(PASTE_PROBE_KEY)};
  const p = window[K];
  if (p && p.dispose) p.dispose();
  try { delete window[K]; } catch (e) {}
  return true;
})()`;

/**
 * Put text on the system clipboard from the focused frame without moving
 * focus: async Clipboard API first; else run the copy command with a one-shot
 * listener that substitutes our text (the page's own copy handlers are
 * suppressed). Both need the document focused + a user gesture, which
 * Runtime.evaluate(userGesture) provides.
 */
function writeClipboardExpr(text: string): string {
  return `(async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return "clipboard-api";
      }
    } catch (e) {}
    let ok = false;
    const onCopy = (e) => {
      try { e.clipboardData.setData("text/plain", text); e.preventDefault(); e.stopImmediatePropagation(); ok = true; } catch (err) {}
    };
    window.addEventListener("copy", onCopy, true);
    try { document.execCommand("copy"); } catch (e) {} finally { window.removeEventListener("copy", onCopy, true); }
    return ok ? "copy-event" : "failed";
  })(${JSON.stringify(text)})`;
}

async function evalIn<T>(
  mgr: DebuggerManager,
  tabId: number,
  targetId: string | undefined,
  expression: string,
  extra: Record<string, unknown> = {},
): Promise<T | undefined> {
  const r = await mgr.sendCommand<{ result?: { value?: T } }>(
    tabId, "Runtime.evaluate", { expression, returnByValue: true, ...extra }, targetId,
  );
  return r.result?.value;
}

/* ---------- handlers ---------- */

export function registerPageInteractHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.click", async (raw) => {
    const p = PageClickParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    if (!p.force) {
      const act = await waitForActionable(mgr, p.tabId, el, p.timeoutMs);
      if (!act.actionable) {
        throw new Error(
          `page.click target not actionable: ${act.reason}. ` +
          `The element isn't ready (hidden/disabled/animating/detached). ` +
          `Wait for it (page_wait) or pass force=true to click anyway.`,
        );
      }
    }
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId, el.targetId);
    await mouseClickAt(mgr, p.tabId, x, y, p.button, 1, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  // page.clickXy: the vision escape hatch for canvas-like widgets where no
  // element maps to the target. x/y default to pixels of the latest
  // screenshot of this tab and are mapped back to CSS viewport px with its
  // transform — the image the model sees is downscaled, so raw image
  // coordinates are NOT viewport coordinates. Dispatched on the top tab
  // session; Chrome routes the event into whichever (OOP)iframe is under it.
  d.register("page.clickXy", async (raw) => {
    const p = PageClickXyParamsSchema.parse(raw);
    const pt = toCssPoint(p.tabId, p.x, p.y, p.space);
    const baseline = p.settle ? await popupBaseline(mgr, p.tabId, await focusedKeyboardTarget(mgr, p.tabId)) : undefined;
    await mouseClickAt(mgr, p.tabId, pt.x, pt.y, p.button, p.clickCount);
    const focus = p.settle ? await settleFocus(mgr, p.tabId, {}, baseline) : undefined;
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, point: { x: pt.x, y: pt.y }, spaceUsed: pt.spaceUsed, focus, snapshot };
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);
    const mac = await isMacBrowser();
    const mods = modifierFlags(p.modifiers, mac);
    // Field-level fidelity checks only make sense for plain text typed into ONE
    // field: Tab/Enter move focus, chords aren't text.
    const singleField = !/[\t\r\n]/.test(p.text) && (mods & ~MOD_SHIFT) === 0 && p.text.length > 0;
    const checkExact = p.exact && p.settle && singleField;

    // No-target path: no uid, no selector → dispatch keystrokes at the current
    // focus without resolving or focusing any element. The canonical
    // primitive for typing into a canvas-like widget after a click.
    if (!p.uid && !p.selector) {
      let targetId: string | undefined;
      let before: string | null = null;
      let baseline: PopupBaseline | undefined;
      try {
        targetId = await focusedKeyboardTarget(mgr, p.tabId);
        if (p.requireEmpty) await assertEmptyFocusTarget(mgr, p.tabId, targetId);
        if (checkExact) before = await fieldReader(mgr, p.tabId, undefined, targetId)();
        if (p.settle) baseline = await popupBaseline(mgr, p.tabId, targetId);
        for (const ch of p.text) {
          await dispatchKey(mgr, p.tabId, charToKeyDef(ch), mods, targetId, mac);
        }
      } catch (e) {
        throw translateCdpError(e);
      }
      let focus = p.settle ? await settleFocus(mgr, p.tabId, {}, baseline) : undefined;
      const completion = checkExact && before === ""
        ? await dropInlineCompletion(mgr, p.tabId, p.text, fieldReader(mgr, p.tabId, undefined, targetId), targetId, mac)
        : undefined;
      if (completion) focus = await settleFocus(mgr, p.tabId, {}, baseline);
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return { ok: true as const, ...(completion ? { completion } : {}), focus, snapshot };
    }

    let el: ResolvedElement;
    try {
      el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    } catch (e) {
      throw translateCdpError(e);
    }

    if (!p.force) {
      const act = await waitForActionable(mgr, p.tabId, el, p.timeoutMs);
      if (!act.actionable) {
        throw new Error(
          `page.type target not actionable: ${act.reason}. ` +
          `The element isn't ready (hidden/disabled/animating/detached). ` +
          `Wait for it (page_wait) or pass force=true to type anyway.`,
        );
      }
    }

    // Self-verifying focus: JS focus → verify → escalate to coordinate-click
    // on mismatch → verify again. If both attempts fail we throw a structured
    // error including what activeElement actually became. Cross-extension
    // iframes (1Password etc.) keep their own coordinate-click fallback
    // because Chrome refuses JS access there.
    let usedFallback = false;
    let outcome: FocusOutcome;
    try {
      outcome = await focusAuto(mgr, p.tabId, el);
    } catch (e) {
      if (!isCrossExtensionError(e)) throw translateCdpError(e);
      usedFallback = true;
      try {
        await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      } catch (ce) {
        throw translateCdpError(ce);
      }
      outcome = { focused: true, modeUsed: "click" };
    }
    if (!outcome.focused) {
      const a = outcome.actual!;
      throw new Error(
        `page.type couldn't focus the target — activeElement is <${a.actualTag} role="${a.actualRole ?? ""}" name="${a.actualName ?? ""}">. ` +
        `The page is grabbing focus elsewhere. ` +
        `Try page.focus(uid, mode: "blur+click") or use an app-specific anchor.`,
      );
    }

    if (p.requireEmpty) await assertEmptyFocusTarget(mgr, p.tabId, el.targetId);

    // Clear through real input (select contents + Backspace, verified). In
    // the cross-extension fallback we can't inspect the field, so we skip
    // clearing rather than fire blind key combos — login fields start empty.
    if (p.clear && !usedFallback) {
      let cleared: { outcome: ClearOutcome; remaining?: string };
      try {
        cleared = await clearField(mgr, p.tabId, el, mac);
      } catch (e) {
        if (!isCrossExtensionError(e)) throw translateCdpError(e);
        cleared = { outcome: "not-editable" };
      }
      if (cleared.outcome === "failed") {
        throw new Error(
          `page.type couldn't clear the field — it still contains "${(cleared.remaining ?? "").slice(0, 120)}". ` +
          `Nothing was typed. Pass clear:false to append instead, or clear it another way first.`,
        );
      }
    }

    const read = fieldReader(mgr, p.tabId, el, el.targetId);
    const before = checkExact && !usedFallback ? await read() : null;
    const baseline = p.settle ? await popupBaseline(mgr, p.tabId, el.targetId) : undefined;

    // Real keystrokes (keyDown + keyUp per char). Input.insertText would be
    // faster but bypasses the keyboard pipeline that rich editors rely on to
    // commit values.
    try {
      for (const ch of p.text) {
        await dispatchKey(mgr, p.tabId, charToKeyDef(ch), mods, el.targetId, mac);
      }
    } catch (e) {
      throw translateCdpError(e);
    }

    let focus = p.settle ? await settleFocus(mgr, p.tabId, {}, baseline) : undefined;
    const completion = before === ""
      ? await dropInlineCompletion(mgr, p.tabId, p.text, read, el.targetId, mac)
      : undefined;
    if (completion) focus = await settleFocus(mgr, p.tabId, {}, baseline);

    if (p.submit && !usedFallback) {
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      }, el.targetId).catch((e) => { if (!isCrossExtensionError(e)) throw translateCdpError(e); });
    }

    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, ...(completion ? { completion } : {}), focus, snapshot };
  });

  /**
   * page.paste: put text on the clipboard and press the platform paste
   * shortcut — ⌘V on macOS, Ctrl+V on Windows / Linux / ChromeOS — exactly as
   * a person would. On macOS the key event carries the "paste" editing
   * command; without it Chrome delivers a bare keydown and nothing is pasted.
   * Success is VERIFIED: a one-shot probe in the focused frame must observe a
   * trusted paste event, otherwise we throw instead of reporting a phantom ok.
   */
  d.register("page.paste", async (raw) => {
    const p = PagePasteParamsSchema.parse(raw);
    const mac = await isMacBrowser();

    let el: ResolvedElement | undefined;
    if (p.target === "uid") {
      el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
      const out = await focusAuto(mgr, p.tabId, el);
      if (!out.focused) {
        const a = out.actual!;
        throw new Error(
          `page.paste couldn't focus uid target — activeElement is <${a.actualTag} role="${a.actualRole ?? ""}" name="${a.actualName ?? ""}">.`,
        );
      }
    } else if (p.target === "xy") {
      const pt = toCssPoint(p.tabId, p.x!, p.y!, p.space);
      await mouseClickAt(mgr, p.tabId, pt.x, pt.y, "left", 1);
      // Let the app move its selection/focus before we look for the focused frame.
      await sleep(120);
    }

    const targetId = el?.targetId ?? (await focusedKeyboardTarget(mgr, p.tabId));
    const baseline = p.settle ? await popupBaseline(mgr, p.tabId, targetId) : undefined;
    await evalIn(mgr, p.tabId, targetId, ARM_PASTE_PROBE);
    try {
      const via = await evalIn<string>(mgr, p.tabId, targetId, writeClipboardExpr(p.text), {
        awaitPromise: true,
        userGesture: true,
      });
      if (via !== "clipboard-api" && via !== "copy-event") {
        throw new Error(
          "page.paste couldn't write to the clipboard (the focused document refused both the Clipboard API and the copy command). " +
          "Make sure the tab's window is not minimized and focus is inside the page.",
        );
      }

      await dispatchKey(mgr, p.tabId, { key: "v", code: "KeyV", keyCode: 86 }, shortcutModifier(mac), targetId, mac);

      let probe: { fired: boolean; prevented: boolean | null; target: string | null } | null | undefined;
      const deadline = Date.now() + 1_500;
      for (;;) {
        probe = await evalIn(mgr, p.tabId, targetId, READ_PASTE_PROBE);
        if (probe?.fired && probe.prevented !== null) break;
        if (Date.now() >= deadline) break;
        await sleep(40);
      }
      if (!probe?.fired) {
        const st = await readFocusState(mgr, p.tabId, targetId).catch(() => undefined);
        const where = st ? `<${st.activeTag}${st.activeRole ? ` role="${st.activeRole}"` : ""}${st.activeName ? ` name="${st.activeName.slice(0, 60)}"` : ""}>` : "the focused element";
        throw new Error(
          `page.paste: the ${mac ? "⌘V" : "Ctrl+V"} keystroke was delivered but no paste event reached ${where} — nothing was pasted. ` +
          `Focus a cell/field that accepts paste first (page_focus_state shows where focus is). The text is still on the clipboard.`,
        );
      }

      const focus = p.settle ? await settleFocus(mgr, p.tabId, {}, baseline) : undefined;
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return {
        ok: true as const,
        bytesWritten: p.text.length,
        pasteDelivered: true,
        ...(typeof probe.prevented === "boolean" ? { pasteHandledByPage: probe.prevented } : {}),
        focus,
        snapshot,
      };
    } finally {
      await evalIn(mgr, p.tabId, targetId, DISPOSE_PASTE_PROBE).catch(() => undefined);
    }
  });

  d.register("page.scroll", async (raw) => {
    const p = PageScrollParamsSchema.parse(raw);

    if (p.mode === "wheel") {
      // Real wheel event so virtualized grids/canvases lazy-load rows.
      // Anchor the cursor at the uid/selector centre when given, else viewport centre.
      let x: number;
      let y: number;
      let targetId: string | undefined;
      if (p.uid || p.selector) {
        const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
        const c = await getElementCenter(mgr, p.tabId, el.objectId, el.targetId);
        x = c.x;
        y = c.y;
        targetId = el.targetId;
      } else {
        const [{ result: vp }] = await chrome.scripting.executeScript({
          target: { tabId: p.tabId },
          func: () => ({ w: window.innerWidth, h: window.innerHeight }),
        });
        x = Math.floor((vp as { w: number }).w / 2);
        y = Math.floor((vp as { h: number }).h / 2);
      }
      // Hover first: wheel handlers of some grids only engage once the pointer is over them.
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button: "none", buttons: 0,
      }, targetId);
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: p.dx ?? 0, deltaY: p.dy ?? 0,
      }, targetId);
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return { ok: true as const, snapshot };
    }

    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageScroll,
      args: [p.dx, p.dy, p.selector, p.to, p.smooth],
    });
    if (entry && "error" in entry && entry.error) throw new Error(String(entry.error));
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.hover", async (raw) => {
    const p = PageHoverParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId, el.targetId);
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y,
    }, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.focus", async (raw) => {
    const p = PageFocusParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);

    let modeUsed: "js" | "click" | "blur+click";
    if (p.mode === "js") {
      await jsFocus(mgr, p.tabId, el);
      modeUsed = "js";
    } else if (p.mode === "click") {
      await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      modeUsed = "click";
    } else if (p.mode === "blur+click") {
      await blurActive(mgr, p.tabId, el);
      await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      modeUsed = "blur+click";
    } else {
      // auto: gentle then aggressive, mirroring page.type's path.
      const out = await focusAuto(mgr, p.tabId, el);
      const v = await verifyFocus(mgr, p.tabId, el);
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return {
        ok: true as const,
        focused: v.matches,
        modeUsed: out.modeUsed,
        actualTag: v.matches ? undefined : v.actualTag,
        actualRole: v.matches ? undefined : v.actualRole,
        actualName: v.matches ? undefined : v.actualName,
        snapshot,
      };
    }

    const v = await verifyFocus(mgr, p.tabId, el);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return {
      ok: true as const,
      focused: v.matches,
      modeUsed,
      actualTag: v.matches ? undefined : v.actualTag,
      actualRole: v.matches ? undefined : v.actualRole,
      actualName: v.matches ? undefined : v.actualName,
      snapshot,
    };
  });

  d.register("page.pressKey", async (raw) => {
    const p = PagePressKeyParamsSchema.parse(raw);
    const mac = await isMacBrowser();
    const targetId = await focusedKeyboardTarget(mgr, p.tabId);
    const baseline = p.settle ? await popupBaseline(mgr, p.tabId, targetId) : undefined;
    await dispatchKey(mgr, p.tabId, resolveKey(p.key), modifierFlags(p.modifiers, mac), targetId, mac);
    const focus = p.settle ? await settleFocus(mgr, p.tabId, {}, baseline) : undefined;
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, focus, snapshot };
  });

  d.register("page.focusState", async (raw) => {
    const p = PageFocusStateParamsSchema.parse(raw);
    return readFocusState(mgr, p.tabId, await focusedKeyboardTarget(mgr, p.tabId));
  });

  d.register("page.fillForm", async (raw) => {
    const p = PageFillFormParamsSchema.parse(raw);
    const mac = await isMacBrowser();
    let filled = 0;
    for (const field of p.fields) {
      const el = await resolveElement(mgr, p.tabId, field.uid, field.selector);
      // Focus + clear through real input; fall back to a coordinate click when
      // another extension's iframe blocks JS access (we then skip clearing).
      try {
        await jsFocus(mgr, p.tabId, el);
        const cleared = await clearField(mgr, p.tabId, el, mac);
        if (cleared.outcome === "failed") {
          throw new Error(
            `page.fillForm couldn't clear field ${field.uid ?? field.selector} — it still contains "${(cleared.remaining ?? "").slice(0, 120)}".`,
          );
        }
      } catch (e) {
        if (!isCrossExtensionError(e)) throw translateCdpError(e);
        try {
          await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
        } catch (ce) {
          throw translateCdpError(ce);
        }
      }
      try {
        for (const ch of field.value) {
          await dispatchKey(mgr, p.tabId, charToKeyDef(ch), 0, el.targetId, mac);
        }
      } catch (e) {
        throw translateCdpError(e);
      }
      filled++;
    }
    if (p.submit) {
      const lastField = p.fields[p.fields.length - 1];
      const el = await resolveElement(mgr, p.tabId, lastField!.uid, lastField!.selector);
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      }, el.targetId).catch((e) => { if (!isCrossExtensionError(e)) throw translateCdpError(e); });
    }
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, filledCount: filled, snapshot };
  });

  d.register("page.handleDialog", async (raw) => {
    const p = PageHandleDialogParamsSchema.parse(raw);
    const pending = mgr.getPendingDialog(p.tabId);
    if (!pending) {
      // No dialog open — nothing to do. Report it honestly rather than throwing.
      return { ok: true as const, handled: false };
    }
    const payload: Record<string, unknown> = { accept: p.action === "accept" };
    if (p.promptText !== undefined) payload.promptText = p.promptText;
    await mgr.sendCommand(p.tabId, "Page.handleJavaScriptDialog", payload);
    mgr.clearPendingDialog(p.tabId);
    return {
      ok: true as const,
      handled: true,
      dialogType: pending.type,
      dialogMessage: pending.message,
    };
  });

  d.register("page.select", async (raw) => {
    const p = PageSelectParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    // Set selected options by value-or-text match. Dispatch change/input events.
    const result = await mgr.sendCommand<{ result: { value: string[] } }>(
      p.tabId,
      "Runtime.callFunctionOn",
      {
        objectId: el.objectId,
        functionDeclaration: `function(values) {
          if (this.tagName !== 'SELECT') {
            throw new Error('page.select target is not a <select> element: ' + this.tagName);
          }
          const wanted = new Set(values);
          const picked = [];
          for (const opt of this.options) {
            const match = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.textContent?.trim() ?? '');
            opt.selected = match;
            if (match) picked.push(opt.value);
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return picked;
        }`,
        arguments: [{ value: p.values }],
        returnByValue: true,
      },
      el.targetId,
    );
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, selected: result.result.value ?? [], snapshot };
  });

  d.register("page.uploadFile", async (raw) => {
    const p = PageUploadFileParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    await mgr.sendCommand(p.tabId, "DOM.setFileInputFiles", {
      files: p.filePaths,
      objectId: el.objectId,
    }, el.targetId);
    // Dispatch input/change so frameworks notice the file list changed.
    await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
      objectId: el.objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      returnByValue: true,
    }, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, uploadedCount: p.filePaths.length, snapshot };
  });

  d.register("page.drag", async (raw) => {
    const p = PageDragParamsSchema.parse(raw);
    const from = await resolveElement(mgr, p.tabId, p.fromUid, p.fromSelector);
    const to = await resolveElement(mgr, p.tabId, p.toUid, p.toSelector);
    // Drag across frame boundaries would need per-event coordinate translation
    // into whichever frame the pointer is currently inside. We don't support
    // that; require both endpoints in the same frame (including both == main).
    if (from.targetId !== to.targetId) {
      throw new Error(
        "page.drag endpoints live in different frames; cross-frame drag is not supported",
      );
    }
    const dragTarget = from.targetId;
    const fromC = await getElementCenter(mgr, p.tabId, from.objectId, dragTarget);
    const toC = await getElementCenter(mgr, p.tabId, to.objectId, dragTarget);
    const targetX = toC.x + (p.toOffsetX ?? 0);
    const targetY = toC.y + (p.toOffsetY ?? 0);

    // Press at source.
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: fromC.x, y: fromC.y, button: "left", buttons: 1, clickCount: 1,
    }, dragTarget);
    // Move in steps (HTML5 drag needs multiple move events between press and release).
    for (let i = 1; i <= p.steps; i++) {
      const t = i / p.steps;
      const x = fromC.x + (targetX - fromC.x) * t;
      const y = fromC.y + (targetY - fromC.y) * t;
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button: "left", buttons: 1,
      }, dragTarget);
    }
    // Release at target.
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: targetX, y: targetY, button: "left", buttons: 0, clickCount: 1,
    }, dragTarget);

    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });
}

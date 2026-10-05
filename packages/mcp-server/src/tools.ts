import { z } from "zod";
import {
  TabsListParamsSchema,
  TabsCreateParamsSchema,
  TabsCloseParamsSchema,
  TabsActivateParamsSchema,
  PageNavigateParamsSchema,
  PageSnapshotParamsSchema,
  PageScreenshotParamsSchema,
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PagePasteParamsSchema,
  PageWaitParamsSchema,
  PageWaitForDownloadParamsSchema,
  PageHoverParamsSchema,
  PageFocusParamsSchema,
  PageClickXyParamsSchema,
  PagePressKeyParamsSchema,
  PageFocusStateParamsSchema,
  PageFillFormParamsSchema,
  PageHandleDialogParamsSchema,
  PageSelectParamsSchema,
  PageUploadFileParamsSchema,
  PageDragParamsSchema,
  PageFetchParamsSchema,
  SessionReleaseParamsSchema,
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
  NetworkGetRequestParamsSchema,
  ProfilesListParamsSchema,
} from "@chromanche/shared";
import type { BridgeServer } from "./bridge.js";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[] };
interface Tool<P> {
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (params: P) => Promise<ToolResult>;
}

/**
 * Names of every batchable tool. Kept as a literal union so the model sees
 * an enum in the JSON schema and can't ask for nonexistent tools. page_batch
 * is intentionally absent — no batches inside batches.
 */
export const BATCHABLE_TOOLS = [
  "tabs_list", "tabs_create", "tabs_close", "tabs_activate",
  "page_navigate", "page_snapshot", "page_screenshot",
  "page_click", "page_click_xy", "page_type", "page_paste", "page_scroll",
  "page_hover", "page_focus", "page_press_key", "page_focus_state", "page_fill_form",
  "page_handle_dialog", "page_select", "page_upload_file", "page_drag",
  "page_wait",
  "page_fetch", "page_eval_js",
  "console_read", "network_read", "network_get_request",
  "session_release",
] as const;

export const PageBatchStepSchema = z.object({
  tool: z.enum(BATCHABLE_TOOLS),
  args: z.record(z.unknown()),
}).strict();

/**
 * Run several Chromanche tools sequentially in one MCP round-trip. Eliminates
 * per-step model-loop latency for known sequences (click → type → screenshot,
 * fill several fields, navigate then snapshot). Steps run in order; the first
 * failing step aborts by default. stopOnError=false runs every step and
 * surfaces per-step errors inline.
 */
export const PageBatchParamsSchema = z.object({
  steps: z.array(PageBatchStepSchema).min(1).max(32),
  stopOnError: z.boolean().default(true),
}).strict();

const PROFILE_FIELD = z.string().min(1).optional()
  .describe("Target a specific Chrome profile (from chromanche_list_profiles). Omit if only one profile is connected.");

/**
 * Add an optional top-level `profile` field to a schema for Claude Code's tool
 * listing. Handles both ZodObject and ZodEffects (objects wrapped with
 * .superRefine / .refine): for the latter we reach into the underlying object
 * via `_def.schema`. The handler still re-parses with the original refined
 * schema, so profile routing and refinements stay enforced.
 */
function withProfile(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    return schema.extend({ profile: PROFILE_FIELD });
  }
  if (schema instanceof z.ZodEffects) {
    const inner = (schema as z.ZodEffects<z.ZodTypeAny>)._def.schema;
    if (inner instanceof z.ZodObject) {
      return inner.extend({ profile: PROFILE_FIELD });
    }
  }
  // Fallback: intersection with {profile?} so Claude still sees the field.
  return z.intersection(schema, z.object({ profile: PROFILE_FIELD }));
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Throws when no extension is connected; `help` (e.g. WSL manual pairing steps) is appended to the error. */
export function assertConnected(bridge: Pick<BridgeServer, "isConnected">, help?: string) {
  if (!bridge.isConnected()) {
    throw new Error(
      "no extension connected — install and enable the Chromanche Chrome extension on at least one Chrome profile" +
        (help ? `\n\n${help}` : ""),
    );
  }
}

function splitProfile<P extends Record<string, unknown>>(
  params: P,
): { profile?: string; params: Omit<P, "profile"> } {
  if (params && typeof params === "object" && "profile" in params) {
    const { profile, ...rest } = params as { profile?: string } & Record<string, unknown>;
    return { profile, params: rest as Omit<P, "profile"> };
  }
  return { params: params as Omit<P, "profile"> };
}

/**
 * Walk a parsed tool-result JSON value and replace any string field named
 * "base64" longer than this threshold with a short sentinel that records the
 * original length. Used by page_batch to keep multi-step results under the
 * MCP tool-result size cap when one of the steps is a screenshot. The model
 * can still call page_screenshot outside the batch to get the actual bytes.
 *
 * Threshold ~30KB chosen empirically: a 1280×800 JPEG @ quality 40 is ~76KB
 * → over the cap; a thumbnail is well under.
 */
const BATCH_BASE64_THRESHOLD = 30_000;

function redactOversizedBase64(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOversizedBase64);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "base64" && typeof v === "string" && v.length > BATCH_BASE64_THRESHOLD) {
        out[k] = `<truncated: ${v.length} bytes — call page_screenshot directly for the full image>`;
      } else {
        out[k] = redactOversizedBase64(v);
      }
    }
    return out;
  }
  return value;
}

export interface BuildToolsOptions {
  /** Appended to "no extension connected" errors (under WSL: how to pair by hand). */
  notConnectedHelp?: string | undefined;
}

export function buildTools(bridge: BridgeServer, opts: BuildToolsOptions = {}) {
  const guard = (b: Pick<BridgeServer, "isConnected">) => assertConnected(b, opts.notConnectedHelp);
  // Per-profile claim set: a tabId only makes sense within a single Chrome instance.
  const claimed = new Set<string>();
  async function ensureClaim(tabId: number, profile?: string) {
    const key = `${profile ?? "_"}::${tabId}`;
    if (claimed.has(key)) return;
    await bridge.call("session.claim", { tabId }, profile);
    claimed.add(key);
  }

  const chromanche_list_profiles: Tool<Record<string, never>> = {
    description:
      "List the Chromanche Chrome extensions currently connected to this MCP server. Each entry has {tag, label, connectedAt}. Call this first when more than one profile may be available; pass the chosen tag as `profile` in subsequent tool calls.",
    inputSchema: ProfilesListParamsSchema,
    handler: async () => {
      return text(bridge.listProfiles());
    },
  };

  const tabs_list: Tool<{ profile?: string }> = {
    description: "List all tabs across all windows in the target Chrome profile.",
    inputSchema: withProfile(TabsListParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.list", {}, profile));
    },
  };

  const tabs_create: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsCreateParamsSchema>>>> = {
    description: "Open a new Chrome tab at the given URL. Auto-claims the new tab.",
    inputSchema: withProfile(TabsCreateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = TabsCreateParamsSchema.parse(p);
      const tab = (await bridge.call("tabs.create", parsed, profile)) as { tabId: number };
      await ensureClaim(tab.tabId, profile);
      return text(tab);
    },
  };

  const page_navigate: Tool<z.infer<ReturnType<typeof withProfile<typeof PageNavigateParamsSchema>>>> = {
    description: "Navigate the given tab to a URL. Auto-claims the tab. Optional timeoutMs (default 30s) bounds how long to wait for the page to load on slow networks.",
    inputSchema: withProfile(PageNavigateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageNavigateParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.navigate", parsed, profile));
    },
  };

  const page_snapshot: Tool<z.infer<ReturnType<typeof withProfile<typeof PageSnapshotParamsSchema>>>> = {
    description:
      "Take a snapshot of the page. Default mode=a11y returns a uid-annotated accessibility tree — each interactive element has a [uid] you can pass to click/type/hover. uids are stable: the same element keeps its uid across snapshots. Set includeBounds=true in a11y mode to add bbox=x,y,w,h (CSS pixels — pass space:\"css\" when feeding them to page_click_xy). mode=text returns innerText. mode=dom returns outerHTML. Set since=\"last\" (a11y mode) to return ONLY the lines that changed since this tab's previous snapshot (prefixed +/-) — a big token/speed saver on heavy pages; uids of unchanged elements stay valid; falls back to a full snapshot with baseline=true when there's no prior snapshot. ALWAYS take a snapshot before interacting with a page. If tabId is omitted, reads the active tab.",
    inputSchema: withProfile(PageSnapshotParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageSnapshotParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.snapshot", parsed, profile));
    },
  };

  const page_screenshot: Tool<z.infer<ReturnType<typeof withProfile<typeof PageScreenshotParamsSchema>>>> = {
    description:
      "Capture a screenshot of THIS tab's visible area (works for the tab you name, not whatever tab the user is looking at). Returns MCP image content plus metadata. The image is downscaled to fit vision-model limits (maxEdge 1568px / ~1.15 MP by default) so you see it unresized — positions you read off the image can be passed STRAIGHT to page_click_xy (it converts them with this screenshot's scale/origin). Use clip={x,y,width,height} (CSS px) to zoom into a region at higher detail (e.g. to read small cell text). Prefer page_snapshot for DOM structure; use screenshots for canvases/custom widgets. If the tab is in the background and can't render, you get an error suggesting tabs_activate (which brings it to the front — the user's typing would then go there). For grid/canvas editors, inspect the screenshot before writing so you don't overwrite visible content.",
    inputSchema: withProfile(PageScreenshotParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageScreenshotParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      const r = await bridge.call("page.screenshot", parsed, profile) as {
        format: string; base64: string; viewport?: unknown;
        image?: { width: number; height: number }; scale?: number; origin?: { x: number; y: number }; capture?: string;
      };
      const mimeType = r.format === "png" ? "image/png" : "image/jpeg";
      return {
        content: [
          { type: "image" as const, data: r.base64, mimeType },
          // Companion text item: lets agents that ignore image content (e.g.
          // when relayed through page_batch) still see the metadata. Excludes
          // base64 — clients that need the bytes call page_screenshot directly.
          {
            type: "text" as const,
            text: JSON.stringify({
              format: r.format,
              byteLength: r.base64.length,
              viewport: r.viewport,
              image: r.image,
              scale: r.scale,
              origin: r.origin,
              capture: r.capture,
              ...(r.image ? { coordinates: "page_click_xy takes pixel positions of THIS image directly (space defaults to \"screenshot\")." } : {}),
            }),
          },
        ],
      };
    },
  };

  const tabs_close: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsCloseParamsSchema>>>> = {
    description: "Close the given tab.",
    inputSchema: withProfile(TabsCloseParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.close", TabsCloseParamsSchema.parse(p), profile));
    },
  };

  const tabs_activate: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsActivateParamsSchema>>>> = {
    description: "Bring a tab to the foreground in its window.",
    inputSchema: withProfile(TabsActivateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.activate", TabsActivateParamsSchema.parse(p), profile));
    },
  };

  const session_release: Tool<z.infer<ReturnType<typeof withProfile<typeof SessionReleaseParamsSchema>>>> = {
    description: "Release a tab from the Claude tab group and remove its overlay. Call when done with a tab.",
    inputSchema: withProfile(SessionReleaseParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("session.release", SessionReleaseParamsSchema.parse(p), profile));
    },
  };

  const page_click: Tool<z.infer<ReturnType<typeof withProfile<typeof PageClickParamsSchema>>>> = {
    description:
      "Click an element by uid (from a snapshot) or CSS selector. Prefer uid — it is reliable and precise. Auto-waits (up to timeoutMs, default 5s) for the target to be actionable (visible/stable/enabled); pass force=true to skip the gate. Set includeSnapshot=true to get an updated accessibility tree in the response.",
    inputSchema: withProfile(PageClickParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageClickParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.click", parsed, profile));
    },
  };

  const page_click_xy: Tool<z.infer<ReturnType<typeof withProfile<typeof PageClickXyParamsSchema>>>> = {
    description:
      "Click at a point (x, y). Supports clickCount=2 for double-click. Vision-driven escape hatch for canvas-like widgets where no uid maps to the target (custom-rendered surfaces, canvas grids, drawing tools). " +
      "Workflow: 1) page_screenshot, 2) read the target's pixel position off THAT image, 3) page_click_xy with those numbers — space defaults to \"screenshot\" and they are converted with the screenshot's scale/origin (the image is downscaled, so never rescale yourself). " +
      "Pass space:\"css\" for CSS viewport pixels (e.g. page_snapshot bboxes). The pointer hovers first, then clicks. The result reports the CSS point clicked and where keyboard focus settled. Prefer page_click(uid) for real DOM elements.",
    inputSchema: withProfile(PageClickXyParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageClickXyParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.clickXy", parsed, profile));
    },
  };

  const page_type: Tool<z.infer<ReturnType<typeof withProfile<typeof PageTypeParamsSchema>>>> = {
    description:
      "Type text as real keystrokes into an input/textarea/contenteditable by uid (from a snapshot) or CSS selector. clear=true (default) empties the field first the way a person would (select its contents + Backspace) and verifies it — if it can't be emptied you get an error instead of the new text being merged with the old. Set requireEmpty=true to refuse typing when the focused target (or its active descendant) already has a value or text; content a page exposes only through an accessible name isn't detected — check focus.activeDescendantName. Set submit=true to submit the enclosing form. " +
      "modifiers apply to the whole run (chords); use \"ControlOrMeta\" for the platform shortcut key (⌘ on macOS, Ctrl on Windows/Linux/ChromeOS). " +
      "If uid AND selector are both omitted, keystrokes go to whatever has focus (including focused iframes) — use after page_click_xy on canvas-like widgets. " +
      "The result reports what the page did with the input: `focus` = where focus settled and what it holds once the page applied the keystrokes (rich editors apply them asynchronously — trust `focus`, not an immediate re-read); `focus.popups` = a suggestion list, menu or dialog the typing opened (while a list is open, Enter or Tab usually picks its highlighted item — press Escape first to keep exactly what you typed). " +
      "exact=true (default): if the page inline-completes your text (the field was empty and now shows your text plus a suggested remainder), Delete is pressed to drop the suggestion and `completion` reports it. " +
      "Embedded \\t becomes Tab and \\n becomes Enter; widgets differ in where Enter moves next, so in grids anchor each row explicitly rather than chaining rows with \\n.",
    inputSchema: withProfile(PageTypeParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageTypeParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.type", parsed, profile));
    },
  };

  const page_scroll: Tool<z.infer<ReturnType<typeof withProfile<typeof PageScrollParamsSchema>>>> = {
    description:
      "Scroll a tab by (dx, dy) pixels, to an element matching a CSS selector, or to 'top'/'bottom'. Provide exactly one target in js mode. Set mode='wheel' to dispatch a REAL mouse-wheel event (needs dx/dy, optionally anchored at a uid/selector centre) — use this for virtualized grids and lists that lazy-load rows on wheel scroll. Set includeSnapshot=true to get an updated accessibility tree.",
    inputSchema: withProfile(PageScrollParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageScrollParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.scroll", parsed, profile));
    },
  };

  const page_paste: Tool<z.infer<ReturnType<typeof withProfile<typeof PagePasteParamsSchema>>>> = {
    description:
      "Paste text the way a person does: put it on the clipboard and press the platform paste shortcut (⌘V on macOS, Ctrl+V on Windows/Linux/ChromeOS — the browser's OS decides). Many grid widgets split pasted tab-separated text into cells (Tab → next cell, newline → next row). " +
      "Success is verified: the call fails unless a real paste event reached the focused element (result: pasteDelivered, pasteHandledByPage). " +
      "Modes: target=\"current\" (default) pastes at the current focus (including focused iframes); target=\"uid\" focuses the uid first; target=\"xy\" clicks (x, y) first — screenshot pixels by default, space:\"css\" for CSS px. " +
      "Caveat: this REPLACES the user's clipboard and does not restore it — only use it when the user asked for a paste or agreed to their clipboard being overwritten; otherwise type.",
    inputSchema: withProfile(PagePasteParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PagePasteParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.paste", parsed, profile));
    },
  };

  const page_wait: Tool<z.infer<ReturnType<typeof withProfile<typeof PageWaitParamsSchema>>>> = {
    description:
      "Wait for a condition before continuing — the antidote to racing heavy async SPAs (Power Automate's lazy canvas, Office365 chrome). Modes (`for`): " +
      "\"uid\" (preferred) waits for a uid from the last snapshot to reach `state` (visible/hidden/attached/detached); OOPIF-aware. " +
      "\"selector\" same, by CSS selector. " +
      "\"text\" waits for case-insensitive visible page text to appear (state=visible) or disappear (state=hidden), e.g. \"Payment complete\". " +
      "\"function\" waits for a JS `expression` to evaluate truthy. " +
      "selector/text/function run in the top frame unless `frame` is set: \"focused\" (the frame holding keyboard focus) or a regex over frame URLs (e.g. \"app\\\\.example\\\\.com\"). " +
      "\"response\" waits for a request whose URL matches `urlPattern` to appear in the network buffer AFTER this call is armed (observational — does NOT claim the tab). " +
      "\"loadstate\" waits for load/domcontentloaded/networkidle. Throws on timeout (default 10s).",
    inputSchema: withProfile(PageWaitParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageWaitParamsSchema.parse(p);
      // Claim discipline: response mode is purely observational — don't pull a
      // tab into the Agent group for it. The other modes act on a page we drive.
      if (parsed.for !== "response") await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.wait", parsed, profile));
    },
  };

  const page_wait_for_download: Tool<z.infer<ReturnType<typeof withProfile<typeof PageWaitForDownloadParamsSchema>>>> = {
    description:
      "Wait for a file download to COMPLETE and return its metadata (filename, the on-disk path Chrome chose, bytes, mime). Observational: fire the export/download click yourself first, then call this. The file lands in the user's normal download folder — Chromanche never redirects downloads and never enumerates the user's history; it only reports downloads that start after this wait is armed. Optional filenamePattern (regex) narrows which download to match.",
    inputSchema: withProfile(PageWaitForDownloadParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageWaitForDownloadParamsSchema.parse(p);
      // Observational — no claim (the preceding export click already claimed).
      return text(await bridge.call("page.waitForDownload", parsed, profile));
    },
  };

  const page_hover: Tool<z.infer<ReturnType<typeof withProfile<typeof PageHoverParamsSchema>>>> = {
    description:
      "Hover over an element by uid (from a snapshot) or CSS selector. Useful for revealing tooltips, dropdown menus, or hover states. Set includeSnapshot=true to get the updated page state after hover.",
    inputSchema: withProfile(PageHoverParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageHoverParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.hover", parsed, profile));
    },
  };

  const page_focus: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFocusParamsSchema>>>> = {
    description:
      "Make a target element the active element, with verification. Use this when a web app grabs focus back and a previous page_type returned a 'couldn't focus' error reporting that document.activeElement is something else. " +
      "Modes: " +
      "auto (default) — JS focus → verify → escalate to coordinate-click on mismatch. Same dance page_type does internally; useful when you want to verify focus before a typing batch. " +
      "js — JS focus only (gentle, doesn't dismiss popovers, doesn't activate buttons). " +
      "click — coordinate-click only (dispatches a real OS-level click; reaches the app's input router). " +
      "blur+click — drop sticky focus first via document.activeElement.blur(), then coordinate-click. Strongest dislodge. " +
      "Result includes focused (boolean) and, on mismatch, actualTag/actualRole/actualName so the model can diagnose what's stealing focus. " +
      "Note: canvas-like widgets need the app's own navigation (e.g. its go-to box or keyboard navigation) — page_focus alone can't move you to a specific cell.",
    inputSchema: withProfile(PageFocusParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFocusParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.focus", parsed, profile));
    },
  };

  const page_press_key: Tool<z.infer<ReturnType<typeof withProfile<typeof PagePressKeyParamsSchema>>>> = {
    description:
      "Press a keyboard key (Enter, Escape, Tab, ArrowDown, Backspace, Space, F2, PageDown, a single character, …) with optional modifiers: Alt, Control, Meta, Shift, or \"ControlOrMeta\" — the platform shortcut key (⌘ on macOS, Ctrl on Windows/Linux/ChromeOS), e.g. key \"z\" + [\"ControlOrMeta\"] is Undo everywhere. Editing shortcuts (select all, copy, cut, paste, undo, redo) work on every OS. Keystrokes are routed to the focused document, including focused OOPIF frames. The result includes `focus`: where focus settled afterwards (set settle:false to skip waiting).",
    inputSchema: withProfile(PagePressKeyParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PagePressKeyParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.pressKey", parsed, profile));
    },
  };

  const page_focus_state: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFocusStateParamsSchema>>>> = {
    description:
      "Inspect the currently focused document and active element. Observational — use after coordinate clicks or keyboard movement in virtualized grid/canvas editors to verify where focus landed before typing. Returns active role/name/value/text, selected text, ARIA row/column hints when exposed, resolved aria-activedescendant details for focused grid containers, and the focused frame target when focus lives inside an OOPIF.",
    inputSchema: withProfile(PageFocusStateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFocusStateParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.focusState", parsed, profile));
    },
  };

  const page_fill_form: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFillFormParamsSchema>>>> = {
    description:
      "Fill multiple form fields in one call. Each field is targeted by uid (from a snapshot) or CSS selector. Set submit=true to submit the form after filling. Much more efficient than multiple page_type calls.",
    inputSchema: withProfile(PageFillFormParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFillFormParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.fillForm", parsed, profile));
    },
  };

  const page_handle_dialog: Tool<z.infer<ReturnType<typeof withProfile<typeof PageHandleDialogParamsSchema>>>> = {
    description:
      "Handle a JavaScript dialog (alert/confirm/prompt/beforeunload) that is currently open in the tab. action='accept' clicks OK, action='dismiss' clicks Cancel. For prompts, set promptText to the value to enter. If no dialog is open, returns handled=false.",
    inputSchema: withProfile(PageHandleDialogParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageHandleDialogParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.handleDialog", parsed, profile));
    },
  };

  const page_select: Tool<z.infer<ReturnType<typeof withProfile<typeof PageSelectParamsSchema>>>> = {
    description:
      "Select one or more options in a <select> dropdown by uid (from a snapshot) or CSS selector. Matches values against option value, label, or visible text. Dispatches input and change events.",
    inputSchema: withProfile(PageSelectParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageSelectParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.select", parsed, profile));
    },
  };

  const page_upload_file: Tool<z.infer<ReturnType<typeof withProfile<typeof PageUploadFileParamsSchema>>>> = {
    description:
      "Upload one or more files to a <input type=file> by uid (from a snapshot) or CSS selector. filePaths must be absolute paths on the user's machine that Chrome can read.",
    inputSchema: withProfile(PageUploadFileParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageUploadFileParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.uploadFile", parsed, profile));
    },
  };

  const page_drag: Tool<z.infer<ReturnType<typeof withProfile<typeof PageDragParamsSchema>>>> = {
    description:
      "Drag one element onto another. Source and target identified by uid (from a snapshot) or CSS selector. Useful for Trello/Jira/Notion-style drag-and-drop. Optional toOffsetX/toOffsetY shift the drop point relative to the target's centre.",
    inputSchema: withProfile(PageDragParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageDragParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.drag", parsed, profile));
    },
  };

  const page_fetch: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFetchParamsSchema>>>> = {
    description:
      "Run fetch() inside the page's JavaScript context and return the response. Reuses the page's cookies, auth tokens, and same-origin rules — ideal for calling backend APIs the page itself talks to (e.g. CRM/ERP/banking endpoints). Returns {ok, status, statusText, headers, body, json, truncated, finalUrl}. Body is auto-parsed when content-type is JSON. Prefer over page_eval_js when you're doing API calls — one round-trip instead of three.",
    inputSchema: withProfile(PageFetchParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFetchParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.fetch", parsed, profile));
    },
  };

  const page_eval_js: Tool<z.infer<ReturnType<typeof withProfile<typeof PageEvalJsParamsSchema>>>> = {
    description:
      "Evaluate a JavaScript expression in a tab's context. Use as an escape hatch when other tools don't cover your needs. `frame` reaches into iframes, including cross-origin ones: \"top\" (default), \"focused\" (the frame holding keyboard focus), or a regex over frame URLs (e.g. \"app\\\\.example\\\\.com\"). The result names the frame it ran in.",
    inputSchema: withProfile(PageEvalJsParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageEvalJsParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.evalJs", parsed, profile));
    },
  };

  const console_read: Tool<z.infer<ReturnType<typeof withProfile<typeof ConsoleReadParamsSchema>>>> = {
    description: "Read buffered console messages for a tab. Observational — does not claim the tab.",
    inputSchema: withProfile(ConsoleReadParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("console.read", ConsoleReadParamsSchema.parse(p), profile));
    },
  };

  const network_read: Tool<z.infer<ReturnType<typeof withProfile<typeof NetworkReadParamsSchema>>>> = {
    description: "Read buffered network requests for a tab. Observational — does not claim the tab.",
    inputSchema: withProfile(NetworkReadParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("network.read", NetworkReadParamsSchema.parse(p), profile));
    },
  };

  const network_get_request: Tool<z.infer<ReturnType<typeof withProfile<typeof NetworkGetRequestParamsSchema>>>> = {
    description:
      "Fetch the headers + body of the most recent buffered network request whose URL matches `urlPattern` (regex). Use after network_read to drill into one request — e.g. inspect a failed Office365/Graph/Power Automate call's response body. Observational: surfaces only requests the page already made on the user's own session (same trust model as page_fetch); never claims the tab, never makes new outbound calls. Body is fetched lazily and capped by maxBytes.",
    inputSchema: withProfile(NetworkGetRequestParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("network.getRequest", NetworkGetRequestParamsSchema.parse(p), profile));
    },
  };

  // Tool name → handler. Built once after every tool is defined so page_batch
  // can dispatch by string. page_batch itself is excluded — no nested batches.
  const registry: Record<string, (args: never) => Promise<ToolResult>> = {
    tabs_list: tabs_list.handler,
    tabs_create: tabs_create.handler,
    tabs_close: tabs_close.handler,
    tabs_activate: tabs_activate.handler,
    page_navigate: page_navigate.handler,
    page_snapshot: page_snapshot.handler,
    page_screenshot: page_screenshot.handler,
    page_click: page_click.handler,
    page_click_xy: page_click_xy.handler,
    page_type: page_type.handler,
    page_paste: page_paste.handler,
    page_scroll: page_scroll.handler,
    page_hover: page_hover.handler,
    page_focus: page_focus.handler,
    page_press_key: page_press_key.handler,
    page_focus_state: page_focus_state.handler,
    page_fill_form: page_fill_form.handler,
    page_handle_dialog: page_handle_dialog.handler,
    page_select: page_select.handler,
    page_upload_file: page_upload_file.handler,
    page_drag: page_drag.handler,
    page_wait: page_wait.handler,
    page_fetch: page_fetch.handler,
    page_eval_js: page_eval_js.handler,
    console_read: console_read.handler,
    network_read: network_read.handler,
    network_get_request: network_get_request.handler,
    session_release: session_release.handler,
  };

  const page_batch: Tool<z.infer<ReturnType<typeof withProfile<typeof PageBatchParamsSchema>>>> = {
    description:
      "Run several Chromanche tools sequentially in a single MCP round-trip. " +
      "Use this when you have a known sequence of actions (click → type → screenshot, " +
      "fill several fields, navigate then snapshot) — it " +
      "eliminates the per-step model loop latency. Steps run in order; by default the " +
      "first failure aborts the rest. Set stopOnError=false to run every step and " +
      "collect per-step errors. The batch-level profile (if set) is forwarded to each " +
      "step that doesn't override it. Cannot nest page_batch inside itself. " +
      "Note: page_screenshot results inside a batch are auto-truncated above ~30KB of base64; if you need the actual bytes, call page_screenshot outside the batch. " +
      "Caveat: some MCP harnesses misencode long step-args strings containing many literal Tab/newline characters and the steps array arrives at the server as a stringified blob (Zod sees \"expected array, received string\"). For bulk text fill prefer a single direct page_type or page_paste call outside the batch.",
    inputSchema: withProfile(PageBatchParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageBatchParamsSchema.parse(p);

      const results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }> = [];
      let allOk = true;
      for (const step of parsed.steps) {
        const handler = registry[step.tool];
        if (!handler) {
          // Schema's z.enum makes this unreachable, but guard against a forgotten
          // registry entry rather than crashing the whole batch.
          results.push({ tool: step.tool, ok: false, error: `unknown tool: ${step.tool}` });
          allOk = false;
          if (parsed.stopOnError) break;
          continue;
        }
        const stepArgs = profile && !("profile" in step.args)
          ? { ...step.args, profile }
          : step.args;
        try {
          const r = await handler(stepArgs as never);
          // Tool handlers return content arrays. Most items are text-JSON; a
          // few (page_screenshot) are images. For batch results we re-parse
          // the first text item so the model sees structured per-step results,
          // and replace any image item with a sentinel — agents that want the
          // full image should call page_screenshot directly, not inside a batch.
          const textItem = r.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined;
          const imageItem = r.content.find((c) => c.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
          let inner: unknown = textItem?.text ? JSON.parse(textItem.text) : null;
          if (imageItem) {
            // Annotate the inner result so the model knows an image was returned but elided.
            inner = {
              ...(typeof inner === "object" && inner !== null ? inner : {}),
              image: `<elided ${imageItem.mimeType} ${imageItem.data.length} bytes — call page_screenshot outside the batch to view>`,
            };
          }
          results.push({ tool: step.tool, ok: true, result: redactOversizedBase64(inner) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ tool: step.tool, ok: false, error: msg });
          allOk = false;
          if (parsed.stopOnError) break;
        }
      }
      return text({ ok: allOk, results });
    },
  };

  return {
    chromanche_list_profiles,
    tabs_list, tabs_create, tabs_close, tabs_activate,
    page_navigate, page_snapshot, page_screenshot,
    page_click, page_click_xy, page_type, page_paste, page_scroll,
    page_hover, page_focus, page_press_key, page_focus_state, page_fill_form,
    page_handle_dialog, page_select, page_upload_file, page_drag,
    page_wait, page_wait_for_download,
    session_release,
    page_fetch, page_eval_js, console_read, network_read, network_get_request,
    page_batch,
  };
}

import { z } from "zod";

/** First frame from extension to server on every new WS connection. */
export const ClientHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(8),
  /** Stable per-install identifier (sha256 of chrome.runtime.id). Routes tool calls. */
  profile: z.string().min(1).optional(),
  /** Human-readable label shown in list_profiles (defaults to profile tag prefix). */
  label: z.string().min(1).max(64).optional(),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

/** First frame from an MCP proxy (secondary Claude Code session) to the hub. */
export const ProxyHelloSchema = z.object({
  type: z.literal("mcp-proxy-hello"),
  token: z.string().min(8),
}).strict();

/** Proxy → hub: forwarded MCP request (JSON-RPC body from Claude Code's stdio). */
export const ProxyRequestFrameSchema = z.object({
  type: z.literal("mcp-request"),
  msg: z.unknown(),
}).strict();

/** Hub → proxy: the matching MCP response (JSON-RPC body to send back on stdio). */
export const ProxyResponseFrameSchema = z.object({
  type: z.literal("mcp-response"),
  msg: z.unknown(),
}).strict();

/** Entry returned by list_profiles. */
export const ProfileInfoSchema = z.object({
  tag: z.string(),
  label: z.string(),
  connectedAt: z.number(),
}).strict();
export type ProfileInfo = z.infer<typeof ProfileInfoSchema>;

export const ProfilesListParamsSchema = z.object({}).strict();
export const ProfilesListResultSchema = z.array(ProfileInfoSchema);

/** Tab summary returned by the extension. */
export const TabSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  windowId: z.number().int().optional(),
}).strict();
export type Tab = z.infer<typeof TabSchema>;

/* Per-method params/results. */
export const TabsListParamsSchema = z.object({}).strict();
export const TabsListResultSchema = z.array(TabSchema);

export const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:/i.test(u), "only http(s) URLs are allowed");

export const TabsCreateParamsSchema = z
  .object({ url: HttpUrlSchema, active: z.boolean().default(true) })
  .strict();
export const TabsCreateResultSchema = TabSchema;

export const TabsCloseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsCloseResultSchema = z.object({ ok: z.literal(true) }).strict();

export const TabsActivateParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsActivateResultSchema = z.object({ ok: z.literal(true) }).strict();

export const PageNavigateParamsSchema = z
  .object({
    tabId: z.number().int(),
    url: HttpUrlSchema,
    waitUntil: z.enum(["load", "domcontentloaded"]).default("load"),
    /** How long to wait for the page to reach waitUntil before returning the current URL. */
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  })
  .strict();
export const PageNavigateResultSchema = z.object({
  ok: z.literal(true),
  finalUrl: z.string().url(),
}).strict();

export const SessionClaimParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionClaimResultSchema = z.object({
  ok: z.literal(true),
  groupId: z.number().int(),
}).strict();

export const SessionReleaseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionReleaseResultSchema = z.object({ ok: z.literal(true) }).strict();

/* ---------- Snapshot (a11y mode now returns uid-annotated CDP tree) ---------- */

export const PageSnapshotParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    mode: z.enum(["text", "dom", "a11y"]).default("a11y"),
    maxBytes: z.number().int().positive().max(2_000_000).default(80_000),
    includeBounds: z.boolean().default(false),
    /**
     * "full" (default): return the whole snapshot.
     * "last": return only the lines that changed since the previous a11y
     * snapshot of this tab (token/speed optimization for heavy pages). uids
     * stay stable so you can still click/type by uid. If there's no prior
     * baseline (or mode != a11y), transparently returns the full snapshot.
     */
    since: z.enum(["full", "last"]).default("full"),
  })
  .strict();
export const PageSnapshotResultSchema = z
  .object({
    mode: z.enum(["text", "dom", "a11y"]),
    url: z.string(),
    title: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    /** When since="last" produced a diff: counts of changed lines. Absent on full snapshots. */
    diff: z.object({
      added: z.number().int(),
      removed: z.number().int(),
    }).optional(),
    /** True when since="last" fell back to a full snapshot (no prior baseline). */
    baseline: z.boolean().optional(),
  })
  .strict();

/** A region of the viewport, in CSS pixels. */
export const ViewportRectSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

/**
 * Screenshots are captured per tab (CDP) and downscaled so the returned image
 * stays within what vision models ingest WITHOUT further resizing — otherwise
 * a 2560px viewport reaches the model as ~1568–2000px and every coordinate it
 * reads off the image lands on the wrong spot. The result carries the exact
 * image→page transform (`scale`, `origin`) and the extension remembers it per
 * tab, so page_click_xy can take image coordinates directly.
 */
export const PageScreenshotParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    format: z.enum(["png", "jpeg"]).default("jpeg"),
    quality: z.number().int().min(1).max(100).default(60),
    /** Cap on the returned image's long edge, in image pixels. */
    maxEdge: z.number().int().min(200).max(4096).default(1568),
    /** Cap on the returned image's total pixels (width × height). */
    maxPixels: z.number().int().min(40_000).max(16_000_000).default(1_150_000),
    /** Capture only this viewport region (CSS px) — zoom in to read small text. */
    clip: ViewportRectSchema.optional(),
  })
  .strict();
export const PageScreenshotResultSchema = z
  .object({
    format: z.enum(["png", "jpeg"]),
    base64: z.string(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
      devicePixelRatio: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
    }).optional(),
    /** Pixel size of the returned image. */
    image: z.object({ width: z.number().int(), height: z.number().int() }).strict().optional(),
    /** CSS px per image px: cssX = origin.x + imageX * scale (same for y). */
    scale: z.number().positive().optional(),
    /** Viewport position (CSS px) of the image's top-left pixel. */
    origin: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    /** "cdp" = this tab's own pixels; "visibleTab" = fallback capture of the visible tab. */
    capture: z.enum(["cdp", "visibleTab"]).optional(),
  })
  .strict();

/**
 * Coordinate space for x/y inputs:
 *  - "screenshot" (default): pixels of the most recent page_screenshot of this
 *    tab — converted with its scale/origin. Falls back to CSS px when no
 *    screenshot was taken yet.
 *  - "css": CSS (viewport) pixels — e.g. a bbox from page_snapshot includeBounds.
 */
export const CoordinateSpaceSchema = z.enum(["screenshot", "css"]);

/**
 * Keyboard modifiers. "ControlOrMeta" is the portable shortcut modifier: ⌘ on
 * macOS, Ctrl on Windows / Linux / ChromeOS (resolved by the extension from the
 * BROWSER's OS — not the MCP server's, which may differ, e.g. under WSL).
 */
export const ModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift", "ControlOrMeta"]);

/**
 * A visible popup in the focused document (ARIA role listbox / menu / dialog /
 * alertdialog) — e.g. an autocomplete list opened by typing. While a list is
 * open, Enter or Tab usually picks its highlighted item instead of committing
 * what was typed.
 */
export const PopupSchema = z
  .object({
    role: z.string(),
    label: z.string().optional(),
    /** Number of selectable items (options / menu items) inside it. */
    items: z.number().int().optional(),
  })
  .strict();

/**
 * Compact post-action focus report returned by input tools after the page
 * settles (rich editors apply keystrokes asynchronously; reading state
 * immediately after dispatch shows stale values).
 */
export const FocusSummarySchema = z
  .object({
    /** origin+path of the frame holding focus, when focus is inside an iframe. */
    frame: z.string().optional(),
    tag: z.string(),
    role: z.string().nullable().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    text: z.string().optional(),
    activeDescendantName: z.string().optional(),
    /** Popups that appeared during the action (all visible ones when no baseline was taken). */
    popups: z.array(PopupSchema).optional(),
    /** The focused element reports aria-expanded="true" (its list/menu is open). */
    expanded: z.boolean().optional(),
    /** False when the page was still changing when the settle budget ran out. */
    settled: z.boolean(),
    waitedMs: z.number(),
  })
  .strict();

/**
 * Optional frame selector for code-running tools: "top" (default), "focused"
 * (the frame that owns keyboard focus), or a regex tested against frame URLs.
 */
export const FrameSelectorSchema = z.string().min(1);

/* ---------- Interaction: click, type, scroll (uid OR selector) ---------- */

export const PageClickParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scrollIntoView: z.boolean().default(true),
    /** Skip the actionability gate (visible/stable/enabled) before clicking. */
    force: z.boolean().default(false),
    /** Max time to wait for the target to become actionable before failing. */
    timeoutMs: z.number().int().positive().max(120_000).default(5_000),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageClickResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

export const PageTypeParamsSchema = z
  .object({
    tabId: z.number().int(),
    /**
     * Optional. When provided, the element is focused (with self-verification)
     * before typing. When OMITTED, page.type dispatches keystrokes at the
     * current focus without resolving or focusing any element — useful after
     * a page_click_xy lands on a canvas-like widget that doesn't have a uid
     * (a canvas grid cell, a drawing surface). Mirrors the canonical
     * "screenshot → coordinate click → type at current focus" pattern.
     */
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    text: z.string(),
    submit: z.boolean().default(false),
    clear: z.boolean().default(true),
    requireEmpty: z.boolean().default(false),
    /** Modifiers held down for the whole text run — use for chords (e.g. ControlOrMeta+a). */
    modifiers: z.array(ModifierSchema).default([]),
    /** Skip the actionability gate (visible/stable/enabled) before typing. */
    force: z.boolean().default(false),
    /** Max time to wait for the target to become actionable before failing. */
    timeoutMs: z.number().int().positive().max(120_000).default(5_000),
    /** Wait for the page to apply the input, then report where focus ended up. */
    settle: z.boolean().default(true),
    /**
     * Keep the field holding exactly the typed text: when the page inline-
     * completes it (the field shows the typed text plus a suggested remainder),
     * press Delete to drop the suggestion. Applies to single-field typing into
     * a field that was empty; needs settle.
     */
    exact: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageTypeResultSchema = z.object({
  ok: z.literal(true),
  /** Present when the page auto-completed the typed text. */
  completion: z.object({
    typed: z.string(),
    /** What the field showed after typing (typed text + suggestion). */
    fieldShowed: z.string(),
    /** The suggestion was dropped and the field now holds exactly the typed text. */
    removed: z.boolean(),
    fieldNow: z.string(),
  }).strict().optional(),
  focus: FocusSummarySchema.optional(),
  snapshot: z.string().optional(),
}).strict();

export const PageScrollParamsSchema = z
  .object({
    tabId: z.number().int(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    selector: z.string().min(1).optional(),
    uid: z.string().min(1).optional(),
    to: z.enum(["top", "bottom"]).optional(),
    /**
     * "js" (default): scrollIntoView/scrollTo/scrollBy — preserves prior behaviour.
     * "wheel": dispatch a real mouseWheel event so virtualized grids and lists
     * lazy-load rows. Anchors at the uid/selector centre, else viewport centre.
     */
    mode: z.enum(["js", "wheel"]).default("js"),
    smooth: z.boolean().default(false),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "wheel") {
      // Wheel mode needs a delta; an optional uid/selector just anchors the cursor.
      if (v.dx === undefined && v.dy === undefined) {
        ctx.addIssue({ code: "custom", message: "wheel mode requires dx and/or dy" });
      }
      return;
    }
    const count = [v.dx !== undefined || v.dy !== undefined, v.selector !== undefined, v.to !== undefined]
      .filter(Boolean).length;
    if (count === 0) {
      ctx.addIssue({ code: "custom", message: "provide one of: (dx/dy), selector, or to" });
    }
    if (count > 1) {
      ctx.addIssue({ code: "custom", message: "provide exactly one of: (dx/dy), selector, or to" });
    }
  });
export const PageScrollResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Paste (clipboard → Cmd/Ctrl+V) ---------- */

/**
 * Write `text` to the OS clipboard and synthesize the platform paste
 * keystroke at the current/specified focus. Many grid widgets split pasted
 * tab-separated text into cells (Tab → next cell, newline → next row).
 * REPLACES the user's clipboard (not restored) — use only when the user asked
 * for a paste.
 *
 * target:
 *  - "current" (default): paste at whatever has document focus.
 *  - "uid": resolve the uid (preferred), focus it (auto-verifying), then paste.
 *  - "xy": coordinate-click at (x, y) first to set focus, then paste.
 */
export const PagePasteParamsSchema = z
  .object({
    tabId: z.number().int(),
    text: z.string().min(1),
    target: z.enum(["current", "uid", "xy"]).default("current"),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    x: z.number().min(0).optional(),
    y: z.number().min(0).optional(),
    /** Coordinate space for target="xy" (see CoordinateSpaceSchema). */
    space: CoordinateSpaceSchema.default("screenshot"),
    settle: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.target === "uid" && !v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "target=uid requires uid or selector" });
    }
    if (v.target === "xy" && (v.x === undefined || v.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "target=xy requires x and y" });
    }
  });
export const PagePasteResultSchema = z.object({
  ok: z.literal(true),
  /** Number of bytes (text length) written to the clipboard. */
  bytesWritten: z.number().int(),
  /** A real (trusted) paste event reached the focused document. Never true-by-assumption. */
  pasteDelivered: z.boolean().optional(),
  /** The page handled the paste itself (preventDefault) — typical for grids/rich editors. */
  pasteHandledByPage: z.boolean().optional(),
  focus: FocusSummarySchema.optional(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Wait (uid / selector / function / response / loadstate) ---------- */

/**
 * Explicit waiting primitive. uid mode is preferred (matches the a11y-snapshot
 * flow and works inside OOPIFs); selector is a main-frame-only fallback.
 * response mode is observational — it only matches requests that appear AFTER
 * the wait is armed (the MCP wrapper does not claim the tab for response mode).
 */
export const PageWaitParamsSchema = z
  .object({
    tabId: z.number().int(),
    for: z.enum(["uid", "selector", "text", "function", "response", "loadstate"]),
    // uid mode (preferred) — a uid from the most recent snapshot
    uid: z.string().min(1).optional(),
    // selector mode (fallback, main-frame only)
    selector: z.string().min(1).optional(),
    // text mode — case-insensitive substring of visible page text (main frame)
    text: z.string().min(1).optional(),
    state: z.enum(["attached", "visible", "hidden", "detached"]).default("visible"),
    // function mode — JS expression that must evaluate truthy
    expression: z.string().min(1).optional(),
    // selector / text / function modes: which frame to evaluate in (default "top")
    frame: FrameSelectorSchema.optional(),
    // response mode — regex tested against request URL in the network buffer
    urlPattern: z.string().min(1).optional(),
    // loadstate mode
    loadState: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
    pollMs: z.number().int().min(50).max(2_000).default(150),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.for === "uid" && !v.uid) ctx.addIssue({ code: "custom", message: "for=uid requires uid" });
    if (v.for === "selector" && !v.selector) ctx.addIssue({ code: "custom", message: "for=selector requires selector" });
    if (v.for === "text" && !v.text) ctx.addIssue({ code: "custom", message: "for=text requires text" });
    if (v.for === "function" && !v.expression) ctx.addIssue({ code: "custom", message: "for=function requires expression" });
    if (v.for === "response" && !v.urlPattern) ctx.addIssue({ code: "custom", message: "for=response requires urlPattern" });
  });
export const PageWaitResultSchema = z.object({
  ok: z.literal(true),
  matched: z.boolean(),
  waitedMs: z.number(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Wait for download (observational) ---------- */

/**
 * Resolve with metadata of the next download that COMPLETES after this wait
 * is armed. Uses chrome.downloads — the file lands wherever the user's Chrome
 * already puts it; we never redirect (no Page.setDownloadBehavior) and never
 * enumerate history (no chrome.downloads.search baseline). Observational: the
 * MCP wrapper does not claim a tab for this tool.
 */
export const PageWaitForDownloadParamsSchema = z
  .object({
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    // Optional regex tested against the download's filename.
    filenamePattern: z.string().min(1).optional(),
  })
  .strict();
export const PageWaitForDownloadResultSchema = z.object({
  ok: z.literal(true),
  filename: z.string(),
  path: z.string(),
  bytes: z.number().int().optional(),
  mime: z.string().optional(),
  finalUrl: z.string().optional(),
}).strict();

/* ---------- Hover ---------- */

export const PageHoverParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageHoverResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Coordinate-click (vision-driven escape hatch) ---------- */

/**
 * Click at a point. The escape hatch for canvas-like widgets where uid-based
 * clicks don't resolve to specific cells (any custom-rendered surface).
 * Workflow: page_screenshot → model identifies (x, y) from the rendered image
 * → page_click_xy.
 *
 * By default x/y are pixels of the latest page_screenshot of this tab (the
 * extension converts them with that screenshot's scale/origin); pass
 * space:"css" for CSS viewport pixels (e.g. page_snapshot bboxes).
 */
export const PageClickXyParamsSchema = z
  .object({
    tabId: z.number().int(),
    x: z.number().min(0),
    y: z.number().min(0),
    space: CoordinateSpaceSchema.default("screenshot"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    settle: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageClickXyResultSchema = z.object({
  ok: z.literal(true),
  /** The CSS viewport point that was actually clicked. */
  point: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  /** Space the inputs were interpreted in ("css" when no screenshot existed yet). */
  spaceUsed: CoordinateSpaceSchema.optional(),
  focus: FocusSummarySchema.optional(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Focus (loud, verifying) ---------- */

/**
 * Make a target element the active element, with verification. Useful when
 * an SPA's input pipeline ignores plain JS focus() — the model can escalate
 * explicitly via mode, and gets back an honest report of the actual
 * activeElement when the focus didn't take.
 *
 * Mode semantics:
 *  - auto:        try JS focus → verify → escalate to coordinate-click on mismatch.
 *  - js:          JS focus only (the historical behaviour). No escalation.
 *  - click:       coordinate-click only. No prior JS focus().
 *  - blur+click:  drop sticky focus first via document.activeElement.blur(),
 *                 then coordinate-click. Strongest dislodge for apps that pin focus.
 */
export const PageFocusParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    mode: z.enum(["auto", "js", "click", "blur+click"]).default("auto"),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageFocusResultSchema = z.object({
  ok: z.literal(true),
  /** True when document.activeElement === target after the focus dance. */
  focused: z.boolean(),
  /** Mode that ultimately resulted in the reported state. */
  modeUsed: z.enum(["js", "click", "blur+click"]),
  /** When focused=false, what activeElement actually is (for the model to diagnose). */
  actualTag: z.string().optional(),
  actualRole: z.string().nullable().optional(),
  actualName: z.string().optional(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Press key ---------- */

export const PagePressKeyParamsSchema = z
  .object({
    tabId: z.number().int(),
    key: z.string().min(1),
    modifiers: z.array(ModifierSchema).default([]),
    settle: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PagePressKeyResultSchema = z.object({
  ok: z.literal(true),
  focus: FocusSummarySchema.optional(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Focus state ---------- */

export const PageFocusStateParamsSchema = z
  .object({
    tabId: z.number().int(),
  })
  .strict();
export const PageFocusStateResultSchema = z.object({
  ok: z.literal(true),
  targetId: z.string().optional(),
  url: z.string(),
  title: z.string(),
  documentHasFocus: z.boolean(),
  activeTag: z.string(),
  activeRole: z.string().nullable().optional(),
  activeName: z.string().optional(),
  activeValue: z.string().optional(),
  activeText: z.string().optional(),
  selectedText: z.string().optional(),
  selectionStart: z.number().nullable().optional(),
  selectionEnd: z.number().nullable().optional(),
  activeDescendant: z.string().optional(),
  activeDescendantTag: z.string().optional(),
  activeDescendantRole: z.string().nullable().optional(),
  activeDescendantName: z.string().optional(),
  activeDescendantValue: z.string().optional(),
  activeDescendantText: z.string().optional(),
  activeDescendantRowIndex: z.string().optional(),
  activeDescendantColIndex: z.string().optional(),
  activeDescendantBounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
  ariaRowIndex: z.string().optional(),
  ariaColIndex: z.string().optional(),
  /** aria-expanded of the focused element ("true" while its list/menu is open). */
  activeExpanded: z.string().nullable().optional(),
  /** Visible popups (listbox / menu / dialog / alertdialog) in the focused document. */
  popups: z.array(PopupSchema).optional(),
}).strict();

/* ---------- Fill form (batch) ---------- */

export const FillFormFieldSchema = z.object({
  uid: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  value: z.string(),
}).strict().superRefine((v, ctx) => {
  if (!v.uid && !v.selector) {
    ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
  }
});

export const PageFillFormParamsSchema = z
  .object({
    tabId: z.number().int(),
    fields: z.array(FillFormFieldSchema).min(1),
    submit: z.boolean().default(false),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageFillFormResultSchema = z.object({
  ok: z.literal(true),
  filledCount: z.number().int(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Dialog handling ---------- */

export const PageHandleDialogParamsSchema = z
  .object({
    tabId: z.number().int(),
    action: z.enum(["accept", "dismiss"]).default("accept"),
    promptText: z.string().optional(),
  })
  .strict();
export const PageHandleDialogResultSchema = z
  .object({
    ok: z.literal(true),
    handled: z.boolean(),
    dialogType: z.string().optional(),
    dialogMessage: z.string().optional(),
  })
  .strict();

/* ---------- Select (dropdown) ---------- */

export const PageSelectParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    // pick the option whose value OR visible text matches one of these strings
    values: z.array(z.string()).min(1),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageSelectResultSchema = z
  .object({
    ok: z.literal(true),
    selected: z.array(z.string()),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Upload file ---------- */

export const PageUploadFileParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageUploadFileResultSchema = z
  .object({
    ok: z.literal(true),
    uploadedCount: z.number().int(),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Drag ---------- */

export const PageDragParamsSchema = z
  .object({
    tabId: z.number().int(),
    fromUid: z.string().min(1).optional(),
    fromSelector: z.string().min(1).optional(),
    toUid: z.string().min(1).optional(),
    toSelector: z.string().min(1).optional(),
    // offset applied to the target centre (useful for drop zones that only accept a specific region)
    toOffsetX: z.number().optional(),
    toOffsetY: z.number().optional(),
    steps: z.number().int().min(1).max(50).default(10),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.fromUid && !v.fromSelector) {
      ctx.addIssue({ code: "custom", message: "provide fromUid or fromSelector" });
    }
    if (!v.toUid && !v.toSelector) {
      ctx.addIssue({ code: "custom", message: "provide toUid or toSelector" });
    }
  });
export const PageDragResultSchema = z
  .object({
    ok: z.literal(true),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Fetch (in-page) ---------- */

export const PageFetchParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    url: z.string().min(1),   // relative or absolute; resolved against the page origin
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    headers: z.record(z.string()).optional(),
    // Body may be a string or a JSON-serialisable object (we stringify objects).
    body: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
    credentials: z.enum(["include", "same-origin", "omit"]).default("include"),
    timeoutMs: z.number().int().positive().max(60_000).default(15_000),
    // Cap on response body bytes (text length). Default 200 KB.
    maxBytes: z.number().int().positive().max(2_000_000).default(200_000),
  })
  .strict();

export const PageFetchResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.number().int(),
    statusText: z.string(),
    headers: z.record(z.string()),
    // Body: parsed JSON if content-type is JSON, else raw text.
    body: z.unknown(),
    // Whether body was auto-parsed as JSON.
    json: z.boolean(),
    truncated: z.boolean(),
    finalUrl: z.string(),
  })
  .strict();

/* ---------- Escape hatch & logs ---------- */

export const PageEvalJsParamsSchema = z.object({
  tabId: z.number().int().optional(),
  expression: z.string().min(1),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(30_000).default(5_000),
  /** "top" (default) | "focused" | regex over frame URLs — reach into cross-origin iframes. */
  frame: FrameSelectorSchema.optional(),
}).strict();
export const PageEvalJsResultSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  description: z.string().optional(),
  exception: z.string().optional(),
  /** origin+path of the frame the expression ran in, when not the top frame. */
  frame: z.string().optional(),
}).strict();

export const ConsoleEntrySchema = z.object({
  ts: z.number(),
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
}).strict();
export const ConsoleReadParamsSchema = z.object({
  tabId: z.number().int().optional(),
  pattern: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const ConsoleReadResultSchema = z.array(ConsoleEntrySchema);

export const NetworkEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
  durationMs: z.number().optional(),
  type: z.string(),
}).strict();
export const NetworkReadParamsSchema = z.object({
  tabId: z.number().int().optional(),
  pattern: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const NetworkReadResultSchema = z.array(NetworkEntrySchema);

/* ---------- Network: single-request detail (observational) ---------- */

/**
 * Fetch headers + body of one buffered request. Read-only: surfaces only
 * requests the page itself already made, on the user's own session (same
 * trust model as page.fetch). No new outbound traffic from the server. Match
 * the newest buffered request whose URL matches `urlPattern` (regex).
 */
export const NetworkGetRequestParamsSchema = z.object({
  tabId: z.number().int().optional(),
  urlPattern: z.string().min(1),
  maxBytes: z.number().int().positive().max(2_000_000).default(200_000),
}).strict();
export const NetworkGetRequestResultSchema = z.object({
  method: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
  requestHeaders: z.record(z.string()),
  responseHeaders: z.record(z.string()),
  body: z.string(),
  base64Encoded: z.boolean(),
  truncated: z.boolean(),
}).strict();

/** Every method the extension must implement. */
export const METHODS = {
  "tabs.list":       { params: TabsListParamsSchema,       result: TabsListResultSchema },
  "tabs.create":     { params: TabsCreateParamsSchema,     result: TabsCreateResultSchema },
  "tabs.close":      { params: TabsCloseParamsSchema,      result: TabsCloseResultSchema },
  "tabs.activate":   { params: TabsActivateParamsSchema,   result: TabsActivateResultSchema },
  "page.navigate":   { params: PageNavigateParamsSchema,   result: PageNavigateResultSchema },
  "session.claim":   { params: SessionClaimParamsSchema,   result: SessionClaimResultSchema },
  "session.release": { params: SessionReleaseParamsSchema, result: SessionReleaseResultSchema },
  "page.snapshot":   { params: PageSnapshotParamsSchema,   result: PageSnapshotResultSchema },
  "page.screenshot": { params: PageScreenshotParamsSchema, result: PageScreenshotResultSchema },
  "page.click":      { params: PageClickParamsSchema,      result: PageClickResultSchema },
  "page.type":       { params: PageTypeParamsSchema,       result: PageTypeResultSchema },
  "page.paste":      { params: PagePasteParamsSchema,      result: PagePasteResultSchema },
  "page.scroll":     { params: PageScrollParamsSchema,     result: PageScrollResultSchema },
  "page.wait":       { params: PageWaitParamsSchema,       result: PageWaitResultSchema },
  "page.waitForDownload": { params: PageWaitForDownloadParamsSchema, result: PageWaitForDownloadResultSchema },
  "page.hover":      { params: PageHoverParamsSchema,      result: PageHoverResultSchema },
  "page.focus":      { params: PageFocusParamsSchema,      result: PageFocusResultSchema },
  "page.clickXy":    { params: PageClickXyParamsSchema,    result: PageClickXyResultSchema },
  "page.pressKey":   { params: PagePressKeyParamsSchema,   result: PagePressKeyResultSchema },
  "page.focusState": { params: PageFocusStateParamsSchema, result: PageFocusStateResultSchema },
  "page.fillForm":   { params: PageFillFormParamsSchema,   result: PageFillFormResultSchema },
  "page.handleDialog": { params: PageHandleDialogParamsSchema, result: PageHandleDialogResultSchema },
  "page.select":     { params: PageSelectParamsSchema,     result: PageSelectResultSchema },
  "page.uploadFile": { params: PageUploadFileParamsSchema, result: PageUploadFileResultSchema },
  "page.drag":       { params: PageDragParamsSchema,       result: PageDragResultSchema },
  "page.fetch":      { params: PageFetchParamsSchema,      result: PageFetchResultSchema },
  "profiles.list":   { params: ProfilesListParamsSchema,   result: ProfilesListResultSchema },
  "page.evalJs":     { params: PageEvalJsParamsSchema,     result: PageEvalJsResultSchema },
  "console.read":    { params: ConsoleReadParamsSchema,    result: ConsoleReadResultSchema },
  "network.read":    { params: NetworkReadParamsSchema,    result: NetworkReadResultSchema },
  "network.getRequest": { params: NetworkGetRequestParamsSchema, result: NetworkGetRequestResultSchema },
} as const;
export type MethodName = keyof typeof METHODS;

export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;

/** JSON-RPC 2.0 request / response envelopes. */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .refine((v) => (v.result === undefined) !== (v.error === undefined), {
    message: "exactly one of result / error must be set",
  });
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

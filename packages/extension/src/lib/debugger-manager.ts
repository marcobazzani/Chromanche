import { forgetScreenshot } from "./screenshot-transform.js";

export interface ConsoleEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  type: string;
}

export interface ReadFilter {
  pattern?: RegExp;
  since?: number;
  limit: number;
}

export class RingBuffer<T extends { ts: number }> {
  private items: T[] = [];
  constructor(private cap = 500) {}

  push(e: T): void {
    this.items.push(e);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }

  read(filter: ReadFilter, extract: (t: T) => string): T[] {
    return this.items
      .filter((i) => filter.since === undefined || i.ts > filter.since)
      .filter((i) => !filter.pattern || filter.pattern.test(extract(i)))
      .slice(-filter.limit);
  }

  size(): number {
    return this.items.length;
  }
}

type InflightRequest = { start: number; method: string; url: string; type: string };

/**
 * Retained per-tab request detail (headers + status) for network.getRequest.
 * Bodies are NOT buffered — they're fetched lazily via Network.getResponseBody
 * only when the model asks. Bounded to avoid unbounded growth on busy tabs.
 */
export interface RequestDetail {
  requestId: string;
  ts: number;
  method: string;
  url: string;
  status?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

export interface PendingDialog {
  type: string;        // "alert" | "confirm" | "prompt" | "beforeunload"
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export interface FrameTargetInfo {
  targetId: string;
  url: string;
  /** undefined = parent is the tab session; otherwise the parent OOPIF target id. */
  parentTargetId?: string;
}

export class DebuggerManager {
  private consoles = new Map<number, RingBuffer<ConsoleEntry>>();
  private networks = new Map<number, RingBuffer<NetworkEntry>>();
  private attached = new Set<number>();
  private inflight = new Map<string, InflightRequest>();
  private pendingDialogs = new Map<number, PendingDialog>();
  // Per-tab bounded list of recent request details (headers/status) for
  // network.getRequest. Bodies fetched lazily, never buffered.
  private requestDetails = new Map<number, RequestDetail[]>();
  private static readonly REQUEST_DETAIL_CAP = 500;
  // For cross-origin (OOPIF) iframes, Chromium spins up a separate CDP target.
  // We attach a debuggee per frame target so a11y/DOM/Runtime calls can reach
  // content inside those frames. Key is tabId → map of frame targetId → info.
  private frameTargets = new Map<number, Map<string, FrameTargetInfo>>();
  // Reverse lookup: which tab does a frame target belong to. Required because
  // chrome.debugger.onEvent fires for ALL attached sessions — including frame
  // sessions whose source has only `targetId`, not `tabId`. Without this map
  // we'd silently drop nested-OOPIF Target.attachedToTarget events.
  private frameTargetToTab = new Map<string, number>();

  constructor() {
    chrome.tabs.onRemoved.addListener((tabId) => { void this.detach(tabId); });
    chrome.debugger.onEvent.addListener((src, method, params) =>
      this.onEvent(src, method, params as Record<string, unknown>)
    );
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        this.pendingDialogs.delete(source.tabId);
        const frames = this.frameTargets.get(source.tabId);
        if (frames) {
          for (const id of frames.keys()) {
            this.frameTargetToTab.delete(id);
            void chrome.debugger.detach({ targetId: id }).catch(() => {});
          }
          this.frameTargets.delete(source.tabId);
        }
        // Keep console/network buffers — user may still want to read history post-detach; next attach resets them.
      } else if (source.targetId !== undefined) {
        // An iframe target went away (navigation, detach). Scrub it from every tab's set.
        const targetId = source.targetId;
        this.frameTargetToTab.delete(targetId);
        for (const frames of this.frameTargets.values()) {
          frames.delete(targetId);
        }
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Chrome refuses chrome.debugger.attach({tabId}) when the tab contains
      // a chrome-extension:// iframe from a different extension (1Password,
      // password managers, etc.). This is a hard Chrome restriction with no
      // client-side workaround — surface a helpful error instead of the
      // opaque internal one.
      if (/chrome-extension:\/\/.*different extension/i.test(msg)) {
        throw new Error(
          "Chromanche can't attach to this tab because another Chrome " +
          "extension has injected a chrome-extension:// iframe — Chrome " +
          "refuses debugger attach in that case. Most common culprits, in " +
          "order: (1) Anthropic's \"Claude in Chrome\" / Claude Code " +
          "extension (also drives Chrome via debugger and conflicts with " +
          "Chromanche on every page); (2) password managers (1Password, " +
          "Bitwarden, LastPass) on login forms; (3) shopping helpers (Honey, " +
          "Capital One Shopping). Disable the offending extension globally " +
          "or per-site, or use an Incognito window without extensions."
        );
      }
      throw e;
    }
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    this.consoles.set(tabId, new RingBuffer());
    this.networks.set(tabId, new RingBuffer());
    this.attached.add(tabId);
    this.frameTargets.set(tabId, new Map());
    // Subscribe to child-target lifecycle so we discover OOPIF frames
    // (cross-origin iframes running in a separate process). onEvent handles
    // Target.attachedToTarget / detachedFromTarget to maintain frameTargets.
    await chrome.debugger
      .sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
      })
      .catch(() => {});
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    const frames = this.frameTargets.get(tabId);
    if (frames) {
      for (const id of frames.keys()) {
        this.frameTargetToTab.delete(id);
        await chrome.debugger.detach({ targetId: id }).catch(() => {});
      }
      this.frameTargets.delete(tabId);
    }
    await chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.delete(tabId);
    this.consoles.delete(tabId);
    this.networks.delete(tabId);
    this.pendingDialogs.delete(tabId);
    this.requestDetails.delete(tabId);
    forgetScreenshot(tabId);
  }

  /**
   * Snapshot-time hook: yields one microtask so pending frame attachments
   * discovered via Target.attachedToTarget finish before we walk the tree.
   * Attach/detach themselves happen event-driven in onEvent.
   */
  async syncFrameTargets(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    // Yield to the macrotask queue so any pending Target.attachedToTarget
    // notifications (which arrive via IPC as macrotasks after
    // Target.setAutoAttach resolves) can fire and queue attach work.
    await new Promise<void>((r) => setTimeout(r, 0));
    const pending = this.pendingFrameAttach.get(tabId);
    if (pending && pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  /** Frame targets currently attached for a tab (OOPIFs only). */
  getFrameTargets(tabId: number): FrameTargetInfo[] {
    const set = this.frameTargets.get(tabId);
    return set ? [...set.values()] : [];
  }

  private pendingFrameAttach = new Map<number, Set<Promise<void>>>();

  /**
   * Called from onEvent when Target.attachedToTarget fires for an iframe.
   * We attach a chrome.debugger API handle for the new target and enable
   * the domains we need (DOM/Runtime/Accessibility) so snapshot + click
   * handlers can reach into the frame.
   *
   * `parentTargetId` is the session that fired the event — the tab session
   * (undefined) for top-level iframes, or another OOPIF target id for
   * grandchildren. We need this for nested OOPIFs because DOM.getFrameOwner
   * only resolves a frame's owner element on the SESSION whose process
   * actually contains that owner — i.e. the parent frame's session.
   */
  private attachFrameTarget(
    tabId: number,
    targetId: string,
    url: string,
    parentTargetId?: string,
  ): void {
    let tabFrames = this.frameTargets.get(tabId);
    if (!tabFrames) {
      tabFrames = new Map();
      this.frameTargets.set(tabId, tabFrames);
    }
    if (tabFrames.has(targetId)) return;
    let bucket = this.pendingFrameAttach.get(tabId);
    if (!bucket) {
      bucket = new Set();
      this.pendingFrameAttach.set(tabId, bucket);
    }
    const work = (async () => {
      try {
        await chrome.debugger.attach({ targetId }, "1.3");
        // Register the mapping BEFORE enabling domains/auto-attach. CDP
        // delivers Target.attachedToTarget events for existing grandchild
        // frames synchronously during setAutoAttach — if frameTargetToTab
        // doesn't have us yet, those events lose their tabId mapping in
        // onEvent and get silently dropped.
        tabFrames!.set(targetId, { targetId, url, parentTargetId });
        this.frameTargetToTab.set(targetId, tabId);
        await chrome.debugger.sendCommand({ targetId }, "DOM.enable");
        await chrome.debugger.sendCommand({ targetId }, "Runtime.enable");
        await chrome.debugger.sendCommand({ targetId }, "Accessibility.enable");
        // Recursive auto-attach: subscribe this frame's session to its OWN
        // child-target lifecycle so nested OOPIFs (Office365 pattern: shell →
        // app frame → addin frame) emit Target.attachedToTarget upward to us.
        await chrome.debugger
          .sendCommand({ targetId }, "Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: false,
          })
          .catch(() => {});
      } catch {
        tabFrames!.delete(targetId);
        this.frameTargetToTab.delete(targetId);
        await chrome.debugger.detach({ targetId }).catch(() => {});
      }
    })();
    bucket.add(work);
    work.finally(() => bucket!.delete(work));
  }

  private forgetFrameTarget(tabId: number, targetId: string): void {
    const tabFrames = this.frameTargets.get(tabId);
    if (tabFrames?.delete(targetId)) {
      this.frameTargetToTab.delete(targetId);
      void chrome.debugger.detach({ targetId }).catch(() => {});
    }
  }

  /** Return the currently-open JS dialog for a tab, if any. */
  getPendingDialog(tabId: number): PendingDialog | undefined {
    return this.pendingDialogs.get(tabId);
  }

  /** Clear the pending-dialog record for a tab (called after handling). */
  clearPendingDialog(tabId: number): void {
    this.pendingDialogs.delete(tabId);
  }

  async sendCommand<T = unknown>(
    tabId: number,
    method: string,
    params: unknown,
    targetId?: string,
  ): Promise<T> {
    await this.attach(tabId);
    if (targetId) {
      // Frame-scoped call. No reconnect-on-detach here: if an OOPIF dies
      // mid-call, the caller needs a fresh snapshot to learn its new uids
      // anyway, so just surface the error. Only forget the frame when the
      // error says the target itself is gone — an ordinary failure (bad
      // expression, node not found, context reset) must not drop a live
      // frame: Target.attachedToTarget never fires again for it, so it would
      // stay invisible until the whole tab re-attached.
      try {
        return (await chrome.debugger.sendCommand({ targetId }, method, params as object)) as T;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not attached|detached|no target with given id|target closed|cannot find (the )?target/i.test(msg)) {
          this.frameTargets.get(tabId)?.delete(targetId);
          this.frameTargetToTab.delete(targetId);
        }
        throw e;
      }
    }
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cover both "Debugger is not attached" (between calls) and "Detached while
      // handling command" (debugger got torn off mid-flight, e.g. on navigation).
      if (!/not attached|detached/i.test(msg)) throw e;
      this.attached.delete(tabId);
      await this.attach(tabId);
      return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
    }
  }

  readConsole(tabId: number, pattern?: string, since?: number, limit = 500): ConsoleEntry[] {
    const buf = this.consoles.get(tabId);
    if (!buf) return [];
    const re = pattern ? new RegExp(pattern) : undefined;
    return buf.read({ pattern: re, since, limit }, (e) => e.text);
  }

  readNetwork(tabId: number, pattern?: string, since?: number, limit = 500): NetworkEntry[] {
    const buf = this.networks.get(tabId);
    if (!buf) return [];
    const re = pattern ? new RegExp(pattern) : undefined;
    return buf.read({ pattern: re, since, limit }, (e) => e.url);
  }

  /**
   * Fetch headers + body for the NEWEST buffered request whose URL matches
   * `urlPattern`. Body is fetched lazily via Network.getResponseBody (never
   * buffered eagerly). Read-only: surfaces only requests the page already made.
   */
  async getRequestDetail(
    tabId: number,
    urlPattern: string,
    maxBytes: number,
  ): Promise<{
    method: string;
    url: string;
    status?: number;
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
    body: string;
    base64Encoded: boolean;
    truncated: boolean;
  }> {
    const list = this.requestDetails.get(tabId) ?? [];
    const re = new RegExp(urlPattern);
    // Newest match wins.
    const detail = [...list].reverse().find((d) => re.test(d.url));
    if (!detail) {
      throw new Error(
        `network.getRequest: no buffered request matching ${urlPattern}. ` +
        `Run network_read first to see what's available (bodies are only retained for requests made after the tab was attached).`,
      );
    }
    let body = "";
    let base64Encoded = false;
    try {
      const r = await this.sendCommand<{ body: string; base64Encoded: boolean }>(
        tabId,
        "Network.getResponseBody",
        { requestId: detail.requestId },
      );
      body = r.body ?? "";
      base64Encoded = !!r.base64Encoded;
    } catch {
      // Body may be evicted from CDP's buffer (long-lived tab) or absent
      // (204/304). Return headers/status with an empty body rather than fail.
      body = "";
    }
    const truncated = body.length > maxBytes;
    if (truncated) body = body.slice(0, maxBytes);
    return {
      method: detail.method,
      url: detail.url,
      status: detail.status,
      requestHeaders: detail.requestHeaders,
      responseHeaders: detail.responseHeaders,
      body,
      base64Encoded,
      truncated,
    };
  }

  /** Exposed for tests. */
  onEvent(src: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>): void {
    // Events arrive on whichever session emitted them. For the tab session
    // src.tabId is set; for an OOPIF frame session src.targetId is set. Map
    // frame-session events back to the owning tab so nested-OOPIF lifecycle
    // events (Target.attachedToTarget for grandchildren) reach us.
    const tabId =
      src.tabId ??
      (src.targetId !== undefined ? this.frameTargetToTab.get(src.targetId) : undefined);
    if (tabId === undefined) return;
    const consoleBuf = this.consoles.get(tabId);
    const netBuf = this.networks.get(tabId);

    if (method === "Target.attachedToTarget") {
      const info = (params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined) ?? {};
      if (info.type === "iframe" && info.targetId) {
        // Skip iframes from other extensions (1Password popups, password
        // managers, etc.). chrome.debugger.attach({targetId}) on a
        // chrome-extension:// frame of another extension TAINTS the entire
        // chrome.debugger session — subsequent operations on the parent tab
        // fail with "Cannot access a chrome-extension:// URL of different
        // extension". Note this only mitigates frame attaches; if Chrome's
        // own attach({tabId}) check rejects the tab because some other
        // extension already has a chrome-extension iframe injected, no
        // client-side workaround can recover.
        const url = info.url ?? "";
        if (url.startsWith("chrome-extension://")) return;
        // Parent of the new frame is whichever session fired this event:
        // tab (src.tabId) → undefined parent; OOPIF (src.targetId) → that
        // target id. The snapshot path needs this to call DOM.getFrameOwner
        // against the right session.
        const parentTargetId = src.tabId !== undefined ? undefined : src.targetId;
        this.attachFrameTarget(tabId, info.targetId, url, parentTargetId);
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const targetId = params.targetId as string | undefined;
      if (targetId) this.forgetFrameTarget(tabId, targetId);
      return;
    }

    if (method === "Runtime.consoleAPICalled" && consoleBuf) {
      const level = ((params.type as string) ?? "log") as ConsoleEntry["level"];
      const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>;
      const text = args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 2000);
      consoleBuf.push({ ts: Date.now(), level, text });
    } else if (method === "Runtime.exceptionThrown" && consoleBuf) {
      const text = ((params.exceptionDetails as Record<string, unknown> | undefined)?.text as string) ?? "exception";
      consoleBuf.push({ ts: Date.now(), level: "error", text });
    } else if (method === "Network.requestWillBeSent" && netBuf) {
      const req = (params.request as { method?: string; url?: string; headers?: Record<string, string> }) ?? {};
      this.inflight.set(params.requestId as string, {
        start: Date.now(),
        method: req.method ?? "GET",
        url: req.url ?? "",
        type: (params.type as string) ?? "Other",
      });
      // Retain request headers for network.getRequest (bounded per tab).
      const list = this.requestDetails.get(tabId) ?? [];
      list.push({
        requestId: params.requestId as string,
        ts: Date.now(),
        method: req.method ?? "GET",
        url: req.url ?? "",
        requestHeaders: req.headers ?? {},
        responseHeaders: {},
      });
      if (list.length > DebuggerManager.REQUEST_DETAIL_CAP) {
        list.splice(0, list.length - DebuggerManager.REQUEST_DETAIL_CAP);
      }
      this.requestDetails.set(tabId, list);
    } else if (method === "Network.responseReceived" && netBuf) {
      const cur = this.inflight.get(params.requestId as string);
      if (cur) {
        const resp = (params.response as { status?: number; headers?: Record<string, string> }) ?? {};
        netBuf.push({
          ts: Date.now(),
          method: cur.method,
          url: cur.url,
          status: resp.status,
          durationMs: Date.now() - cur.start,
          type: cur.type,
        });
        // Fill in status + response headers on the retained detail.
        const list = this.requestDetails.get(tabId);
        const detail = list?.find((d) => d.requestId === (params.requestId as string));
        if (detail) {
          detail.status = resp.status;
          detail.responseHeaders = resp.headers ?? {};
        }
        this.inflight.delete(params.requestId as string);
      }
    } else if (method === "Page.javascriptDialogOpening") {
      this.pendingDialogs.set(tabId, {
        type: String(params.type ?? "alert"),
        message: String(params.message ?? ""),
        defaultPrompt: params.defaultPrompt as string | undefined,
        url: params.url as string | undefined,
      });
    } else if (method === "Page.javascriptDialogClosed") {
      this.pendingDialogs.delete(tabId);
    }
  }
}

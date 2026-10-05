import type { Dispatcher } from "../dispatcher.js";
import { PageSnapshotParamsSchema, PageScreenshotParamsSchema } from "@chromanche/shared";
import { resolveTabId } from "../lib/active-tab.js";
import { captureA11ySnapshot } from "../lib/snapshot-manager.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { fitScale, rememberScreenshot } from "../lib/screenshot-transform.js";

/** Shared helper: produce an a11y snapshot string for a tab. Used by interaction handlers too. */
export async function takeA11ySnapshot(mgr: DebuggerManager, tabId: number, maxBytes = 80_000): Promise<string> {
  const { content } = await captureA11ySnapshot(mgr, tabId, maxBytes);
  return content;
}

// Runs in-page. Must be self-contained (no closures).
function textSnapshot(maxBytes: number) {
  const raw = document.body?.innerText ?? "";
  const truncated = raw.length > maxBytes;
  return {
    mode: "text" as const,
    url: location.href,
    title: document.title,
    content: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  };
}

function domSnapshot(maxBytes: number) {
  const raw = document.documentElement.outerHTML;
  const truncated = raw.length > maxBytes;
  return {
    mode: "dom" as const,
    url: location.href,
    title: document.title,
    content: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  };
}

function viewportSnapshot() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

interface CssViewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

/** CDP renders a hidden (background) tab only when it gets painted — don't hang on it. */
const CDP_CAPTURE_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Read pixel dimensions from a PNG/JPEG header (first few KB of base64 suffice). */
export function imageSize(base64: string): { width: number; height: number } | undefined {
  let bytes: Uint8Array;
  try {
    const head = base64.slice(0, 87_384); // ~64 KB decoded; length multiple of 4
    const bin = atob(head.slice(0, head.length - (head.length % 4)));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return undefined;
  }
  const u32 = (o: number) => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  const u16 = (o: number) => (bytes[o]! << 8) | bytes[o + 1]!;
  // PNG: 8-byte signature, then IHDR (width/height at 16/20).
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  // JPEG: walk segments to the first SOFn marker.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const marker = bytes[o + 1]!;
      if (marker === 0xff) { o++; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16(o + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: u16(o + 5), width: u16(o + 7) };
      o += 2 + len;
    }
  }
  return undefined;
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Fallback for when CDP capture is unavailable: chrome.tabs.captureVisibleTab
 * (device pixels of whatever tab is visible — so the caller must have checked
 * that our tab IS the visible one), then crop/downscale with OffscreenCanvas
 * when the runtime has it. Without OffscreenCanvas the full image is returned
 * and the transform still reports its exact scale.
 */
async function captureVisibleFallback(
  windowId: number,
  format: "png" | "jpeg",
  quality: number,
  region: { x: number; y: number; width: number; height: number },
  viewportCssWidth: number,
  scale: number,
): Promise<{ base64: string; width: number; height: number; origin: { x: number; y: number }; scale: number }> {
  const opts: chrome.tabs.CaptureVisibleTabOptions = format === "jpeg" ? { format: "jpeg", quality } : { format: "png" };
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  const comma = dataUrl.indexOf(",");
  const raw = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  const cib = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
  if (OC && cib) {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await cib(blob);
    const dpr = bmp.width / viewportCssWidth;
    const outW = Math.max(1, Math.round(region.width * scale));
    const outH = Math.max(1, Math.round(region.height * scale));
    const canvas = new OC(outW, outH);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, region.x * dpr, region.y * dpr, region.width * dpr, region.height * dpr, 0, 0, outW, outH);
    const out = await canvas.convertToBlob(format === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: quality / 100 });
    return {
      base64: bytesToBase64(await out.arrayBuffer()),
      width: outW,
      height: outH,
      origin: { x: region.x, y: region.y },
      scale: region.width / outW,
    };
  }
  const size = imageSize(raw);
  const width = size?.width ?? viewportCssWidth;
  const height = size?.height ?? Math.round(region.height);
  return { base64: raw, width, height, origin: { x: 0, y: 0 }, scale: viewportCssWidth / width };
}

export function registerPageReadHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.snapshot", async (raw) => {
    const p = PageSnapshotParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);

    if (p.mode === "a11y") {
      const { content, truncated, diff, baseline } = await captureA11ySnapshot(mgr, tabId, p.maxBytes, {
        includeBounds: p.includeBounds,
        since: p.since,
      });
      const tab = await chrome.tabs.get(tabId);
      return {
        mode: "a11y" as const,
        url: tab.url ?? "",
        title: tab.title ?? "",
        content,
        truncated,
        ...(diff ? { diff } : {}),
        ...(baseline ? { baseline } : {}),
      };
    }

    const fn = p.mode === "dom" ? domSnapshot : textSnapshot;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args: [p.maxBytes],
    });
    return result;
  });

  /**
   * Screenshot of THIS tab (CDP Page.captureScreenshot — not "whatever tab is
   * visible in the window"), scaled so the image fits common vision-model
   * limits without further resizing, with the image→viewport transform
   * returned and remembered for page_click_xy.
   */
  d.register("page.screenshot", async (raw) => {
    const p = PageScreenshotParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    const tab = await chrome.tabs.get(tabId);
    const [{ result: viewportRaw }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: viewportSnapshot,
    }).catch(() => [{ result: undefined }] as Array<{ result: undefined }>);
    const viewport = viewportRaw as Viewport | undefined;

    let css: CssViewport | undefined;
    try {
      const m = await mgr.sendCommand<{ cssVisualViewport?: CssViewport; cssLayoutViewport?: CssViewport }>(
        tabId, "Page.getLayoutMetrics", {},
      );
      css = m.cssVisualViewport ?? m.cssLayoutViewport;
    } catch {
      css = undefined;
    }
    const vw = css?.clientWidth || viewport?.width || 1280;
    const vh = css?.clientHeight || viewport?.height || 800;

    // Region in viewport CSS px, clamped to the viewport.
    const rx = Math.min(Math.max(0, p.clip?.x ?? 0), Math.max(0, vw - 1));
    const ry = Math.min(Math.max(0, p.clip?.y ?? 0), Math.max(0, vh - 1));
    const region = {
      x: rx,
      y: ry,
      width: Math.max(1, Math.min(p.clip?.width ?? vw, vw - rx)),
      height: Math.max(1, Math.min(p.clip?.height ?? vh, vh - ry)),
    };
    const scale = fitScale(region.width, region.height, p.maxEdge, p.maxPixels);

    let base64: string;
    let width: number;
    let height: number;
    let origin = { x: region.x, y: region.y };
    let cssPerImagePx: number;
    let capture: "cdp" | "visibleTab";
    try {
      const shot = await withTimeout(
        mgr.sendCommand<{ data: string }>(tabId, "Page.captureScreenshot", {
          format: p.format,
          ...(p.format === "jpeg" ? { quality: p.quality } : {}),
          // clip is in DOCUMENT coordinates → add the visual viewport's scroll offset.
          clip: {
            x: region.x + (css?.pageX ?? 0),
            y: region.y + (css?.pageY ?? 0),
            width: region.width,
            height: region.height,
            scale,
          },
          captureBeyondViewport: false,
        }),
        CDP_CAPTURE_TIMEOUT_MS,
        "Page.captureScreenshot",
      );
      base64 = shot.data;
      const size = imageSize(base64);
      width = size?.width ?? Math.max(1, Math.round(region.width * scale));
      height = size?.height ?? Math.max(1, Math.round(region.height * scale));
      cssPerImagePx = region.width / width;
      capture = "cdp";
    } catch (e) {
      // Only fall back to the window's visible tab when it IS this tab —
      // otherwise we'd hand back pixels of a different page.
      if (!tab.active || tab.windowId === undefined) {
        throw new Error(
          `page.screenshot: tab ${tabId} is in the background and didn't render a frame ` +
          `(${e instanceof Error ? e.message : String(e)}). Call tabs_activate(${tabId}) first — note that it ` +
          `brings the tab to the front of its window, so the user's typing would then go to it.`,
        );
      }
      const fb = await captureVisibleFallback(tab.windowId, p.format, p.quality, region, vw, scale);
      base64 = fb.base64;
      width = fb.width;
      height = fb.height;
      origin = fb.origin;
      cssPerImagePx = fb.scale;
      capture = "visibleTab";
    }

    rememberScreenshot(tabId, {
      originX: origin.x,
      originY: origin.y,
      scale: cssPerImagePx,
      imageWidth: width,
      imageHeight: height,
      takenAt: Date.now(),
    });
    return {
      format: p.format,
      base64,
      ...(viewport ? { viewport } : {}),
      image: { width, height },
      scale: Math.round(cssPerImagePx * 10_000) / 10_000,
      origin,
      capture,
    };
  });
}

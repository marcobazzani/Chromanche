/**
 * Per-tab memory of the most recent screenshot's image→viewport transform.
 *
 * The screenshot the model looks at is downscaled (and optionally clipped), so
 * a pixel position read off the image is NOT a CSS viewport coordinate. We
 * remember how the last image was produced and convert coordinates back:
 *   cssX = origin.x + imageX * scale,  cssY = origin.y + imageY * scale.
 */
export interface ScreenshotTransform {
  originX: number;
  originY: number;
  /** CSS px per image px. */
  scale: number;
  imageWidth: number;
  imageHeight: number;
  takenAt: number;
}

const transforms = new Map<number, ScreenshotTransform>();

export function rememberScreenshot(tabId: number, t: ScreenshotTransform): void {
  transforms.set(tabId, t);
}

export function lastScreenshot(tabId: number): ScreenshotTransform | undefined {
  return transforms.get(tabId);
}

export function forgetScreenshot(tabId: number): void {
  transforms.delete(tabId);
}

/** Test seam: drop every remembered transform. */
export function resetScreenshotTransforms(): void {
  transforms.clear();
}

export interface ResolvedPoint {
  x: number;
  y: number;
  spaceUsed: "screenshot" | "css";
}

/**
 * Map (x, y) given in `space` to a CSS viewport point. Throws when screenshot
 * coordinates fall outside the last image — the usual sign the caller passed
 * CSS pixels (e.g. a snapshot bbox) without space:"css".
 */
export function toCssPoint(tabId: number, x: number, y: number, space: "screenshot" | "css"): ResolvedPoint {
  if (space === "css") return { x, y, spaceUsed: "css" };
  const t = transforms.get(tabId);
  if (!t) return { x, y, spaceUsed: "css" };
  // Allow a 1px slack for rounding at the image edge.
  if (x > t.imageWidth + 1 || y > t.imageHeight + 1) {
    throw new Error(
      `(${x}, ${y}) is outside the last screenshot of this tab (${t.imageWidth}×${t.imageHeight} image px). ` +
      `If these are CSS pixels (e.g. a page_snapshot bbox), pass space:"css"; otherwise take a fresh page_screenshot.`,
    );
  }
  return {
    x: round2(t.originX + x * t.scale),
    y: round2(t.originY + y * t.scale),
    spaceUsed: "screenshot",
  };
}

/** Pick a scale (≤ 1) so the image fits both a long-edge cap and a pixel-count cap. */
export function fitScale(width: number, height: number, maxEdge: number, maxPixels: number): number {
  if (width <= 0 || height <= 0) return 1;
  const byEdge = maxEdge / Math.max(width, height);
  const byArea = Math.sqrt(maxPixels / (width * height));
  return Math.min(1, byEdge, byArea);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

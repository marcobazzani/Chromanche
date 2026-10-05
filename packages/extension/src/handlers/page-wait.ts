import type { Dispatcher } from "../dispatcher.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { PageWaitParamsSchema } from "@chromanche/shared";
import { resolveUid } from "../lib/snapshot-manager.js";
import { resolveFrame } from "../lib/focus.js";
import { takeA11ySnapshot } from "./page-read.js";

/**
 * Explicit waiting primitive — the missing piece for heavy async SPAs
 * (Power Automate's lazy canvas, Office365's async chrome). uid mode is
 * preferred and OOPIF-aware; selector/text/function run in the top frame by
 * default or in the frame picked by `frame`; response mode is observational
 * (only matches requests that arrive AFTER arming).
 */

interface VisibilityValue {
  connected: boolean;
  visible: boolean;
}

async function uidVisibility(
  mgr: DebuggerManager,
  tabId: number,
  uid: string,
): Promise<VisibilityValue | undefined> {
  const entry = resolveUid(tabId, uid);
  if (!entry) return undefined;
  let objectId: string | undefined;
  try {
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      entry.targetId,
    );
    objectId = r.object?.objectId;
  } catch {
    return { connected: false, visible: false };
  }
  if (!objectId) return { connected: false, visible: false };
  const r = await mgr.sendCommand<{ result: { value: VisibilityValue } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() {
        if (!this.isConnected) return { connected:false, visible:false };
        const r = this.getBoundingClientRect();
        const cs = getComputedStyle(this);
        const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        return { connected:true, visible };
      }`,
      returnByValue: true,
    },
    entry.targetId,
  );
  return r.result.value;
}

/** True when the wait condition (state) is satisfied for the visibility reading. */
function stateSatisfied(state: string, v: VisibilityValue | undefined): boolean {
  switch (state) {
    case "attached":
      return !!v?.connected;
    case "detached":
      return !v || !v.connected;
    case "visible":
      return !!v?.visible;
    case "hidden":
      return !v?.visible;
    default:
      return false;
  }
}

async function selectorVisibility(
  mgr: DebuggerManager,
  tabId: number,
  selector: string,
  targetId?: string,
): Promise<VisibilityValue | undefined> {
  const r = await mgr.sendCommand<{ result: { value: VisibilityValue } }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { connected:false, visible:false };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        return { connected:true, visible };
      })()`,
      returnByValue: true,
    },
    targetId,
  );
  return r.result.value;
}

async function evalTruthy(mgr: DebuggerManager, tabId: number, expression: string, targetId?: string): Promise<boolean> {
  const r = await mgr.sendCommand<{ result: { value?: unknown } }>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true },
    targetId,
  );
  return !!r.result.value;
}

export function registerPageWaitHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.wait", async (raw) => {
    const p = PageWaitParamsSchema.parse(raw);
    const start = Date.now();
    const deadline = start + p.timeoutMs;
    // Record arm time so response mode only matches NEW requests — never
    // replays the user's prior network history (data-residency principle).
    const armedAt = start;
    let lastNetTs = armedAt;
    // selector / text / function modes may target an iframe (resolved once).
    const usesFrame = p.for === "selector" || p.for === "text" || p.for === "function";
    const frameTarget = usesFrame && p.frame ? (await resolveFrame(mgr, p.tabId, p.frame)).targetId : undefined;

    for (;;) {
      let satisfied = false;
      switch (p.for) {
        case "uid": {
          const v = await uidVisibility(mgr, p.tabId, p.uid!);
          satisfied = stateSatisfied(p.state, v);
          break;
        }
        case "selector": {
          const v = await selectorVisibility(mgr, p.tabId, p.selector!, frameTarget);
          satisfied = stateSatisfied(p.state, v);
          break;
        }
        case "function": {
          satisfied = await evalTruthy(mgr, p.tabId, p.expression!, frameTarget);
          break;
        }
        case "text": {
          // Case-insensitive substring of VISIBLE page text (innerText, not
          // innerHTML — hidden markup must not false-positive).
          const r = await mgr.sendCommand<{ result: { value: boolean } }>(
            p.tabId,
            "Runtime.evaluate",
            {
              expression: `((document.body && document.body.innerText) || "").toLowerCase().includes(${JSON.stringify(
                p.text!.toLowerCase(),
              )})`,
              returnByValue: true,
            },
            frameTarget,
          );
          const present = !!r.result.value;
          satisfied = p.state === "hidden" || p.state === "detached" ? !present : present;
          break;
        }
        case "response": {
          const hits = mgr.readNetwork(p.tabId, p.urlPattern, armedAt, 2000);
          satisfied = hits.length > 0;
          break;
        }
        case "loadstate": {
          if (p.loadState === "networkidle") {
            const recent = mgr.readNetwork(p.tabId, undefined, lastNetTs, 2000);
            if (recent.length > 0) {
              lastNetTs = recent[recent.length - 1]!.ts;
            } else if (Date.now() - lastNetTs >= 500) {
              satisfied = true;
            }
          } else {
            const ready = await evalTruthy(
              mgr,
              p.tabId,
              p.loadState === "load"
                ? `document.readyState === "complete"`
                : `document.readyState === "interactive" || document.readyState === "complete"`,
            );
            satisfied = ready;
          }
          break;
        }
      }

      if (satisfied) {
        const snapshot = p.includeSnapshot ? await takeA11ySnapshot(mgr, p.tabId) : undefined;
        return { ok: true as const, matched: true, waitedMs: Date.now() - start, snapshot };
      }
      if (Date.now() >= deadline) {
        throw new Error(`page.wait timed out after ${p.timeoutMs}ms waiting for ${p.for}`);
      }
      await new Promise((res) => setTimeout(res, p.pollMs));
    }
  });
}

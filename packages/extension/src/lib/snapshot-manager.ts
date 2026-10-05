/**
 * CDP-based accessibility snapshot with stable uid annotations.
 *
 * Uses Accessibility.getFullAXTree to get the browser's real a11y tree,
 * assigns short uids (e.g. "e12") to each interactive/named node, and
 * maintains a uid→backendNodeId map so later interactions can resolve
 * a uid back to a concrete DOM element.
 *
 * Cross-origin (OOPIF) iframes have their own CDP target. We pull each
 * one's tree separately and splice it in at the parent iframe node,
 * tagging the frame's uids with a targetId so interaction handlers can
 * route clicks/type/etc. to the right session.
 */

import type { DebuggerManager } from "./debugger-manager.js";

export interface UidEntry {
  backendNodeId: number;
  role: string;
  name: string;
  /** undefined = main tab frame; otherwise the OOPIF's CDP targetId. */
  targetId?: string;
}

/** Per-tab uid map. Rebuilt on each snapshot (only nodes present now resolve). */
const tabUidMaps = new Map<number, Map<string, UidEntry>>();
/**
 * Per-tab stable identity → uid, so the SAME DOM node keeps the SAME uid across
 * snapshots (identity = frame target + backendNodeId). Without this every
 * snapshot re-minted uids and since:"last" diffs — which only print changed
 * lines — left unchanged elements un-addressable.
 */
const tabStableUids = new Map<number, Map<string, string>>();
let uidCounter = 0;

function nextUid(): string {
  return `e${uidCounter++}`;
}

/** Resolve a uid to a backendNodeId for the given tab. */
export function resolveUid(tabId: number, uid: string): UidEntry | undefined {
  return tabUidMaps.get(tabId)?.get(uid);
}

/** Clear uid map for a tab (e.g. on tab close). */
export function clearUidMap(tabId: number): void {
  tabUidMaps.delete(tabId);
  tabStableUids.delete(tabId);
  tabPrevLines.delete(tabId);
}

// Roles that are always "interesting" even without a name.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "option", "listitem",
  "textField", "TextField",
]);

// Roles to skip entirely (layout/container noise).
const SKIP_ROLES = new Set([
  "none", "presentation", "generic", "InlineTextBox",
  "LineBreak",
]);

interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
  parentId?: string;
}

interface AXTreeResult {
  nodes: AXNode[];
}

interface FrameSubtree {
  /** backendNodeId of the iframe ELEMENT in the parent document. Valid in
   *  the parent SESSION's id space — i.e. the tab session for top-level
   *  iframes, or the parent OOPIF's session for nested ones. */
  ownerBackendNodeId: number;
  /** The session whose id space ownerBackendNodeId is valid in. undefined =
   *  tab session; otherwise the parent OOPIF target id. */
  parentTargetId?: string;
  targetId: string;
  nodes: AXNode[];
}

interface SnapshotOptions {
  includeBounds?: boolean;
  /** "last" returns only lines changed since the previous a11y snapshot of this tab. */
  since?: "full" | "last";
}

/** Previous rendered a11y lines per tab — baseline for since="last" diffing. */
const tabPrevLines = new Map<number, string[]>();

function getProp(node: AXNode, propName: string): unknown {
  const p = node.properties?.find((x) => x.name === propName);
  return p?.value?.value;
}

function isInteresting(node: AXNode): boolean {
  if (node.ignored) return false;
  const role = node.role?.value ?? "";
  if (SKIP_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Has a meaningful name?
  const name = (node.name?.value ?? "").trim();
  if (name.length > 0) return true;
  // Has focusable/editable property?
  if (getProp(node, "focusable") === true) return true;
  return false;
}

export async function captureA11ySnapshot(
  mgr: DebuggerManager,
  tabId: number,
  maxBytes: number,
  opts: SnapshotOptions = {},
): Promise<{ content: string; truncated: boolean; diff?: { added: number; removed: number }; baseline?: boolean }> {
  // Refresh OOPIF attachments — new iframes since the last snapshot
  // need to be discovered, and old ones cleaned up.
  await mgr.syncFrameTargets(tabId).catch(() => {});

  await mgr.sendCommand(tabId, "Accessibility.enable", {});
  const main = await mgr.sendCommand<AXTreeResult>(tabId, "Accessibility.getFullAXTree", {});

  // Pull every OOPIF subtree. For each frame, DOM.getFrameOwner must be
  // invoked on the PARENT session — the only one whose process contains
  // the owner iframe element. Top-level OOPIFs have parentTargetId
  // undefined (parent = tab session); nested ones have a parent OOPIF.
  const frameTrees: FrameSubtree[] = [];
  for (const f of mgr.getFrameTargets(tabId)) {
    try {
      const owner = await mgr.sendCommand<{ backendNodeId: number }>(
        tabId,
        "DOM.getFrameOwner",
        { frameId: f.targetId },
        f.parentTargetId, // <-- key fix for nested OOPIFs
      );
      const sub = await mgr.sendCommand<AXTreeResult>(
        tabId,
        "Accessibility.getFullAXTree",
        {},
        f.targetId,
      );
      frameTrees.push({
        ownerBackendNodeId: owner.backendNodeId,
        parentTargetId: f.parentTargetId,
        targetId: f.targetId,
        nodes: sub.nodes,
      });
    } catch {
      // Frame vanished between syncFrameTargets and here, or a11y isn't
      // ready yet. Skip this one — the parent tree will still render it
      // as an opaque iframe node.
    }
  }

  // Index frames by (parentTargetId, ownerBackendNodeId). backendNodeIds
  // are scoped to the session whose process owns them, so we cannot use a
  // flat global map — the same numeric id could appear in two different
  // sessions and refer to different elements.
  const frameByOwnerInSession = new Map<string, Map<number, FrameSubtree>>();
  const sessionKey = (parentTargetId: string | undefined): string =>
    parentTargetId ?? "<tab>";
  for (const sub of frameTrees) {
    const key = sessionKey(sub.parentTargetId);
    let m = frameByOwnerInSession.get(key);
    if (!m) {
      m = new Map();
      frameByOwnerInSession.set(key, m);
    }
    m.set(sub.ownerBackendNodeId, sub);
  }

  const uidMap = new Map<string, UidEntry>();
  const prevStable = tabStableUids.get(tabId);
  const stable = new Map<string, string>();
  const lines: string[] = [];
  let totalLen = 0;
  let truncated = false;

  async function nodeBoundsAttr(node: AXNode, targetId?: string): Promise<string | undefined> {
    if (!opts.includeBounds || node.backendDOMNodeId === undefined) return undefined;
    try {
      const box = await mgr.sendCommand<{ model: { content: number[] } }>(
        tabId,
        "DOM.getBoxModel",
        { backendNodeId: node.backendDOMNodeId },
        targetId,
      );
      const q = box.model.content;
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      return `bbox=${Math.round(left)},${Math.round(top)},${Math.round(right - left)},${Math.round(bottom - top)}`;
    } catch {
      return undefined;
    }
  }

  async function walkTree(nodes: AXNode[], rootDepth: number, targetId?: string): Promise<void> {
    if (truncated) return;
    const nodeMap = new Map<string, AXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    if (!root) return;

    async function walk(nodeId: string, depth: number): Promise<void> {
      if (truncated) return;
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const role = node.role?.value ?? "";
      if (SKIP_ROLES.has(role) && !node.childIds?.length) return;

      let childrenDepth = depth;
      if (isInteresting(node) && node.backendDOMNodeId) {
        const identity = `${targetId ?? ""}:${node.backendDOMNodeId}`;
        const uid = prevStable?.get(identity) ?? nextUid();
        stable.set(identity, uid);
        const name = (node.name?.value ?? "").trim();
        uidMap.set(uid, {
          backendNodeId: node.backendDOMNodeId,
          role,
          name,
          targetId,
        });

        const attrs: string[] = [];
        if (getProp(node, "focusable") === true) attrs.push("focusable");
        if (getProp(node, "disabled") === true) attrs.push("disabled");
        if (getProp(node, "checked") === true) attrs.push("checked");
        if (getProp(node, "selected") === true) attrs.push("selected");
        if (getProp(node, "expanded") === true) attrs.push("expanded");
        if (getProp(node, "expanded") === false) attrs.push("collapsed");
        if (getProp(node, "required") === true) attrs.push("required");
        if (getProp(node, "readonly") === true) attrs.push("readonly");
        const val = getProp(node, "value");
        if (val !== undefined && val !== "") attrs.push(`value="${String(val).slice(0, 80)}"`);
        const bbox = await nodeBoundsAttr(node, targetId);
        if (bbox) attrs.push(bbox);

        const indent = "  ".repeat(depth);
        const nameStr = name ? ` "${name.slice(0, 100)}"` : "";
        const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
        const line = `${indent}[${uid}] ${role}${nameStr}${attrStr}`;

        totalLen += line.length + 1;
        if (totalLen > maxBytes) {
          truncated = true;
          return;
        }
        lines.push(line);
        childrenDepth = depth + 1;
      }

      // If this node is the owning iframe of an OOPIF, dive into the
      // frame's tree at the next depth instead of recursing into the
      // (empty) iframe children in the parent document. Look up the
      // mapping in the CURRENT session's bucket — the tab session for
      // the top walk, or the current frame's session for nested walks.
      const owners = frameByOwnerInSession.get(sessionKey(targetId));
      if (
        owners &&
        node.backendDOMNodeId !== undefined &&
        owners.has(node.backendDOMNodeId)
      ) {
        const sub = owners.get(node.backendDOMNodeId)!;
        await walkTree(sub.nodes, childrenDepth, sub.targetId);
        return;
      }

      const kids = node.childIds ?? [];
      for (const kid of kids) {
        if (truncated) break;
        await walk(kid, childrenDepth);
      }
    }

    await walk(root.nodeId, rootDepth);
  }

  await walkTree(main.nodes, 0, undefined);
  tabUidMaps.set(tabId, uidMap);
  tabStableUids.set(tabId, stable);

  const prev = tabPrevLines.get(tabId);
  // Always update the baseline to the freshly rendered full tree.
  tabPrevLines.set(tabId, lines);

  if (opts.since === "last") {
    if (!prev) {
      // No baseline yet → return the full tree and flag it.
      return { content: lines.join("\n"), truncated, baseline: true };
    }
    // uids are stable per DOM node, so lines compare as-is: an unchanged
    // element keeps its line (and uid) and is omitted; a node that was
    // re-created shows as -old/+new because its uid changed — which tells the
    // model the old uid is gone.
    const prevSet = new Set(prev);
    const curSet = new Set(lines);
    const added = lines.filter((l) => !prevSet.has(l));
    const removed = prev.filter((l) => !curSet.has(l));
    const diffLines = [
      ...added.map((l) => `+ ${l}`),
      ...removed.map((l) => `- ${l}`),
    ];
    return {
      content: diffLines.join("\n"),
      truncated,
      diff: { added: added.length, removed: removed.length },
    };
  }

  return { content: lines.join("\n"), truncated };
}

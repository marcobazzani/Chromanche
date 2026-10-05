/**
 * Keyboard synthesis shared by every input handler.
 *
 * Multi-OS rules (Chromanche drives Chrome on macOS, Windows, Linux and
 * ChromeOS — and under WSL the MCP server's OS differs from the browser's, so
 * the platform is always taken from the BROWSER via chrome.runtime):
 *
 *  - Windows / Linux / ChromeOS: Blink's own key bindings turn Ctrl+A/C/X/V/Z
 *    into editing commands, so a plain CDP key event is enough.
 *  - macOS: those shortcuts are Cmd-based and normally resolved by the
 *    browser's menu / NSResponder layer, which CDP-dispatched events bypass.
 *    A bare Cmd+V keydown reaches the page but never pastes. The fix (same as
 *    Playwright's macEditingCommands) is to attach the matching Blink editing
 *    command via Input.dispatchKeyEvent's `commands` field.
 *  - "ControlOrMeta" lets callers say "the platform shortcut modifier" without
 *    knowing the OS: Meta on macOS, Control elsewhere.
 */
import type { DebuggerManager } from "./debugger-manager.js";

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export type ModifierName = "Alt" | "Control" | "Meta" | "Shift" | "ControlOrMeta";

// CDP Input.dispatchKeyEvent modifier bit field.
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export const KEY_DEFS: Record<string, KeyDef> = {
  Enter:      { key: "Enter",      code: "Enter",      keyCode: 13, text: "\r" },
  Tab:        { key: "Tab",        code: "Tab",        keyCode: 9 },
  Escape:     { key: "Escape",     code: "Escape",     keyCode: 27 },
  Backspace:  { key: "Backspace",  code: "Backspace",  keyCode: 8 },
  Delete:     { key: "Delete",     code: "Delete",     keyCode: 46 },
  Insert:     { key: "Insert",     code: "Insert",     keyCode: 45 },
  ArrowUp:    { key: "ArrowUp",    code: "ArrowUp",    keyCode: 38 },
  ArrowDown:  { key: "ArrowDown",  code: "ArrowDown",  keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft",  code: "ArrowLeft",  keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home:       { key: "Home",       code: "Home",       keyCode: 36 },
  End:        { key: "End",        code: "End",        keyCode: 35 },
  PageUp:     { key: "PageUp",     code: "PageUp",     keyCode: 33 },
  PageDown:   { key: "PageDown",   code: "PageDown",   keyCode: 34 },
  Space:      { key: " ",          code: "Space",      keyCode: 32, text: " " },
  F1:  { key: "F1",  code: "F1",  keyCode: 112 },
  F2:  { key: "F2",  code: "F2",  keyCode: 113 },
  F3:  { key: "F3",  code: "F3",  keyCode: 114 },
  F4:  { key: "F4",  code: "F4",  keyCode: 115 },
  F5:  { key: "F5",  code: "F5",  keyCode: 116 },
  F6:  { key: "F6",  code: "F6",  keyCode: 117 },
  F7:  { key: "F7",  code: "F7",  keyCode: 118 },
  F8:  { key: "F8",  code: "F8",  keyCode: 119 },
  F9:  { key: "F9",  code: "F9",  keyCode: 120 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
  F11: { key: "F11", code: "F11", keyCode: 122 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

/**
 * US-keyboard virtual key codes for punctuation. Critical for typing into
 * apps that branch on keyCode at the keydown level (rich editors, anything
 * with custom shortcut handling). Without this map, "." was dispatched with
 * keyCode 46 — which is Delete — and such editors ate the period during
 * insertion, silently corrupting emails, URLs, decimals.
 */
const PUNCT_KEYCODES: Record<string, { code: string; keyCode: number }> = {
  " ":  { code: "Space",        keyCode: 32  },
  ".":  { code: "Period",       keyCode: 190 },
  ",":  { code: "Comma",        keyCode: 188 },
  ";":  { code: "Semicolon",    keyCode: 186 },
  "'":  { code: "Quote",        keyCode: 222 },
  "/":  { code: "Slash",        keyCode: 191 },
  "\\": { code: "Backslash",    keyCode: 220 },
  "[":  { code: "BracketLeft",  keyCode: 219 },
  "]":  { code: "BracketRight", keyCode: 221 },
  "-":  { code: "Minus",        keyCode: 189 },
  "=":  { code: "Equal",        keyCode: 187 },
  "`":  { code: "Backquote",    keyCode: 192 },
};

/**
 * CDP key descriptor for one character. \n → Enter, \t → Tab. Characters with
 * no deterministic virtual key (shifted punctuation like @, accented letters,
 * emoji) get keyCode 0 so apps don't fire shortcut handlers; `text` is what
 * gets inserted. `code` stays non-empty (some Chrome versions reject "").
 */
export function charToKeyDef(ch: string): KeyDef {
  if (ch === "\n" || ch === "\r") return KEY_DEFS.Enter!;
  if (ch === "\t") return KEY_DEFS.Tab!;
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  const punct = PUNCT_KEYCODES[ch];
  if (punct) return { key: ch, code: punct.code, keyCode: punct.keyCode, text: ch };
  return { key: ch, code: ch, keyCode: 0, text: ch };
}

/** Named key ("Enter", "F2", "PageDown"…) or a single character. */
export function resolveKey(key: string): KeyDef {
  if (KEY_DEFS[key]) return KEY_DEFS[key]!;
  if (key.length === 1) return charToKeyDef(key);
  return { key, code: key, keyCode: 0 };
}

/** Resolve modifier names to CDP flags; "ControlOrMeta" → Meta on macOS, Control elsewhere. */
export function modifierFlags(mods: readonly ModifierName[], mac: boolean): number {
  let flags = 0;
  for (const m of mods) {
    if (m === "Alt") flags |= MOD_ALT;
    else if (m === "Control") flags |= MOD_CTRL;
    else if (m === "Meta") flags |= MOD_META;
    else if (m === "Shift") flags |= MOD_SHIFT;
    else if (m === "ControlOrMeta") flags |= mac ? MOD_META : MOD_CTRL;
  }
  return flags;
}

/** The platform's primary shortcut modifier: ⌘ on macOS, Ctrl on Windows/Linux/ChromeOS. */
export function shortcutModifier(mac: boolean): number {
  return mac ? MOD_META : MOD_CTRL;
}

/**
 * macOS-only: key chords whose editing behaviour Chrome normally gets from the
 * native menu layer. Names are Blink editing commands (matched
 * case-insensitively). Text-inserting commands are deliberately absent — the
 * key event's own `text` handles insertion.
 */
const MAC_EDITING_COMMANDS: Record<string, string[]> = {
  "Meta+KeyA": ["selectAll"],
  "Meta+KeyC": ["copy"],
  "Meta+KeyX": ["cut"],
  "Meta+KeyV": ["paste"],
  "Meta+KeyZ": ["undo"],
  "Shift+Meta+KeyZ": ["redo"],
  "Meta+ArrowLeft": ["moveToLeftEndOfLine"],
  "Meta+ArrowRight": ["moveToRightEndOfLine"],
  "Meta+ArrowUp": ["moveToBeginningOfDocument"],
  "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Shift+Meta+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
  "Alt+ArrowLeft": ["moveWordLeft"],
  "Alt+ArrowRight": ["moveWordRight"],
  "Shift+Alt+ArrowLeft": ["moveWordLeftAndModifySelection"],
  "Shift+Alt+ArrowRight": ["moveWordRightAndModifySelection"],
  "Meta+Backspace": ["deleteToBeginningOfLine"],
  "Alt+Backspace": ["deleteWordBackward"],
  "Alt+Delete": ["deleteWordForward"],
};

export function macEditingCommands(code: string, flags: number): string[] | undefined {
  if (!(flags & (MOD_META | MOD_ALT))) return undefined;
  const parts: string[] = [];
  if (flags & MOD_SHIFT) parts.push("Shift");
  if (flags & MOD_CTRL) parts.push("Control");
  if (flags & MOD_ALT) parts.push("Alt");
  if (flags & MOD_META) parts.push("Meta");
  parts.push(code);
  return MAC_EDITING_COMMANDS[parts.join("+")];
}

/**
 * Send one key (keyDown + keyUp) via CDP, on the tab session or an OOPIF
 * frame session (targetId). Real keyboard events — required for apps that
 * ignore Input.insertText (custom editors with their own input pipeline).
 *
 * When any modifier other than Shift is held, no `text` is sent (Playwright
 * semantics): a chord is a command, not a character, and sending text would
 * let some pages insert a stray letter.
 */
export async function dispatchKey(
  mgr: DebuggerManager,
  tabId: number,
  kd: KeyDef,
  modifiers: number,
  targetId?: string,
  mac = false,
): Promise<void> {
  const textAllowed = (modifiers & ~MOD_SHIFT) === 0;
  const text = textAllowed ? kd.text : undefined;
  const commands = mac ? macEditingCommands(kd.code, modifiers) : undefined;
  await mgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: kd.key,
    code: kd.code,
    windowsVirtualKeyCode: kd.keyCode,
    nativeVirtualKeyCode: kd.keyCode,
    modifiers,
    ...(text !== undefined ? { text } : {}),
    ...(commands ? { commands } : {}),
  }, targetId);
  await mgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: kd.key,
    code: kd.code,
    windowsVirtualKeyCode: kd.keyCode,
    nativeVirtualKeyCode: kd.keyCode,
    modifiers,
  }, targetId);
}

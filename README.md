# Chromanche — self-hosted "Agent in Chrome"

<p align="center">
  <img src="packages/extension/icons/icon-128.png" alt="Chromanche logo" width="128" height="128">
</p>

[![CI](https://github.com/marcobazzani/Chromanche/actions/workflows/ci.yml/badge.svg)](https://github.com/marcobazzani/Chromanche/actions/workflows/ci.yml)

Lets any MCP-capable coding agent drive your real, logged-in Chrome through a local MCP server + MV3 extension. Works with Claude Code, Codex, OpenCode, GitHub Copilot CLI, and other MCP clients. No browser data leaves your machine; the MCP server binds `127.0.0.1` only.

## What you get

MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket. Current set (v0.14.0, 31 tools):

- **Tabs:** `tabs_list`, `tabs_create`, `tabs_close`, `tabs_activate`
- **Navigation & read:** `page_navigate`, `page_snapshot` (uid-annotated a11y tree / text / dom, optional bounds; `since:"last"` returns only changed lines since the tab's previous snapshot — a token/speed saver on heavy pages), `page_screenshot` (captures the named tab, even in the background; scaled to fit vision models, and the pixel positions you read off it go straight to `page_click_xy`; optional `clip` to zoom into a region)
- **Interact:** `page_click`, `page_click_xy` (vision-driven coordinate click, optional double-click), `page_type`, `page_paste` (clipboard write + ⌘V/Ctrl+V, verified; replaces the user's clipboard, so only when a paste is wanted), `page_focus` (loud focus reset for SPAs that grab focus), `page_focus_state` (inspect current focus), `page_hover`, `page_press_key`, `page_scroll` (js or real-wheel mode for virtualized grids), `page_fill_form`, `page_select`, `page_upload_file`, `page_drag`, `page_handle_dialog`. `page_click`/`page_type` auto-wait for the target to be actionable (visible/stable/enabled) — pass `force: true` to skip. `page_type`, `page_press_key`, `page_click_xy` and `page_paste` report where focus settled once the page applied the input, including any suggestion list, menu or dialog the action opened; `page_type` also drops an inline auto-completion so the field holds exactly what was typed. Keyboard shortcuts take `ControlOrMeta` (⌘ on macOS, Ctrl on Windows/Linux).
- **Wait:** `page_wait` (uid/selector/text/function/response/loadstate — the antidote to racing async SPAs; `text` waits for visible page text like "Payment complete" to appear/disappear; response mode is observational and doesn't claim the tab), `page_wait_for_download` (observe the user's real download completing — never redirects, never enumerates history)
- **Batch:** `page_batch` — run several tools sequentially in one MCP round-trip (click → type → screenshot, fill multi-step forms, write a whole grid row). Aborts on first error by default; pass `stopOnError: false` to collect per-step errors.
- **Network / JS:** `page_fetch`, `page_eval_js` (optional `frame`: the focused frame or a URL pattern, including cross-origin iframes), `console_read`, `network_read`, `network_get_request` (headers + body of one buffered request — drill into a failed Office365/Graph call; observational, never claims)
- **Multi-profile:** `chromanche_list_profiles` + optional `profile` field on every tool
- **Session:** `session_release`

The default `page_snapshot` mode returns a **CDP accessibility tree with stable uids** — each interactive element gets a `[uid]` you pass directly to click/type/hover. No CSS selector guessing. Set `includeBounds=true` to add `bbox=x,y,w,h` for accessible nodes when you need stronger visual positioning. All interaction tools support `includeSnapshot=true` to get an updated tree in the response, reducing round-trips.

**Multi-profile (v0.6.0+):** install the extension in multiple Chrome profiles — each generates a stable tag derived from `chrome.runtime.id`. Connected profiles appear in `chromanche_list_profiles`; pass `profile: "<tag>"` on any tool call to target a specific one. When exactly one profile is connected, the `profile` field is optional (auto-routes). When multiple are connected and the field is omitted, the tool returns a structured error with the list. Each Chrome profile can set a human-readable label in the extension popup.

**Zero-config pairing (v0.5.0+):** the MCP server and the extension both derive the same WebSocket port and auth token from `sha256(timezone + platform + salt)`. No copy-paste, no port config (except under WSL, see below). Set `CHROMANCHE_TOKEN` / `CHROMANCHE_PORT` on the server and paste matching values into the extension popup's advanced section if you need to override.

**Note on concurrent MCP sessions:** one session becomes the local WebSocket leader; concurrent sessions that hit the same derived port join it through the built-in proxy path. This lets multiple MCP clients or client sessions share the same connected extension without manual port changes.

Every interactive tool auto-claims its target tab: the tab is put into a distinct orange **"Agent"** tab group and gets an amber pulsing border + "Agent is using this tab" pill — so you always know when an MCP client is driving.

## Requirements

- Node 20+. If it's missing or older, the installer downloads the official Node.js 22 build into `~/.chromanche/node` (no sudo, SHA-256 checked, not added to your PATH) and points the MCP registrations at it.
- `curl` and `tar` for the installer (`unzip` is used when present, but not required)
- A Chromium-based browser (Chrome, Edge, Brave, Arc) — 116+
- Claude Code, Codex, OpenCode, GitHub Copilot CLI, or another MCP-capable client

## Quickstart (users)

One command — downloads the latest release, registers the MCP server with supported MCP clients when their CLIs are present, and prints the Chrome steps:

```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/install.sh | bash
```

Then load the extension as unpacked. No token paste — pairing happens automatically the first time your MCP client launches the server.

**Windows (agent in WSL, Chrome on Windows):** run the installer inside WSL. It registers the MCP server with the CLIs installed in WSL and copies the extension to `%USERPROFILE%\.chromanche\extension`; load that folder in Chrome. Automatic pairing is off under WSL (WSL and Chrome on Windows often see different timezones), so pair once by hand: in the extension popup, open **Advanced — override pairing** and enter port `48765` and the token the installer printed (it's also in `~/.chromanche/token` inside WSL; it stays the same across re-installs). The server still binds `127.0.0.1` only; Chrome reaches it through WSL2's localhost forwarding (on by default) or mirrored networking.

- **Nothing connects?** Tools return the pairing steps while no extension is connected. Check that the popup says port `48765` and the token matches `cat ~/.chromanche/token`, then that `Test-NetConnection 127.0.0.1 -Port 48765` succeeds in PowerShell (if not, check `localhostForwarding` in `%UserProfile%\.wslconfig`).
- **Chromium inside WSL (WSLg) instead?** Same pairing steps, in that browser's extension popup.

**Windows without WSL:** do it by hand — download the latest `chromanche-extension-*.zip` + `chromanche-mcp-server-*.tgz` from [Releases](https://github.com/marcobazzani/Chromanche/releases), unpack to `%USERPROFILE%\.chromanche\`, then register the MCP server per the installer's printed instructions.

**Uninstall:** removes Chromanche and legacy BrowserUse MCP registrations and installed files.
```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/uninstall.sh | bash
```

## Known limitations

- The overlay cannot inject into `chrome://` pages, the Chrome Web Store, or sites with particularly aggressive CSP — the tab group badge and an orange toolbar dot still appear, but the border does not.
- Developer-mode extension install only (no Chrome Web Store listing yet — manifest and privacy policy are ready).

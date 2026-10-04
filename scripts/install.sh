#!/usr/bin/env bash
# Chromanche installer — downloads a release and registers the MCP server
# with Claude Code, Codex (and OpenCode / GitHub Copilot CLI when present).
# Pairing is automatic: the extension and the MCP server derive the same
# token+port from your timezone + OS on each start. No copy-paste, no port
# config.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/install-dev.sh | bash
#
# Channels (single install — dev replaces stable, same dir, same MCP name):
#   stable (default) — latest GitHub release
#   dev              — latest CI-built dev-latest artifact from main
#
# Or directly:
#   CHROMANCHE_CHANNEL=dev bash scripts/install.sh
#
set -euo pipefail

REPO="marcobazzani/Chromanche"
CHANNEL="${CHROMANCHE_CHANNEL:-stable}"
case "$CHANNEL" in
  stable|dev) ;;
  *) printf '\033[1;31m×  \033[0m Unknown CHROMANCHE_CHANNEL=%s. Use stable|dev.\n' "$CHANNEL" >&2; exit 1 ;;
esac
INSTALL_DIR="${HOME}/.chromanche"
EXT_DIR="${INSTALL_DIR}/extension"
SERVER_DIR="${INSTALL_DIR}/mcp-server"
MCP_NAME="chromanche"

_note()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
_warn()  { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
_die()   { printf '\033[1;31m×  \033[0m %s\n' "$*" >&2; exit 1; }

# --- OS detection ------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) ;;
  Linux)  ;;
  MINGW*|MSYS*|CYGWIN*) _die "Windows detected. Use WSL, or follow the manual install in the README." ;;
  *) _die "Unsupported OS: $OS. Install manually per the README." ;;
esac

# WSL: the MCP server runs in Linux, but the browser is usually Chrome on
# Windows. Same markers as the server's isWsl(): the env vars are set in WSL
# shells; the kernel release string covers the rest.
IS_WSL=0
if [ "$OS" = "Linux" ]; then
  KERNEL_RELEASE="$(uname -r 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  case "$KERNEL_RELEASE" in *microsoft*|*wsl*) IS_WSL=1 ;; esac
  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then IS_WSL=1; fi
fi

# Print the Windows user profile as a drive path (C:\Users\me), or nothing if
# WSL interop is unavailable. /d skips cmd.exe AutoRun hooks that could print
# noise; starting from /mnt/c avoids the "UNC paths are not supported" banner.
_wsl_windows_home() {
  command -v cmd.exe >/dev/null 2>&1 || return 0
  local out
  out="$(cd /mnt/c 2>/dev/null || true; cmd.exe /d /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' | tail -n 1)" || out=""
  case "$out" in
    [A-Za-z]:\\*) printf '%s' "$out" ;;
  esac
}

# --- Dependencies ------------------------------------------------------------
for cmd in curl tar node; do
  command -v "$cmd" >/dev/null 2>&1 || _die "'$cmd' is required but not installed."
done
command -v unzip >/dev/null 2>&1 || _die "'unzip' is required but not installed."

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  _die "Node 20+ required (found $(node -v)). Upgrade and re-run."
fi

# --- Download + unpack -------------------------------------------------------
TMP="$(mktemp -d -t chromanche-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$INSTALL_DIR"

# CHROMANCHE_INSTALL_OFFLINE lets integration tests drive the registration
# logic without hitting GitHub. Point it at a directory laid out like a real
# install (extension/ + mcp-server/dist/index.cjs) and the installer copies
# from it instead of downloading. Not documented for end users on purpose.
if [ -n "${CHROMANCHE_INSTALL_OFFLINE:-}" ]; then
  if [ ! -f "${CHROMANCHE_INSTALL_OFFLINE}/mcp-server/dist/index.cjs" ]; then
    _die "CHROMANCHE_INSTALL_OFFLINE=${CHROMANCHE_INSTALL_OFFLINE} is missing mcp-server/dist/index.cjs"
  fi
  TAG="offline"
  DISPLAY_VERSION="${TAG}"
  _note "Installing from offline source: ${CHROMANCHE_INSTALL_OFFLINE}"
  rm -rf "$EXT_DIR" "$SERVER_DIR"
  mkdir -p "$EXT_DIR" "$SERVER_DIR"
  if [ -d "${CHROMANCHE_INSTALL_OFFLINE}/extension" ]; then
    cp -R "${CHROMANCHE_INSTALL_OFFLINE}/extension/." "$EXT_DIR/"
  fi
  cp -R "${CHROMANCHE_INSTALL_OFFLINE}/mcp-server/." "$SERVER_DIR/"
elif [ "$CHANNEL" = "dev" ]; then
  TAG="dev-latest"
  DISPLAY_VERSION="${TAG}"
  ASSET_BASE="https://github.com/${REPO}/releases/download/${TAG}"
  EXT_URL="${ASSET_BASE}/chromanche-extension-${TAG}.zip"
  SRV_URL="${ASSET_BASE}/chromanche-mcp-server-${TAG}.tgz"

  _note "Installing ${REPO} ${TAG}"

  RAW="https://raw.githubusercontent.com/${REPO}/main"
  mkdir -p "${TMP}/lib"
  if curl -fsSL -o "${TMP}/cleanup-legacy.sh" "${RAW}/scripts/cleanup-legacy.sh" 2>/dev/null \
     && curl -fsSL -o "${TMP}/lib/mcp-config.mjs" "${RAW}/scripts/lib/mcp-config.mjs" 2>/dev/null; then
    bash "${TMP}/cleanup-legacy.sh" || _warn "Legacy BrowserUse cleanup hit an error — continuing."
  fi

  _note "Downloading dev extension..."
  curl -fsSL -o "${TMP}/extension.zip" "$EXT_URL"
  _note "Downloading dev MCP server..."
  curl -fsSL -o "${TMP}/mcp-server.tgz" "$SRV_URL"

  _note "Unpacking extension to ${EXT_DIR}"
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  unzip -q "${TMP}/extension.zip" -d "$EXT_DIR"

  _note "Unpacking MCP server to ${SERVER_DIR}"
  rm -rf "$SERVER_DIR"
  mkdir -p "$SERVER_DIR"
  tar -xzf "${TMP}/mcp-server.tgz" -C "$SERVER_DIR"
else
  # /releases/latest redirects to /releases/tag/vX.Y.Z (skips prereleases) —
  # no API, no auth, no rate limit.
  _note "Looking up latest Chromanche release..."
  LATEST_URL="$(curl -fsSI "https://github.com/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's#^[Ll]ocation: *\(.*\)#\1#p' | tr -d '\r' | tail -n1)"
  TAG="$(printf '%s' "$LATEST_URL" | sed 's#.*/tag/##')"

  if [ -z "${TAG:-}" ]; then
    _die "Could not resolve latest release. Check your network and try again."
  fi

  # Explicit override always wins.
  TAG="${CHROMANCHE_TAG:-$TAG}"
  DISPLAY_VERSION="${TAG}"

  ASSET_BASE="https://github.com/${REPO}/releases/download/${TAG}"
  EXT_URL="${ASSET_BASE}/chromanche-extension-${TAG}.zip"
  SRV_URL="${ASSET_BASE}/chromanche-mcp-server-${TAG}.tgz"

  # Releases before the rename published assets with the old BrowserUse prefix.
  # Keep the main-branch installer compatible until a Chromanche-named release is
  # available.
  if ! curl -fsLI "$EXT_URL" >/dev/null 2>&1; then
    EXT_URL="${ASSET_BASE}/browseruse-extension-${TAG}.zip"
  fi
  if ! curl -fsLI "$SRV_URL" >/dev/null 2>&1; then
    SRV_URL="${ASSET_BASE}/browseruse-mcp-server-${TAG}.tgz"
  fi

  _note "Installing ${REPO} ${TAG}"

  # BrowserUse was renamed to Chromanche (trademark). Nothing is migrated — the
  # old install is dropped so the fresh one takes over cleanly. Fetch the helper
  # scripts from the repo so this works whether install.sh was piped from curl
  # or run from a local clone.
  RAW="https://raw.githubusercontent.com/${REPO}/${TAG}"
  mkdir -p "${TMP}/lib"
  if curl -fsSL -o "${TMP}/cleanup-legacy.sh" "${RAW}/scripts/cleanup-legacy.sh" 2>/dev/null \
     && curl -fsSL -o "${TMP}/lib/mcp-config.mjs" "${RAW}/scripts/lib/mcp-config.mjs" 2>/dev/null; then
    bash "${TMP}/cleanup-legacy.sh" || _warn "Legacy BrowserUse cleanup hit an error — continuing."
  fi

  _note "Downloading extension..."
  curl -fsSL -o "${TMP}/extension.zip" "$EXT_URL"
  _note "Downloading MCP server..."
  curl -fsSL -o "${TMP}/mcp-server.tgz" "$SRV_URL"

  _note "Unpacking extension to ${EXT_DIR}"
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  unzip -q "${TMP}/extension.zip" -d "$EXT_DIR"

  _note "Unpacking MCP server to ${SERVER_DIR}"
  rm -rf "$SERVER_DIR"
  mkdir -p "$SERVER_DIR"
  tar -xzf "${TMP}/mcp-server.tgz" -C "$SERVER_DIR"
fi

# --- WSL: make the extension loadable by Chrome on Windows -------------------
# Mirror the extension into the Windows profile so Chrome loads it from a
# plain drive path instead of the Linux filesystem. The MCP server stays in
# WSL: Chrome on Windows reaches its 127.0.0.1 listener through WSL's default
# localhost forwarding.
LOAD_DIR="$EXT_DIR"
if [ "$IS_WSL" = "1" ]; then
  WIN_HOME="$(_wsl_windows_home)"
  WIN_HOME_UNIX=""
  if [ -n "$WIN_HOME" ] && command -v wslpath >/dev/null 2>&1; then
    WIN_HOME_UNIX="$(wslpath -u "$WIN_HOME" 2>/dev/null || true)"
  fi
  if [ -n "$WIN_HOME_UNIX" ] && [ -d "$WIN_HOME_UNIX" ]; then
    WIN_EXT_DIR="${WIN_HOME_UNIX}/.chromanche/extension"
    LOAD_DIR="${WIN_HOME}\\.chromanche\\extension"
    _note "WSL detected: copying the extension to ${LOAD_DIR} for Chrome on Windows"
    rm -rf "$WIN_EXT_DIR"
    mkdir -p "$WIN_EXT_DIR"
    cp -R "${EXT_DIR}/." "$WIN_EXT_DIR/"
  else
    UNC_EXT_DIR="$(printf '\\\\wsl.localhost\\%s%s' "${WSL_DISTRO_NAME:-<distro>}" "$(printf '%s' "$EXT_DIR" | tr '/' '\\')")"
    _warn "WSL detected, but your Windows user folder could not be located (is WSL interop enabled?)."
    _warn "Copy ${UNC_EXT_DIR} to a Windows folder and load that folder in Chrome."
    LOAD_DIR="the Windows folder you copied ${UNC_EXT_DIR} to"
  fi
fi

# --- Register with Claude Code ----------------------------------------------
ENTRY="${SERVER_DIR}/dist/index.cjs"
if [ ! -f "$ENTRY" ]; then
  _die "MCP server entrypoint not found at $ENTRY — install layout may have changed."
fi

if command -v claude >/dev/null 2>&1; then
  _note "Registering MCP server with Claude Code (user scope) as '${MCP_NAME}'..."
  if claude mcp list 2>/dev/null | grep -q "^${MCP_NAME}"; then
    _note "Existing '${MCP_NAME}' MCP entry found — removing and re-adding."
    claude mcp remove "${MCP_NAME}" --scope user >/dev/null 2>&1 || true
  fi
  claude mcp add "${MCP_NAME}" --scope user -- node "$ENTRY"
  CLAUDE_STATUS="registered"
else
  _warn "'claude' CLI not found on PATH. Add this manually to ~/.claude/settings.json:"
  cat <<EOF

{
  "mcpServers": {
    "${MCP_NAME}": {
      "command": "node",
      "args": ["${ENTRY}"]
    }
  }
}

EOF
  CLAUDE_STATUS="manual"
fi

# --- Register with OpenCode -------------------------------------------------
# OpenCode follows XDG on macOS/Linux: ~/.config/opencode/opencode.json. The
# old ~/.opencode/config.json path was a guess from an early installer and
# was never read by OpenCode — we still clean it up below so users who hit
# the bug do not end up with a stale, ignored config file.
XDG_CFG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
OC_CFG="${XDG_CFG_HOME}/opencode/opencode.json"
OC_LEGACY_CFG="${HOME}/.opencode/config.json"
OPENCODE_STATUS="skip"
if command -v opencode >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    _note "Registering MCP server with OpenCode (${OC_CFG})..."
    mkdir -p "$(dirname "$OC_CFG")"
    if [ -f "$OC_CFG" ]; then
      TMP_CFG="$(mktemp)"
      jq --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '.mcp[$k] = {"type":"local","command":[$n,$e],"enabled":true}' \
        "$OC_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$OC_CFG"
    else
      jq -n --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '{"$schema":"https://opencode.ai/config.json","mcp":{($k):{"type":"local","command":[$n,$e],"enabled":true}}}' \
        > "$OC_CFG"
    fi
    # Drop a stale entry from the legacy path so the user does not end up
    # with two MCP definitions, one of them dead.
    if [ -f "$OC_LEGACY_CFG" ]; then
      TMP_CFG="$(mktemp)"
      if jq --arg k "$MCP_NAME" 'if .mcp[$k] then del(.mcp[$k]) | (if (.mcp // {}) == {} then del(.mcp) else . end) else . end' \
        "$OC_LEGACY_CFG" > "$TMP_CFG" 2>/dev/null; then
        mv "$TMP_CFG" "$OC_LEGACY_CFG"
      else
        rm -f "$TMP_CFG"
      fi
    fi
    OPENCODE_STATUS="registered"
  else
    _warn "'jq' not found — cannot auto-update OpenCode config. Add manually to ${OC_CFG}:"
    cat <<EOF

{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "${MCP_NAME}": {
      "type": "local",
      "command": ["node", "${ENTRY}"],
      "enabled": true
    }
  }
}

EOF
    OPENCODE_STATUS="manual"
  fi
fi

# --- Register with Codex ----------------------------------------------------
CODEX_STATUS="skip"
if command -v codex >/dev/null 2>&1; then
  _note "Registering MCP server with Codex as '${MCP_NAME}'..."
  if codex mcp list 2>/dev/null | grep -q "^${MCP_NAME}[[:space:]]"; then
    _note "Existing '${MCP_NAME}' Codex MCP entry found — removing and re-adding."
    codex mcp remove "${MCP_NAME}" >/dev/null 2>&1 || true
  fi
  codex mcp add "${MCP_NAME}" -- node "$ENTRY"
  CODEX_STATUS="registered"
else
  _warn "'codex' CLI not found on PATH. Add this manually to ~/.codex/config.toml:"
  cat <<EOF

[mcp_servers.${MCP_NAME}]
command = "node"
args = ["${ENTRY}"]

EOF
  CODEX_STATUS="manual"
fi

# --- Register with GitHub Copilot CLI ---------------------------------------
GH_CFG="${HOME}/.copilot/mcp-config.json"
COPILOT_STATUS="skip"
if command -v copilot >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    _note "Registering MCP server with GitHub Copilot CLI..."
    mkdir -p "$(dirname "$GH_CFG")"
    # Copilot CLI requires the top-level key "mcpServers" (camelCase) — its
    # config validator rejects the file otherwise with "expected object,
    # received undefined" on path mcpServers. We also migrate any legacy
    # ".servers.<name>" entry from older installs into the new shape and
    # delete it so the config validates cleanly.
    if [ -f "$GH_CFG" ]; then
      TMP_CFG="$(mktemp)"
      jq --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" '
        (if (.servers // {}) | has($k) then del(.servers[$k]) else . end) |
        (if (.servers // {}) == {} then del(.servers) else . end) |
        .mcpServers[$k] = {"type":"stdio","command":$n,"args":[$e]}
      ' "$GH_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$GH_CFG"
    else
      jq -n --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '{"mcpServers":{($k):{"type":"stdio","command":$n,"args":[$e]}}}' \
        > "$GH_CFG"
    fi
    COPILOT_STATUS="registered"
  else
    _warn "'jq' not found — cannot auto-update Copilot config. Add manually to ${GH_CFG}:"
    cat <<EOF

{
  "mcpServers": {
    "${MCP_NAME}": {
      "type": "stdio",
      "command": "node",
      "args": ["${ENTRY}"]
    }
  }
}

EOF
    COPILOT_STATUS="manual"
  fi
fi

# --- Final instructions ------------------------------------------------------
WIN_COPY_LINE=""
if [ -n "${WIN_EXT_DIR:-}" ]; then
  WIN_COPY_LINE=$'\n'"  Windows copy: ${LOAD_DIR}"
fi
cat <<EOF

------------------------------------------------------------------
  Chromanche ${DISPLAY_VERSION} installed.
------------------------------------------------------------------

  Extension:   ${EXT_DIR}${WIN_COPY_LINE}
  MCP server:  ${ENTRY}

  Next steps:

  1. Open chrome://extensions
  2. Enable "Developer mode" (top-right toggle)
  3. Click "Load unpacked" and select:
       ${LOAD_DIR}
  4. Pin the Chromanche toolbar icon (puzzle-piece menu → pin)
  5. Start Claude Code, Codex, OpenCode, or GitHub Copilot CLI and try:
       "open https://example.com in a new tab and tell me the title"

  Pairing is automatic — the extension and MCP server derive a matching
  token and port from your timezone + OS. No paste needed. If you ever
  need to override (port conflict, multi-user workstation), set
  CHROMANCHE_TOKEN / CHROMANCHE_PORT on the server and paste matching
  values in the extension popup's advanced section.

EOF

if [ "$IS_WSL" = "1" ]; then
  cat <<EOF
  WSL: the MCP server runs here in WSL and pairs with Chrome on Windows
  by itself: it detects WSL, derives the Windows-side pairing, and WSL's
  default localhost forwarding carries the connection (no mirrored
  networking needed). If you run Chromium inside WSL instead, load
  ${EXT_DIR} there and set CHROMANCHE_BROWSER_PLATFORM=linux in the
  MCP server's environment (see the README).

EOF
fi

if [ "$CLAUDE_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ~/.claude/settings.json (see above)."
fi
if [ "$OPENCODE_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ${OC_CFG} (see above)."
fi
if [ "$CODEX_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ~/.codex/config.toml (see above)."
fi
if [ "$COPILOT_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ${GH_CFG} (see above)."
fi

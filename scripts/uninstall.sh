#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${HOME}/.chromanche"
LEGACY_DIR="${HOME}/.browseruse"
NAMES=("chromanche" "browseruse")
REPO="marcobazzani/Chromanche"
REF="${CHROMANCHE_REF:-main}"

CLAUDE_CFG="${HOME}/.claude/settings.json"
XDG_CFG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
OPENCODE_CFG="${XDG_CFG_HOME}/opencode/opencode.json"
OPENCODE_LEGACY_CFG="${HOME}/.opencode/config.json"
COPILOT_CFG="${HOME}/.copilot/mcp-config.json"
CODEX_CFG="${HOME}/.codex/config.toml"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TMP=""
cleanup_tmp() {
  if [ -n "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup_tmp EXIT

MCP_CONFIG_TOOL="${HERE}/lib/mcp-config.mjs"
if [ ! -f "$MCP_CONFIG_TOOL" ]; then
  TMP="$(mktemp -d -t chromanche-uninstall.XXXXXX)"
  MCP_CONFIG_TOOL="${TMP}/mcp-config.mjs"
  if ! curl -fsSL -o "$MCP_CONFIG_TOOL" "https://raw.githubusercontent.com/${REPO}/${REF}/scripts/lib/mcp-config.mjs" 2>/dev/null; then
    echo "!! Could not fetch config cleanup helper. CLI removals and installed files will still be removed." >&2
    MCP_CONFIG_TOOL=""
  fi
fi

if command -v claude >/dev/null 2>&1; then
  for name in "${NAMES[@]}"; do
    echo "==> Removing '${name}' MCP server registration from Claude Code (user scope)"
    claude mcp remove "$name" --scope user >/dev/null 2>&1 || true
  done
fi

if command -v codex >/dev/null 2>&1; then
  for name in "${NAMES[@]}"; do
    echo "==> Removing '${name}' MCP server registration from Codex"
    codex mcp remove "$name" >/dev/null 2>&1 || true
  done
fi

if [ -n "$MCP_CONFIG_TOOL" ]; then
  for name in "${NAMES[@]}"; do
    node "$MCP_CONFIG_TOOL" remove "$CLAUDE_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$OPENCODE_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$OPENCODE_LEGACY_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$COPILOT_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove-codex "$CODEX_CFG" "$name" || true
  done
fi

if [ -d "$INSTALL_DIR" ]; then
  echo "==> Removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
fi
if [ -d "$LEGACY_DIR" ]; then
  echo "==> Removing $LEGACY_DIR"
  rm -rf "$LEGACY_DIR"
fi

# Under WSL, install.sh also mirrors the extension into the Windows profile.
# Remove only that copy: %USERPROFILE%\.chromanche may also hold a native
# Windows install, which is not ours to delete.
IS_WSL=0
if [ "$(uname -s 2>/dev/null || echo unknown)" = "Linux" ]; then
  KERNEL_RELEASE="$(uname -r 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  case "$KERNEL_RELEASE" in *microsoft*|*wsl*) IS_WSL=1 ;; esac
  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then IS_WSL=1; fi
fi

# Same helper as install.sh (kept inline: both scripts must work when piped from curl).
_wsl_windows_home() {
  command -v cmd.exe >/dev/null 2>&1 || return 0
  local out
  out="$(cd /mnt/c 2>/dev/null || true; cmd.exe /d /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' | tail -n 1)" || out=""
  case "$out" in
    [A-Za-z]:\\*) printf '%s' "$out" ;;
  esac
}

if [ "$IS_WSL" = "1" ]; then
  WIN_HOME="$(_wsl_windows_home)"
  WIN_HOME_UNIX=""
  if [ -n "$WIN_HOME" ] && command -v wslpath >/dev/null 2>&1; then
    WIN_HOME_UNIX="$(wslpath -u "$WIN_HOME" 2>/dev/null || true)"
  fi
  if [ -n "$WIN_HOME_UNIX" ] && [ -d "${WIN_HOME_UNIX}/.chromanche/extension" ]; then
    echo "==> Removing ${WIN_HOME}\\.chromanche\\extension"
    rm -rf "${WIN_HOME_UNIX}/.chromanche/extension"
    rmdir "${WIN_HOME_UNIX}/.chromanche" 2>/dev/null || true
  fi
fi

echo "==> Done. Also remove the Chromanche and legacy BrowserUse extensions from chrome://extensions."

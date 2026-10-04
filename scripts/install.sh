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
# Only curl and tar are hard requirements: Node is installed below when
# missing, and zips can be extracted without unzip.
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || _die "'$cmd' is required but not installed."
done

TMP="$(mktemp -d -t chromanche-install.XXXXXX)"
trap 'rm -rf "$TMP" "${INSTALL_DIR}/.node-staging"' EXIT

mkdir -p "$INSTALL_DIR"

# --- Node.js -----------------------------------------------------------------
# The MCP server needs Node 20+. Use the system node when it is new enough.
# Otherwise download the official Node.js build into ~/.chromanche/node: no
# sudo, no package manager, any glibc Linux distro (incl. WSL) or macOS. MCP
# clients are then registered with its absolute path, so it never has to be
# on PATH, and uninstall.sh removes it with the rest of ~/.chromanche.
NODE_MIN_MAJOR=20
NODE_INSTALL_MAJOR=22
NODE_DIR="${INSTALL_DIR}/node"
# Mirror override (also the integration-test hook): a base URL laid out like
# https://nodejs.org/dist/latest-v22.x/ (SHASUMS256.txt next to the tarballs).
NODE_DIST="${CHROMANCHE_NODE_DIST_URL:-https://nodejs.org/dist/latest-v${NODE_INSTALL_MAJOR}.x}"
NODE_CMD="node"
PRIVATE_NODE=0

_node_usable() {
  local major
  major="$("$1" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

_install_private_node() {
  local os arch machine tarball version expected actual staging
  case "$OS" in
    Darwin) os="darwin" ;;
    *) os="linux" ;;
  esac
  machine="$(uname -m 2>/dev/null || echo unknown)"
  case "$machine" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7l" ;;
    ppc64le) arch="ppc64le" ;;
    s390x) arch="s390x" ;;
    *) _die "No official Node.js build for '${machine}'. Install Node ${NODE_MIN_MAJOR}+ yourself and re-run." ;;
  esac
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || _die "Need sha256sum or shasum to verify the Node.js download."

  if ! curl -fsSL -o "${TMP}/SHASUMS256.txt" "${NODE_DIST}/SHASUMS256.txt" 2>/dev/null; then
    if [ -x "${NODE_DIR}/bin/node" ] && _node_usable "${NODE_DIR}/bin/node"; then
      _warn "Could not reach ${NODE_DIST} to check for Node.js updates; keeping $("${NODE_DIR}/bin/node" -v)."
      NODE_CMD="${NODE_DIR}/bin/node"
      return 0
    fi
    _die "Could not download Node.js from ${NODE_DIST}. Install Node ${NODE_MIN_MAJOR}+ yourself and re-run."
  fi
  tarball="$(grep -oE "node-v[0-9]+\.[0-9]+\.[0-9]+-${os}-${arch}\.tar\.gz" "${TMP}/SHASUMS256.txt" | head -n 1 || true)"
  [ -n "$tarball" ] \
    || _die "No Node.js ${NODE_INSTALL_MAJOR} build for ${os}-${arch} at ${NODE_DIST}. Install Node ${NODE_MIN_MAJOR}+ yourself and re-run."
  version="${tarball#node-}"
  version="${version%%-*}"

  if [ -x "${NODE_DIR}/bin/node" ] && [ "$("${NODE_DIR}/bin/node" -v 2>/dev/null || true)" = "$version" ]; then
    _note "Using Chromanche's Node.js ${version} (${NODE_DIR})"
    NODE_CMD="${NODE_DIR}/bin/node"
    return 0
  fi

  _note "Installing Node.js ${version} for Chromanche into ${NODE_DIR} (no sudo)..."
  curl -fsSL -o "${TMP}/${tarball}" "${NODE_DIST}/${tarball}" \
    || _die "Could not download ${NODE_DIST}/${tarball}. Install Node ${NODE_MIN_MAJOR}+ yourself and re-run."
  expected="$(awk -v f="$tarball" '$2 == f { print $1 }' "${TMP}/SHASUMS256.txt")"
  actual="$(_sha256 "${TMP}/${tarball}")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    _die "Checksum mismatch for ${tarball} (expected ${expected:-nothing}, got ${actual}). Not installing it."
  fi

  # Stage inside INSTALL_DIR (/tmp may be mounted noexec) and swap it in only
  # once the binary has proven it runs here.
  staging="${INSTALL_DIR}/.node-staging"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "${TMP}/${tarball}" -C "$staging"
  if ! "${staging}/${tarball%.tar.gz}/bin/node" -v >/dev/null 2>&1; then
    rm -rf "$staging"
    _die "The official Node.js build doesn't run on this system (musl/Alpine, or a glibc older than 2.28?). Install Node ${NODE_MIN_MAJOR}+ with your package manager and re-run."
  fi
  rm -rf "$NODE_DIR"
  mv "${staging}/${tarball%.tar.gz}" "$NODE_DIR"
  rm -rf "$staging"
  NODE_CMD="${NODE_DIR}/bin/node"
}

if command -v node >/dev/null 2>&1 && _node_usable node; then
  : # System node is fine: MCP clients keep running plain `node`.
else
  if command -v node >/dev/null 2>&1; then
    _note "Found Node.js $(node -v 2>/dev/null || echo '(unknown version)'), but Chromanche needs ${NODE_MIN_MAJOR}+."
  else
    _note "Node.js not found."
    if [ "$IS_WSL" = "1" ] && command -v node.exe >/dev/null 2>&1; then
      _note "(Node.js on Windows doesn't count: the MCP server runs inside WSL.)"
    fi
  fi
  _install_private_node
  PRIVATE_NODE=1
  # Helpers below (legacy cleanup, zip extraction) run plain `node`.
  export PATH="${NODE_DIR}/bin:${PATH}"
fi

# Extract a zip with unzip when available, else with Node: fresh WSL and
# minimal distros often lack unzip, and installing it would need sudo. Our
# zips come from CI's `zip -r`: stored/deflated entries, no zip64.
ZIP_EXTRACT_JS='
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const [zipFile, dest] = process.argv.slice(1);
const buf = fs.readFileSync(zipFile);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error(zipFile + " is not a zip file");
const root = path.resolve(dest);
let p = buf.readUInt32LE(eocd + 16);
for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
  const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const local = buf.readUInt32LE(p + 42);
  const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  const out = path.resolve(root, name);
  if (out !== root && !out.startsWith(root + path.sep)) throw new Error("unsafe path in zip: " + name);
  if (name.endsWith("/")) { fs.mkdirSync(out, { recursive: true }); continue; }
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt zip entry: " + name);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const raw = buf.subarray(start, start + size);
  const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
  if (!data) throw new Error("unsupported zip compression method " + method + " for " + name);
  if (zlib.crc32 && zlib.crc32(data) !== crc) throw new Error("CRC mismatch for " + name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}
'
_extract_zip() {
  if command -v unzip >/dev/null 2>&1 && unzip -q "$1" -d "$2" 2>/dev/null; then
    return 0
  fi
  "$NODE_CMD" -e "$ZIP_EXTRACT_JS" "$1" "$2"
}

# --- Download + unpack -------------------------------------------------------
# CHROMANCHE_INSTALL_OFFLINE lets integration tests drive the registration
# logic without hitting GitHub. Point it at a directory laid out like a real
# install (extension/ or extension.zip, plus mcp-server/dist/index.cjs) and the
# installer copies from it instead of downloading. Not documented for end
# users on purpose.
if [ -n "${CHROMANCHE_INSTALL_OFFLINE:-}" ]; then
  if [ ! -f "${CHROMANCHE_INSTALL_OFFLINE}/mcp-server/dist/index.cjs" ]; then
    _die "CHROMANCHE_INSTALL_OFFLINE=${CHROMANCHE_INSTALL_OFFLINE} is missing mcp-server/dist/index.cjs"
  fi
  TAG="offline"
  DISPLAY_VERSION="${TAG}"
  _note "Installing from offline source: ${CHROMANCHE_INSTALL_OFFLINE}"
  rm -rf "$EXT_DIR" "$SERVER_DIR"
  mkdir -p "$EXT_DIR" "$SERVER_DIR"
  if [ -f "${CHROMANCHE_INSTALL_OFFLINE}/extension.zip" ]; then
    _extract_zip "${CHROMANCHE_INSTALL_OFFLINE}/extension.zip" "$EXT_DIR"
  elif [ -d "${CHROMANCHE_INSTALL_OFFLINE}/extension" ]; then
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
  _extract_zip "${TMP}/extension.zip" "$EXT_DIR"

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
  _extract_zip "${TMP}/extension.zip" "$EXT_DIR"

  _note "Unpacking MCP server to ${SERVER_DIR}"
  rm -rf "$SERVER_DIR"
  mkdir -p "$SERVER_DIR"
  tar -xzf "${TMP}/mcp-server.tgz" -C "$SERVER_DIR"
fi

# --- WSL: make the extension loadable by Chrome on Windows -------------------
# Mirror the extension into the Windows profile so Chrome loads it from a
# plain drive path instead of the Linux filesystem. The MCP server stays in
# WSL: Chrome on Windows reaches its 127.0.0.1 listener through WSL's
# localhost forwarding (default) or mirrored networking.
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

# --- Register with MCP clients -----------------------------------------------
# Each client ends up "registered", "missing" (its CLI isn't installed: fine
# unless the user uses it; re-running this installer registers it later) or
# "manual" (installed, but we couldn't edit its config). The summary at the
# end explains each one.
ENTRY="${SERVER_DIR}/dist/index.cjs"
if [ ! -f "$ENTRY" ]; then
  _die "MCP server entrypoint not found at $ENTRY — install layout may have changed."
fi

# --- Claude Code --------------------------------------------------------------
CLAUDE_STATUS="missing"
if command -v claude >/dev/null 2>&1; then
  _note "Registering MCP server with Claude Code (user scope) as '${MCP_NAME}'..."
  if claude mcp list 2>/dev/null | grep -q "^${MCP_NAME}"; then
    _note "Existing '${MCP_NAME}' MCP entry found — removing and re-adding."
    claude mcp remove "${MCP_NAME}" --scope user >/dev/null 2>&1 || true
  fi
  claude mcp add "${MCP_NAME}" --scope user -- "$NODE_CMD" "$ENTRY"
  CLAUDE_STATUS="registered"
fi

# --- Register with OpenCode -------------------------------------------------
# OpenCode follows XDG on macOS/Linux: ~/.config/opencode/opencode.json. The
# old ~/.opencode/config.json path was a guess from an early installer and
# was never read by OpenCode — we still clean it up below so users who hit
# the bug do not end up with a stale, ignored config file.
XDG_CFG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
OC_CFG="${XDG_CFG_HOME}/opencode/opencode.json"
OC_LEGACY_CFG="${HOME}/.opencode/config.json"
OPENCODE_STATUS="missing"
if command -v opencode >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    _note "Registering MCP server with OpenCode (${OC_CFG})..."
    mkdir -p "$(dirname "$OC_CFG")"
    if [ -f "$OC_CFG" ]; then
      TMP_CFG="$(mktemp)"
      jq --arg n "$NODE_CMD" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '.mcp[$k] = {"type":"local","command":[$n,$e],"enabled":true}' \
        "$OC_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$OC_CFG"
    else
      jq -n --arg n "$NODE_CMD" --arg e "$ENTRY" --arg k "$MCP_NAME" \
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
    _warn "OpenCode is installed, but 'jq' is missing, so its config can't be edited automatically. Add this to ${OC_CFG}:"
    cat <<EOF

{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "${MCP_NAME}": {
      "type": "local",
      "command": ["${NODE_CMD}", "${ENTRY}"],
      "enabled": true
    }
  }
}

EOF
    OPENCODE_STATUS="manual"
  fi
fi

# --- Register with Codex ----------------------------------------------------
CODEX_STATUS="missing"
if command -v codex >/dev/null 2>&1; then
  _note "Registering MCP server with Codex as '${MCP_NAME}'..."
  if codex mcp list 2>/dev/null | grep -q "^${MCP_NAME}[[:space:]]"; then
    _note "Existing '${MCP_NAME}' Codex MCP entry found — removing and re-adding."
    codex mcp remove "${MCP_NAME}" >/dev/null 2>&1 || true
  fi
  codex mcp add "${MCP_NAME}" -- "$NODE_CMD" "$ENTRY"
  CODEX_STATUS="registered"
fi

# --- Register with GitHub Copilot CLI ---------------------------------------
GH_CFG="${HOME}/.copilot/mcp-config.json"
COPILOT_STATUS="missing"
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
      jq --arg n "$NODE_CMD" --arg e "$ENTRY" --arg k "$MCP_NAME" '
        (if (.servers // {}) | has($k) then del(.servers[$k]) else . end) |
        (if (.servers // {}) == {} then del(.servers) else . end) |
        .mcpServers[$k] = {"type":"stdio","command":$n,"args":[$e]}
      ' "$GH_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$GH_CFG"
    else
      jq -n --arg n "$NODE_CMD" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '{"mcpServers":{($k):{"type":"stdio","command":$n,"args":[$e]}}}' \
        > "$GH_CFG"
    fi
    COPILOT_STATUS="registered"
  else
    _warn "GitHub Copilot CLI is installed, but 'jq' is missing, so its config can't be edited automatically. Add this to ${GH_CFG}:"
    cat <<EOF

{
  "mcpServers": {
    "${MCP_NAME}": {
      "type": "stdio",
      "command": "${NODE_CMD}",
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
NODE_LINE=""
if [ "$PRIVATE_NODE" = "1" ]; then
  NODE_LINE=$'\n'"  Node.js:     ${NODE_CMD} ($("$NODE_CMD" -v 2>/dev/null || true), private to Chromanche, not on your PATH)"
fi

# One line per MCP client: where Chromanche is available, and why not elsewhere.
_client_status() { # <label> <status> <cli> <config file for manual edits>
  case "$2" in
    registered) printf '    %-20s registered\n' "$1" ;;
    missing) printf "    %-20s skipped: '%s' is not installed (only needed if you use %s)\n" "$1" "$3" "$1" ;;
    manual) printf '    %-20s NOT registered: jq is missing; add the snippet printed above to %s\n' "$1" "$4" ;;
  esac
}
CLIENTS_SUMMARY="$(
  _client_status "Claude Code" "$CLAUDE_STATUS" claude ""
  _client_status "Codex" "$CODEX_STATUS" codex ""
  _client_status "OpenCode" "$OPENCODE_STATUS" opencode "$OC_CFG"
  _client_status "GitHub Copilot CLI" "$COPILOT_STATUS" copilot "$GH_CFG"
)"
case " $CLAUDE_STATUS $CODEX_STATUS $OPENCODE_STATUS $COPILOT_STATUS " in
  *" missing "*) CLIENTS_SUMMARY="${CLIENTS_SUMMARY}"$'\n'"    Install one of them later? Re-run this installer and it gets registered too." ;;
esac

# Under WSL, automatic pairing can't work reliably (WSL and Chrome on Windows
# often see different timezones), so the server uses a fixed port and a random
# token that the user enters in the extension popup once. Keep WSL_PORT and
# the token format in sync with packages/mcp-server/src/wsl.ts. The token is
# created here so it can be shown below; the server reuses it.
WSL_PORT=48765
if [ "$IS_WSL" = "1" ]; then
  TOKEN_FILE="${INSTALL_DIR}/token"
  WSL_TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
  if ! [[ "$WSL_TOKEN" =~ ^wsl_[0-9a-f]{64}$ ]]; then
    WSL_TOKEN="wsl_$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    (umask 077; printf '%s' "$WSL_TOKEN" > "$TOKEN_FILE")
  fi
  chmod 600 "$TOKEN_FILE"
fi

# Printed directly (not captured with $(...)): bash 3.2 misparses quotes in
# heredocs inside command substitutions.
_pair_steps() {
  if [ "$IS_WSL" = "1" ]; then
    cat <<EOF
  5. Pair the extension (needed once under WSL): click the Chromanche
     icon, open "Advanced — override pairing", enter
       Port:   ${WSL_PORT}
       Token:  ${WSL_TOKEN}
     and click "Save override". The token is kept in ${TOKEN_FILE}
     and stays the same when you re-run this installer.
  6. Start a registered MCP client (see above) and try:
       "open https://example.com in a new tab and tell me the title"
EOF
  else
    cat <<EOF
  5. Start a registered MCP client (see above) and try:
       "open https://example.com in a new tab and tell me the title"

  Pairing is automatic — the extension and MCP server derive a matching
  token and port from your timezone + OS. No paste needed. If you ever
  need to override (port conflict, multi-user workstation), set
  CHROMANCHE_TOKEN / CHROMANCHE_PORT on the server and paste matching
  values in the extension popup's advanced section.
EOF
  fi
}

cat <<EOF

------------------------------------------------------------------
  Chromanche ${DISPLAY_VERSION} installed.
------------------------------------------------------------------

  Extension:   ${EXT_DIR}${WIN_COPY_LINE}
  MCP server:  ${ENTRY}${NODE_LINE}

  MCP clients:
${CLIENTS_SUMMARY}

  Next steps:

  1. Open chrome://extensions
  2. Enable "Developer mode" (top-right toggle)
  3. Click "Load unpacked" and select:
       ${LOAD_DIR}
  4. Pin the Chromanche toolbar icon (puzzle-piece menu → pin)
EOF
_pair_steps
echo

if [ "$OPENCODE_STATUS" = "manual" ]; then
  _warn "OpenCode is installed but Chromanche isn't registered with it yet: add the snippet printed above to ${OC_CFG}, or install jq and re-run this installer."
fi
if [ "$COPILOT_STATUS" = "manual" ]; then
  _warn "GitHub Copilot CLI is installed but Chromanche isn't registered with it yet: add the snippet printed above to ${GH_CFG}, or install jq and re-run this installer."
fi
case " $CLAUDE_STATUS $CODEX_STATUS $OPENCODE_STATUS $COPILOT_STATUS " in
  *" registered "*|*" manual "*) ;;
  *) _warn "No MCP client was found, so Chromanche isn't registered anywhere yet. Install Claude Code (or Codex, OpenCode, GitHub Copilot CLI), then re-run this installer." ;;
esac

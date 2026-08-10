#!/usr/bin/env bash
#
# Registers the Socrates native messaging host with Chrome.
#
#   ./bin/install-native-host.sh [extension-id]
#
# The manifest pins a public key, so the extension id is stable no matter where
# dist/ lives - the default below is that id, and you only need to pass one if
# you have changed the key. Re-run after installing dcli somewhere new.
#
# Nothing secret is written. The host manifest points Chrome at a launcher; the
# launcher runs a Node script that shells out to `dcli` and returns the key on
# stdout, in memory, once per browser session.

set -euo pipefail

HOST_NAME="com.socrates.keychain"
# Derived from the public key pinned in public/manifest.json.
DEFAULT_EXTENSION_ID="lbhnejceegeplldfheefbalbfnhdafnb"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_SCRIPT="$REPO_ROOT/dist/native-host/socrates-host.mjs"
LAUNCHER="$REPO_ROOT/dist/native-host/socrates-host"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/socrates"
CONFIG_FILE="$CONFIG_DIR/native-host.json"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

EXTENSION_ID="${1:-${SOCRATES_EXTENSION_ID:-$DEFAULT_EXTENSION_ID}}"
[[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]] || die "'$EXTENSION_ID' is not a Chrome extension id (32 letters a-p)"

[ -f "$HOST_SCRIPT" ] || die "missing $HOST_SCRIPT - run 'pnpm build' first"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on PATH"

# Chrome launches native hosts with a minimal PATH, so the launcher hard-codes
# the absolute path to node instead of relying on a shebang lookup.
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$HOST_SCRIPT" "\$@"
EOF
chmod +x "$LAUNCHER"

# --- host manifest, for every Chrome flavour installed -----------------------

case "$(uname -s)" in
  Darwin)
    TARGET_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGET_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    )
    ;;
  *)
    die "unsupported platform: $(uname -s)"
    ;;
esac

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Reads the Anthropic API key for Socrates out of Dashlane.",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

INSTALLED=0
for dir in "${TARGET_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  [ -d "$parent" ] || continue
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/$HOST_NAME.json"
  printf 'registered  %s\n' "$dir/$HOST_NAME.json"
  INSTALLED=1
done
[ "$INSTALLED" -eq 1 ] || die "no Chrome profile directory found - is Chrome installed for this user?"

# --- non-secret host config --------------------------------------------------

DCLI_BIN="$(command -v dcli || true)"
ITEM_TITLE="${SOCRATES_ITEM_TITLE:-Anthropic API Key}"
ITEM_FIELD="${SOCRATES_ITEM_FIELD:-content}"

mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_FILE" ] && [ "${SOCRATES_FORCE_CONFIG:-0}" != "1" ]; then
  printf 'keeping    %s (set SOCRATES_FORCE_CONFIG=1 to overwrite)\n' "$CONFIG_FILE"
else
  cat > "$CONFIG_FILE" <<EOF
{
  "dcliPath": "${DCLI_BIN:-/opt/homebrew/bin/dcli}",
  "itemTitle": "$ITEM_TITLE",
  "itemField": "$ITEM_FIELD"
}
EOF
  printf 'wrote      %s\n' "$CONFIG_FILE"
fi

if [ -z "$DCLI_BIN" ]; then
  printf '\nwarning: dcli is not on PATH. Install it with:\n  brew install dashlane/tap/dashlane-cli\nthen re-run this script.\n'
fi

cat <<EOF

Done. Next:
  1. Reload the extension on chrome://extensions (native host manifests are read at connect time,
     but reloading clears any cached failure).
  2. Make sure your vault has an item titled "$ITEM_TITLE" whose $ITEM_FIELD is the Anthropic API key:
       dcli read "dl://$ITEM_TITLE/$ITEM_FIELD"
  3. Open a LeetCode problem and click the Socrates icon.
EOF

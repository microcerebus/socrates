#!/usr/bin/env bash
#
# Registers the Socrates native messaging host with Chrome and Brave.
#
#   ./bin/install-native-host.sh [extension-id ...]
#
# The manifest pins a public key, so the extension id is a pure function of that
# key and is the same in every Chromium flavour. This script derives it rather
# than carrying a list, and each run states the whole allowlist: an id this run
# did not resolve is removed from the installed manifest, not kept.
# Re-run after installing or moving the claude CLI.
#
# `allowed_origins` is the host's only access control - anything listed there can
# run the user's claude CLI - so converging it is a security property, not tidying.
#
# Nothing secret is written. The host manifest points Chrome at a launcher; the
# launcher runs a Node script that streams a reply from the `claude` CLI.

set -euo pipefail

HOST_NAME="com.socrates.keychain"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_SCRIPT="$REPO_ROOT/dist/native-host/socrates-host.mjs"
LAUNCHER="$REPO_ROOT/dist/native-host/socrates-host"
MANIFEST_JSON="$REPO_ROOT/public/manifest.json"
ID_SCRIPT="$REPO_ROOT/scripts/extension-id.ts"
MANIFEST_SCRIPT="$REPO_ROOT/scripts/native-host-manifest.ts"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/socrates"
CONFIG_FILE="$CONFIG_DIR/native-host.json"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -f "$HOST_SCRIPT" ] || die "missing $HOST_SCRIPT - run 'pnpm build' first"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on PATH"

# The id comes from the key pinned in public/manifest.json, so the extension the
# host trusts and the extension Chrome loads cannot drift apart. An override is
# still accepted for an unpinned development build.
if [ "$#" -gt 0 ]; then
  EXTENSION_IDS=("$@")
elif [ -n "${SOCRATES_EXTENSION_IDS:-}" ]; then
  # shellcheck disable=SC2206  # deliberate word splitting on a space-separated list
  EXTENSION_IDS=(${SOCRATES_EXTENSION_IDS})
elif [ -n "${SOCRATES_EXTENSION_ID:-}" ]; then
  EXTENSION_IDS=("$SOCRATES_EXTENSION_ID")
else
  EXTENSION_IDS=("$("$NODE_BIN" "$ID_SCRIPT" "$MANIFEST_JSON")")
fi

for id in "${EXTENSION_IDS[@]}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || die "'$id' is not a Chrome extension id (32 letters a-p)"
done

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  die "claude is not on PATH. Install Claude Code from https://claude.com/claude-code and log in, then re-run this script."
fi

# Chrome launches native hosts with a minimal PATH, so the launcher hard-codes
# the absolute path to node instead of relying on a shebang lookup.
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$HOST_SCRIPT" "\$@"
EOF
chmod +x "$LAUNCHER"

# --- host manifest, for every Chromium flavour installed ---------------------

case "$(uname -s)" in
  Darwin)
    TARGET_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGET_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    )
    ;;
  *)
    die "unsupported platform: $(uname -s)"
    ;;
esac

# Written by scripts/native-host-manifest.ts, which states the whole allowlist
# and reports whatever it withdrew. See that file for why it replaces rather
# than merges.
write_manifest() {
  "$NODE_BIN" "$MANIFEST_SCRIPT" "$1" "$HOST_NAME" "$LAUNCHER" "${EXTENSION_IDS[@]}"
}

INSTALLED=0
for dir in "${TARGET_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  [ -d "$parent" ] || continue
  mkdir -p "$dir"
  origins="$(write_manifest "$dir/$HOST_NAME.json")"
  printf 'registered  %s (%s)\n' "$dir/$HOST_NAME.json" "$origins"
  INSTALLED=1
done
[ "$INSTALLED" -eq 1 ] || die "no Chrome or Brave profile directory found - is one installed for this user?"

# --- non-secret host config --------------------------------------------------
#
# claudePath is always refreshed to the binary this run just resolved, even on
# a rerun: `claude install` and Homebrew both relocate the binary, and a rerun
# whose whole point is picking up that move must not leave the stale path
# behind. Any other field a user has hand-added to the config is preserved -
# only claudePath is ours to overwrite.

mkdir -p "$CONFIG_DIR"
"$NODE_BIN" - "$CONFIG_FILE" "$CLAUDE_BIN" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, claudePath] = process.argv.slice(2);

let config = {};
try {
  const previous = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof previous === 'object' && previous !== null) config = previous;
} catch {
  /* no config yet, or an unreadable one we are about to replace */
}

config.claudePath = claudePath;
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE
printf 'wrote      %s (claudePath: %s)\n' "$CONFIG_FILE" "$CLAUDE_BIN"

cat <<EOF

Done. Next:
  1. Reload the extension on chrome://extensions (native host manifests are read at connect time,
     but reloading clears any cached failure).
  2. Open a LeetCode problem and click the Socrates icon.

Hints run on your own Claude Code login:
  $CLAUDE_BIN auth status
EOF

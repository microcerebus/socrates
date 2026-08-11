#!/usr/bin/env bash
#
# Registers the Socrates native messaging host with Chrome and Brave.
#
#   ./bin/install-native-host.sh [extension-id ...]
#
# The manifest pins a public key, so the extension id is stable no matter where
# dist/ lives. Both known ids are registered by default, and re-running merges
# rather than clobbers: any id already present in an installed manifest is kept.
# Re-run after installing or moving the claude CLI.
#
# Nothing secret is written. The host manifest points Chrome at a launcher; the
# launcher runs a Node script that streams a reply from the `claude` CLI.

set -euo pipefail

HOST_NAME="com.socrates.keychain"
# Derived from the public key pinned in public/manifest.json. Chrome and Brave
# have each been seen to hand this build a different id, so both are registered.
DEFAULT_EXTENSION_IDS=(
  "lbhnejceegeplldfheefbalbfnhdafnb"
  "aplbkajcnpggamonmlebeaenjhhnjpdp"
)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_SCRIPT="$REPO_ROOT/dist/native-host/socrates-host.mjs"
LAUNCHER="$REPO_ROOT/dist/native-host/socrates-host"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/socrates"
CONFIG_FILE="$CONFIG_DIR/native-host.json"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  EXTENSION_IDS=("$@")
elif [ -n "${SOCRATES_EXTENSION_IDS:-}" ]; then
  # shellcheck disable=SC2206  # deliberate word splitting on a space-separated list
  EXTENSION_IDS=(${SOCRATES_EXTENSION_IDS})
elif [ -n "${SOCRATES_EXTENSION_ID:-}" ]; then
  EXTENSION_IDS=("$SOCRATES_EXTENSION_ID")
else
  EXTENSION_IDS=("${DEFAULT_EXTENSION_IDS[@]}")
fi

for id in "${EXTENSION_IDS[@]}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || die "'$id' is not a Chrome extension id (32 letters a-p)"
done

[ -f "$HOST_SCRIPT" ] || die "missing $HOST_SCRIPT - run 'pnpm build' first"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on PATH"

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

# Written by node rather than a heredoc so an existing manifest's allowed_origins
# can be read and merged: registering one browser must not deregister another.
write_manifest() {
  "$NODE_BIN" - "$1" "$HOST_NAME" "$LAUNCHER" "${EXTENSION_IDS[@]}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, hostName, launcher, ...ids] = process.argv.slice(2);

let existing = [];
try {
  const previous = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(previous.allowed_origins)) existing = previous.allowed_origins;
} catch {
  /* no manifest yet, or an unreadable one we are about to replace */
}

const wanted = ids.map((id) => `chrome-extension://${id}/`);
const allowed_origins = [...new Set([...existing, ...wanted])];

writeFileSync(
  file,
  `${JSON.stringify(
    {
      name: hostName,
      description: 'Runs the Claude Code CLI for Socrates, headlessly.',
      path: launcher,
      type: 'stdio',
      allowed_origins,
    },
    null,
    2,
  )}\n`,
);
console.log(`${allowed_origins.length} origin(s)`);
NODE
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

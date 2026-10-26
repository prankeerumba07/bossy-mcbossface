#!/bin/sh
# Starts the Work Manager hook with Node.js, wherever Node is installed.
# If Node cannot be found it does nothing, so Claude is never blocked.
dir=$(dirname "$0")
for n in "$WM_NODE" "$(command -v node 2>/dev/null)" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
  if [ -n "$n" ] && [ -x "$n" ]; then exec "$n" "$dir/hook.mjs" "$@"; fi
done
for n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
  if [ -x "$n" ]; then exec "$n" "$dir/hook.mjs" "$@"; fi
done
cat >/dev/null
exit 0

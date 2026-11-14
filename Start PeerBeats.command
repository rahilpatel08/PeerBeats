#!/bin/bash
# PeerBeats. Double-click this file in Finder to set up and start everything.
# It opens the Lab page, which has every role: listener, contributors, monitor and phones.
# Phones anywhere join through the phone link it starts, so this computer needs internet.

cd "$(dirname "$0")" || exit 1

STAGE="All 5 stages"

pause_and_exit() {
  echo
  read -r -n 1 -s -p "Press any key to close this window."
  echo
  exit "${1:-1}"
}

echo
echo "  PeerBeats - $STAGE"
echo

# A double-clicked script does not load your shell setup, so look for Node ourselves.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt 20 ] && [ -d "$NVM_DIR/versions/node" ]; then
  newest=$(ls "$NVM_DIR/versions/node" | sort -V | tail -1)
  [ -n "$newest" ] && export PATH="$NVM_DIR/versions/node/$newest/bin:$PATH"
fi

if [ "$(node_major)" -lt 20 ]; then
  echo "  PeerBeats needs Node.js 20 or newer, and it was not found."
  echo "  Install it from https://nodejs.org, then double-click this file again."
  pause_and_exit 1
fi
echo "  [ok] Node $(node -v)"

# Custom icons can be lost when a folder is zipped or copied, so put it back if needed.
if [ -f assets/icon.png ] && ! xattr -p com.apple.FinderInfo "$0" >/dev/null 2>&1; then
  osascript -l JavaScript -e 'ObjC.import("AppKit");function run(a){var i=$.NSImage.alloc.initWithContentsOfFile(a[0]);$.NSWorkspace.sharedWorkspace.setIconForFileOptions(i,a[1],0)}' "$PWD/assets/icon.png" "$PWD/$(basename "$0")" >/dev/null 2>&1
fi

if [ ! -f .env ]; then
  secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed "s/^JWT_SECRET=.*/JWT_SECRET=$secret/" .env.example > .env
  echo "  [ok] Created .env with a fresh random secret"
fi
# This file holds secrets, so only the owner of this Mac account may read it.
chmod 600 .env

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "  [..] Installing dependencies (first run only, needs internet)"
  if ! npm install --no-audit --no-fund --loglevel=error; then
    echo "  Installing failed. Check your internet connection and try again."
    pause_and_exit 1
  fi
fi
echo "  [ok] Dependencies ready"

if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html -newer web/dist/index.html -print -quit)" ]; then
  echo "  [..] Building the web app"
  if ! npm run --silent build >/dev/null; then
    echo "  The web app failed to build. Run 'npm run build' here to see why."
    pause_and_exit 1
  fi
fi
echo "  [ok] Web app built"

PORT=$(sed -n 's/^PORT=//p' .env | head -1)
PORT=${PORT:-4173}

# An older PeerBeats still running would hold the database. Stop it, and leave anything else alone.
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  if curl -fsS --max-time 2 "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"app":"peerbeats"'; then
    echo "  [..] Stopping the PeerBeats server that was already running"
    old_pids=$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN)
    kill $old_pids 2>/dev/null
    # Wait for the process itself to exit, because it releases the database last.
    for _ in $(seq 1 20); do
      kill -0 $old_pids 2>/dev/null || break
      sleep 0.5
    done
    break
  fi
  echo "  [..] Port $PORT is used by another app, trying $((PORT + 1))"
  PORT=$((PORT + 1))
done
export PORT

if [ ! -f data/.seeded ] || [ ! -d storage/origin ]; then
  echo "  [..] Generating 20 original tracks (first run only, about 2 minutes)"
fi
if ! npm run --silent seed; then
  echo "  Setting up the music catalog failed. The message above says why."
  pause_and_exit 1
fi
touch data/.seeded
echo "  [ok] Catalog ready"

URL="http://localhost:$PORT/lab"
HEALTH="http://localhost:$PORT/api/health"
if [ -z "$PEERBEATS_NO_OPEN" ]; then
  (
    for _ in $(seq 1 60); do
      if curl -fsS --max-time 1 "$HEALTH" >/dev/null 2>&1; then
        open "$URL"
        exit 0
      fi
      sleep 0.5
    done
  ) &
fi

echo
if [ -n "$PEERBEATS_FROM_APP" ]; then
  echo "  Lab page: $URL"
else
  echo "  Your browser will open the Lab page at $URL"
  echo "  Keep this window open while you use PeerBeats. Press Ctrl+C here to stop."
fi
echo
npm run --silent start
status=$?
[ "$status" -ne 0 ] && [ "$status" -ne 130 ] && pause_and_exit "$status"
exit 0

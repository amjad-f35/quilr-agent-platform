#!/bin/sh
set -e

# Optionally clone a repo into REPO_DIR so the agent has a working tree.
if [ -n "$REPO_URL" ] && [ ! -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] cloning $REPO_URL into $REPO_DIR"
  mkdir -p "$REPO_DIR"

  # The vault sidecar binds HTTPS_PROXY on 127.0.0.1:14322 in parallel
  # with this entrypoint. If we hit git clone before vault is up we get
  # "Couldn't connect to server" and the container exits. Poll briefly
  # for vault's /healthz before attempting the clone.
  if [ -n "$HTTPS_PROXY" ]; then
    proxy_host="${HTTPS_PROXY#http://}"
    proxy_host="${proxy_host#https://}"
    proxy_host="${proxy_host%/}"
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS --max-time 1 "http://${proxy_host}/healthz" >/dev/null 2>&1; then
        echo "[entrypoint] vault reachable"
        break
      fi
      sleep 1
    done
  fi

  # Best-effort: a failed clone shouldn't kill the harness. The terminal
  # still renders, and the user can clone manually inside the session.
  if ! git clone --depth=1 ${REPO_BRANCH:+--branch "$REPO_BRANCH"} "$REPO_URL" "$REPO_DIR"; then
    echo "[entrypoint] WARNING: git clone failed; continuing without repo"
  fi
fi

exec node /app/server.js

#!/usr/bin/env bash
# litellm-status — one-line JSON health of the proxy, for an agent to check first.
#   {"status":"ready|provisioning|down|oom","port":N|null,"error":"..."}
# Call this before doing UI work; if status != "ready", run `litellm-up`.
set -uo pipefail

LOGDIR=/tmp/llmlogs
PORT=""
[ -f "$LOGDIR/current_port" ] && PORT="$(cat "$LOGDIR/current_port" 2>/dev/null)"

proc_up() { pgrep -f "litellm.proxy.proxy_cli" >/dev/null 2>&1; }

ready() {
  [ -n "$PORT" ] || return 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health/readiness" 2>/dev/null)" = "200" ]
}

emit() { # status, port, error
  python3 - "$1" "${2:-}" "${3:-}" <<'PY'
import json,sys
status,port,err=sys.argv[1],sys.argv[2],sys.argv[3]
print(json.dumps({"status":status,"port":int(port) if port else None,"error":err or None}))
PY
}

if ready; then
  emit ready "$PORT" ""
elif proc_up; then
  emit provisioning "$PORT" "proxy process is up but /health/readiness != 200 yet"
else
  # Process is gone — was it OOM-killed?
  oom="$(dmesg 2>/dev/null | grep -iE 'oom|killed process' | tail -1)"
  log=""
  [ -n "$PORT" ] && [ -f "$LOGDIR/proxy.${PORT}.log" ] && log="$(tail -3 "$LOGDIR/proxy.${PORT}.log" 2>/dev/null | tr '\n' ' ')"
  if [ -n "$oom" ]; then
    emit oom "" "$oom"
  else
    emit down "" "${log:-no proxy running; run litellm-up}"
  fi
fi

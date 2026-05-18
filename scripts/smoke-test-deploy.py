#!/usr/bin/env python3
"""
Post-deploy smoke test. Run after kubectl rollout status succeeds.

Required env vars:
  MASTER_KEY   Platform master key (GitHub Actions secret).
  ALB_URL      Base URL of the platform ALB, e.g. http://abc.us-east-1.elb.amazonaws.com
               (GitHub Actions variable: vars.ALB_URL).

Exit 0 on pass, 1 on failure.
"""
import os
import socket
import ssl
import sys
import time
import urllib.request

MASTER_KEY = os.environ["MASTER_KEY"]
ALB_URL = os.environ["ALB_URL"].rstrip("/")

# Derive host and port from ALB_URL (http or https).
if ALB_URL.startswith("https://"):
    host = ALB_URL[len("https://"):]
    port = 443
else:
    host = ALB_URL[len("http://"):]
    port = 80
if ":" in host:
    host, port_str = host.rsplit(":", 1)
    port = int(port_str)

failures = []


def check(label: str, ok: bool, detail: str = "") -> None:
    status = "✓" if ok else "✗"
    print(f"{status} {label}" + (f": {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def retry(fn, label: str, timeout: int = 120, interval: int = 10):
    """Retry fn() until it returns (ok=True, detail) or timeout expires."""
    deadline = time.time() + timeout
    last_detail = ""
    attempt = 0
    while time.time() < deadline:
        ok, detail = fn()
        last_detail = detail
        if ok:
            return True, detail
        attempt += 1
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        wait = min(interval, remaining)
        print(f"  [{label}] attempt {attempt}: {detail} — retrying in {int(wait)}s")
        time.sleep(wait)
    return False, last_detail


# ── 1. Platform health + auth (Authorization header, never in URL) ────────────

def health_check():
    try:
        req = urllib.request.Request(
            f"{ALB_URL}/api/v1/health/k8s",
            headers={"Authorization": f"Bearer {MASTER_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            code = resp.getcode()
        return code == 200, f"got {code}"
    except Exception as e:
        return False, str(e)


ok, detail = retry(health_check, "GET /api/v1/health/k8s → 200")
check("GET /api/v1/health/k8s → 200", ok, detail)


# ── 2. TTY proxy rejects invalid token with 401 ───────────────────────────────
FAKE_SESSION = "00000000-0000-0000-0000-000000000000"


def tty_ws_status(token: str) -> str:
    """Send a WebSocket upgrade to the TTY proxy; return the HTTP status line."""
    raw = socket.socket()
    raw.settimeout(10)
    try:
        raw.connect((host, port))
        s = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if port == 443 else raw
        path = f"/api/v1/managed_agents/sessions/{FAKE_SESSION}/tty?token={token}"
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        s.sendall(req.encode())
        return s.recv(256).decode(errors="replace").split("\r\n")[0]
    finally:
        raw.close()


def tty_check():
    try:
        r = tty_ws_status("intentionally-wrong-token-xyzzy")
        return "401" in r, r
    except Exception as e:
        return False, str(e)


ok, detail = retry(tty_check, "TTY bad token → 401")
check("TTY bad token → 401", ok, detail)


# ── Result ────────────────────────────────────────────────────────────────────
if failures:
    print(f"\nFAILED: {failures}", file=sys.stderr)
    sys.exit(1)

print("\nAll smoke tests passed.")

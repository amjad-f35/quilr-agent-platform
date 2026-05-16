#!/usr/bin/env node
// lap — LiteLLM Agent Platform CLI
//
// Usage:
//   lap <agent-name>                open the agent's TUI in a sandbox
//   lap --agent <name>              same as above (flag form)
//   lap agents                      list agents on the platform
//   lap login                       set base URL + master key (one-time)
//   lap config                      show current config
//   lap logout                      delete config
//
// Install:
//   npm install -g @berriai/lap-cli
//
// First run: prompts for the agent platform URL + master key. Saved to
// ~/.lap/config.json (chmod 0600).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WebSocket } from "ws";

const CONFIG = path.join(os.homedir(), ".lap", "config.json");

// Optional fallback when the platform returns an in-cluster sandbox_url
// the local laptop can't reach AND doesn't provide session.tty_url
// (older platforms before the WS proxy landed). New platforms expose
// session.tty_url and the CLI prefers it automatically.
const TTY_FALLBACK = process.env.LAP_TTY_FALLBACK ?? "";

const PKG_VERSION = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "?";
  } catch { return "?"; }
})();

// ANSI helpers used by the banner, picker, and command output.
const ansi = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  blueBold: s => `\x1b[1;94m${s}\x1b[0m`,
};

function renderBanner() {
  const cfg = loadConfig();
  const where = cfg?.base ?? "(not configured)";
  const { blueBold: b, bold, dim } = ansi;
  // Bright-white pixel-art-style face glyphs over a blue body.
  const w = s => `\x1b[1;97m${s}\x1b[0m`;
  // Side-profile chibi bullet-train sprite (4 lines) above the wordmarks.
  // Curved nose on the left (▄▀…), single white `•` "eye" on the front
  // where the driver's windscreen would be, dim `▭` windows along the
  // body, two pairs of `▀▀` wheels under the chassis. ~22 cols wide,
  // centered over the 56-col LITELLM band → 19 leading spaces. Below:
  // ANSI-shaded "LITELLM" block-letter wordmark + smaller 2-row
  // "AGENT PLATFORM" wordmark in the same bright blue. Full banner is
  // ~13 lines — only shown on `lap` (wizard) and `lap login`, not on
  // fast paths like `lap <name>`.
  const sp = " ".repeat(19);
  const lines = [
    "",
    `${sp}${b("     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄")}`,
    `${sp}${b("   ▄▀")} ${w("•")} ${dim("▭ ▭ ▭ ▭ ▭")} ${b("█")}`,
    `${sp}${b("   █████████████████████")}`,
    `${sp}${b("     ▀▀          ▀▀")}`,
    "",
    `  ${b("██╗     ██╗████████╗███████╗██╗     ██╗     ███╗   ███╗")}`,
    `  ${b("██║     ██║╚══██╔══╝██╔════╝██║     ██║     ████╗ ████║")}`,
    `  ${b("██║     ██║   ██║   █████╗  ██║     ██║     ██╔████╔██║")}`,
    `  ${b("██║     ██║   ██║   ██╔══╝  ██║     ██║     ██║╚██╔╝██║")}`,
    `  ${b("███████╗██║   ██║   ███████╗███████╗███████╗██║ ╚═╝ ██║")}`,
    `  ${b("╚══════╝╚═╝   ╚═╝   ╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝")}`,
    "",
    `  ${b("▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀   █▀█ █   ▄▀█ ▀█▀ █▀▀ █▀█ █▀█ █▄ ▄█")}`,
    `  ${b("█▀█ █▄█ █▄▄ █ ▀█  █    █▀▀ █▄▄ █▀█  █  █▀  █▄█ █▀▄ █ ▀ █")}`,
    "",
    `              ${dim(`lap-cli v${PKG_VERSION}  ${where}`)}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// Arrow-key picker over `items`. `render(item, isHighlighted)` returns the
// row body (no trailing newline). Returns the chosen item, or null on Esc /
// Ctrl-C / q. Single-item lists are returned without prompting.
function pickFromList(items, render) {
  if (items.length === 0) return Promise.resolve(null);
  if (items.length === 1) return Promise.resolve(items[0]);
  let cur = 0;
  const draw = () => {
    for (let i = 0; i < items.length; i++) {
      const marker = i === cur ? ansi.cyan("▶ ") : "  ";
      process.stdout.write(marker + render(items[i], i === cur) + "\n");
    }
  };
  const erase = () => {
    readline.moveCursor(process.stdout, 0, -items.length);
    for (let i = 0; i < items.length; i++) {
      readline.clearLine(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);
    }
    readline.moveCursor(process.stdout, 0, -items.length);
  };
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.off("keypress", onKey);
      process.stdin.pause();
    };
    const onKey = (_, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        cur = (cur - 1 + items.length) % items.length; erase(); draw();
      } else if (key.name === "down" || key.name === "j") {
        cur = (cur + 1) % items.length; erase(); draw();
      } else if (key.name === "return") {
        cleanup(); resolve(items[cur]);
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup(); resolve(null);
      }
    };
    process.stdin.on("keypress", onKey);
    draw();
  });
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return null; }
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  try { fs.chmodSync(CONFIG, 0o600); } catch {}
}

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // mute keystroke echo while we read the line; restore after.
      const onKey = () => {
        readline.moveCursor(process.stdout, -rl.line.length - prompt.length, 0);
        readline.clearLine(process.stdout, 1);
        process.stdout.write(prompt + "•".repeat(rl.line.length));
      };
      process.stdin.on("keypress", onKey);
      rl.once("close", () => process.stdin.off("keypress", onKey));
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function login({ banner = true } = {}) {
  if (banner) renderBanner();
  process.stdout.write("  \x1b[1mSet up the agent platform\x1b[0m\n");
  process.stdout.write("  \x1b[2mSaved to ~/.lap/config.json (chmod 0600)\x1b[0m\n\n");
  const base = (await ask("  Agent platform URL: ")).trim().replace(/\/+$/, "");
  const key  = (await ask("  Master key:         ", { hidden: true })).trim();
  if (!base || !key) { console.error("  \x1b[31maborted\x1b[0m"); process.exit(1); }
  saveConfig({ base, key });
  console.log(`  \x1b[32m✓ saved to ${CONFIG}\x1b[0m\n`);
  return { base, key };
}

// Backend exposes `supports_tui` (derived from TUI_HARNESSES). Fall back to
// a client-side allowlist when the field is missing so a fresh CLI still
// works against a platform that hasn't shipped the field yet.
const CLIENT_TUI_HARNESSES = new Set(["claude-code", "codex"]);
function isTuiAgent(a) {
  if (typeof a.supports_tui === "boolean") return a.supports_tui;
  return CLIENT_TUI_HARNESSES.has(a.harness_id);
}

async function openAgent(args) {
  // Accept `lap <name>`, `lap --agent <name>`, or `lap` (prompts).
  // The agent's harness_id determines what CLI runs inside the sandbox
  // (claude-code, codex, …) — the user doesn't need to say.
  const flagIdx = args.indexOf("--agent");
  let wanted = "";
  if (flagIdx >= 0) {
    wanted = args[flagIdx + 1] ?? "";
  } else {
    const positional = args.find(a => !a.startsWith("-"));
    if (positional) wanted = positional;
  }
  if (!wanted) {
    console.error("  usage: lap <agent-name>  (or `lap --agent <name>`)");
    console.error("  list:  lap agents");
    process.exit(2);
  }

  let cfg = loadConfig();
  if (!cfg) {
    console.log("\n  \x1b[33mNo agent platform configured.\x1b[0m");
    cfg = await login();
  }

  // Resolve agent: accept either a UUID or a name.
  let agentId;
  if (/^[0-9a-f-]{36}$/i.test(wanted)) {
    agentId = wanted;
  } else {
    process.stdout.write(`  \x1b[2m→ resolving agent '${wanted}'…\x1b[0m`);
    try {
      const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
        headers: { "authorization": `Bearer ${cfg.key}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const { data } = await r.json();
      const hit = data.find(a => a.name === wanted);
      if (!hit) {
        console.error(`\n  \x1b[31m✗ no agent named '${wanted}'.\x1b[0m`);
        console.error(`  \x1b[2mavailable: ${data.slice(0, 8).map(a => a.name).join(", ")}${data.length > 8 ? ` (+${data.length - 8} more)` : ""}\x1b[0m`);
        process.exit(1);
      }
      agentId = hit.id;
      console.log(`\r  \x1b[32m✓\x1b[0m agent \x1b[36m${hit.name}\x1b[0m \x1b[2m(${agentId.slice(0,8)}, harness=${hit.harness_id})\x1b[0m`);
    } catch (e) {
      console.error(`\n  \x1b[31m✗ agent lookup failed: ${e.message}\x1b[0m`);
      process.exit(1);
    }
  }

  process.stdout.write(`  \x1b[2m→ POST .../agents/${agentId.slice(0,8)}…/session\x1b[0m\n`);
  let sid;
  try {
    const res = await fetch(`${cfg.base}/api/v1/managed_agents/agents/${agentId}/session`, {
      method: "POST",
      headers: { "authorization": `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "lap-cli" }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    ({ id: sid } = await res.json());
  } catch (e) {
    console.error(`  \x1b[31m✗ session create failed: ${e.message}\x1b[0m`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m session \x1b[36m${sid.slice(0,8)}\x1b[0m`);

  process.stdout.write("  \x1b[2mwaiting for sandbox\x1b[0m");
  let session = null;
  // Network blips shouldn't abort the poll, but server-side errors (401,
  // 4xx auth, 5xx outage) should surface fast. We tolerate up to two
  // consecutive failures and then bail with the upstream status so the
  // user isn't waiting out the full 60-iteration timeout to see a 401.
  let consecutiveFailures = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1500));
    let r;
    try {
      r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
        headers: { "authorization": `Bearer ${cfg.key}` },
      });
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.error(`\n  \x1b[31m✗ session poll failed: ${e.message}\x1b[0m`);
        process.exit(1);
      }
      process.stdout.write("?");
      continue;
    }
    if (!r.ok) {
      // Auth errors are terminal — re-polling won't fix a wrong master key.
      if (r.status === 401 || r.status === 403) {
        console.error(`\n  \x1b[31m✗ session poll: ${r.status} ${r.statusText} (master key invalid?)\x1b[0m`);
        process.exit(1);
      }
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        const body = await r.text().catch(() => "");
        console.error(`\n  \x1b[31m✗ session poll: ${r.status} ${r.statusText} ${body.slice(0, 120)}\x1b[0m`);
        process.exit(1);
      }
      process.stdout.write("?");
      continue;
    }
    consecutiveFailures = 0;
    session = await r.json().catch(() => null);
    process.stdout.write(".");
    if (session?.status === "ready") break;
    if (session?.status === "failed" || session?.status === "dead") {
      console.error(`\n  \x1b[31m✗ ${session.status}: ${session.failure_reason ?? ""}\x1b[0m`);
      process.exit(1);
    }
  }
  if (session?.status !== "ready") {
    console.error("\n  \x1b[31m✗ timed out waiting for ready\x1b[0m");
    process.exit(1);
  }
  process.stdout.write(" \x1b[32mready\x1b[0m\n");

  const resolved = resolveWsTarget(session, cfg);
  if (!resolved) process.exit(1);
  console.log(`  \x1b[2m→ attaching local TTY to ${resolved.wsUrl}\x1b[0m`);
  console.log("  \x1b[2m(press Ctrl-D to detach)\x1b[0m\n");

  await attachPty(resolved.wsUrl, resolved.ttyToken);
}

// Decide the WebSocket URL + bearer for a given session row, in priority
// order: platform-served tty_url (preferred — reachable over the same
// public ingress as the rest of the API), direct sandbox_url+/tty (older
// platforms / local dev where the sandbox port is exposed), then the
// LAP_TTY_FALLBACK env override. Returns null after printing an error if
// nothing usable is available; the caller decides whether to exit.
function resolveWsTarget(session, cfg) {
  let wsUrl;
  if (session.tty_url) {
    if (/^wss?:\/\//.test(session.tty_url)) {
      wsUrl = session.tty_url;
    } else if (/^https?:\/\//.test(session.tty_url)) {
      wsUrl = session.tty_url.replace(/^http/, "ws");
    } else {
      const baseWs = cfg.base.replace(/^http/, "ws").replace(/\/+$/, "");
      const suffix = session.tty_url.startsWith("/") ? session.tty_url : `/${session.tty_url}`;
      wsUrl = baseWs + suffix;
    }
  } else if (session.sandbox_url && !session.sandbox_url.includes(".svc.cluster.local")) {
    wsUrl = session.sandbox_url.replace(/^http/, "ws").replace(/\/+$/, "") + "/tty";
  } else if (TTY_FALLBACK) {
    wsUrl = TTY_FALLBACK;
    console.log(`  \x1b[2m(sandbox_url is in-cluster — using LAP_TTY_FALLBACK)\x1b[0m`);
  } else {
    if (session.sandbox_url) {
      console.error(`  \x1b[31m✗ session.sandbox_url is in-cluster (${session.sandbox_url}) and the platform did not return a tty_url.\x1b[0m`);
    } else {
      console.error(`  \x1b[31m✗ platform returned neither tty_url nor a reachable sandbox_url.\x1b[0m`);
    }
    console.error(`  \x1b[2m  upgrade the platform, or set LAP_TTY_FALLBACK=ws://host:port/tty in your env\x1b[0m`);
    return null;
  }
  // The harness's verifyClient requires the bearer token; the platform
  // returns it via session.tty_token (preferred) or via LAP_TTY_TOKEN env.
  const ttyToken = session.tty_token || process.env.LAP_TTY_TOKEN || "";
  return { wsUrl, ttyToken };
}

function attachPty(wsUrl, ttyToken) {
  return new Promise((resolve, reject) => {
    // Send the token both as `?token=` and as an Authorization header. AWS
    // ALB / Classic ELB silently strip custom request headers (including
    // Authorization) on WebSocket upgrade requests, so a header-only auth
    // gets a 401 from behind those load balancers — verified against the
    // production EKS ELB ingress, where the header form was rejected but
    // `?token=` succeeded with HTTP 101. The harness and server-proxy.mjs
    // both already accept either form, so sending both is safe and works
    // whether the path goes through an ALB or not.
    const urlWithToken = ttyToken
      ? `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(ttyToken)}`
      : wsUrl;
    const headers = ttyToken ? { authorization: `Bearer ${ttyToken}` } : undefined;
    const ws = new WebSocket(urlWithToken, { headers });
    // Default binaryType ("nodebuffer") yields Buffer in the message event,
    // which process.stdout.write accepts directly. Setting "arraybuffer"
    // would crash on every binary PTY frame because stdout.write rejects
    // ArrayBuffer.

    ws.on("open", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      ws.send(JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || 100,
        rows: process.stdout.rows || 30,
      }));

      process.stdin.on("data", (data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Ctrl-D detaches the local CLI; the remote process stays alive.
        if (data.length === 1 && data[0] === 0x04) { ws.close(); return; }
        ws.send(data);
      });

      process.stdout.on("resize", () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "resize",
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }));
      });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || data instanceof Buffer) process.stdout.write(data);
      else process.stdout.write(typeof data === "string" ? data : Buffer.from(data));
    });

    ws.on("close", () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      console.log("\n  \x1b[2m[connection closed]\x1b[0m");
      resolve();
      process.exit(0);
    });

    ws.on("error", (err) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      console.error(`\n  \x1b[31m✗ ws error: ${err.message}\x1b[0m`);
      reject(err);
      process.exit(1);
    });
  });
}

function help() {
  console.log(`
  \x1b[1mlap\x1b[0m — LiteLLM Agent Platform CLI

  \x1b[2mUSAGE\x1b[0m
    lap                             interactive wizard (login + agent picker)
    lap <agent-name>                open the agent's TUI in a fresh sandbox
    lap --agent <name>              same as above (flag form)
    lap agents                      list agents on the platform ([tui] = compatible)
    lap sessions                    list active sessions you can reattach to
    lap reattach <id>               reattach to an active session (8-char prefix OK)
    lap login                       set base URL + master key (one-time)
    lap config                      show current config
    lap logout                      delete config

  \x1b[2mEXAMPLE\x1b[0m
    lap                             # first run — banner, login, pick
    lap refactor-bot                # fast path once you know the name
    lap sessions                    # list what's alive (after Ctrl-D, etc.)
    lap reattach 5a5953cd           # hop back into a specific session

  Config:  ${CONFIG}
`);
}

// Short human-readable age like "3m" or "2h" or "1d". The platform's
// sessions list is sorted newest-first, so most rows render as minutes.
function shortAge(iso) {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// `lap sessions` — list active sessions the user can reattach to.
// The platform keeps detached sessions alive for ~24h, so the same row
// can be reattached repeatedly after Ctrl-D. We hide dead/failed/stopped
// rows because they can't be reattached.
async function sessionsCmd() {
  const cfg = loadConfig();
  if (!cfg) { console.error("  (no config — run `lap login`)"); process.exit(1); }
  const [sR, aR] = await Promise.all([
    fetch(`${cfg.base}/api/v1/managed_agents/sessions?limit=50`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    }),
    fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    }),
  ]);
  if (!sR.ok) { console.error(`  ✗ sessions: ${sR.status} ${sR.statusText}`); process.exit(1); }
  if (!aR.ok) { console.error(`  ✗ agents: ${aR.status} ${aR.statusText}`); process.exit(1); }
  const sessions = await sR.json();
  const { data: agents } = await aR.json();
  const byAgent = new Map(agents.map(a => [a.id, a]));
  const live = sessions.filter(s => s.status === "ready" || s.status === "creating");
  if (live.length === 0) {
    console.log(`  ${ansi.dim("no active sessions. open one with `lap <agent-name>`.")}`);
    return;
  }
  for (const s of live) {
    const id = s.id.slice(0, 8);
    const agent = byAgent.get(s.agent_id);
    const name = (agent?.name ?? "<unknown>").padEnd(28);
    const status = s.status === "ready" ? ansi.cyan("ready  ") : ansi.yellow("creating");
    const age = `started ${shortAge(s.created_at)} ago`;
    const last = s.last_seen_at ? `, last activity ${shortAge(s.last_seen_at)} ago` : "";
    console.log(`  ${ansi.bold(id)}  ${name} ${status}  ${ansi.dim(age + last)}`);
  }
  console.log(`\n  ${ansi.dim("reattach with: `lap reattach <id>` (8-char prefix works)")}`);
}

// `lap reattach <id-or-prefix>` — pull the session row, hand off to
// attachPty. Skip the POST-create + readiness poll path entirely so a
// user who Ctrl-D'd out can hop back into the exact same harness PTY,
// scrollback and all.
async function reattachCmd(rawId) {
  if (!rawId) {
    console.error("  usage: lap reattach <session-id>  (8-char prefix accepted)");
    console.error("  list:  lap sessions");
    process.exit(2);
  }
  const cfg = loadConfig();
  if (!cfg) { console.error("  (no config — run `lap login`)"); process.exit(1); }
  // Resolve prefix → full id by listing if needed. Full UUIDs (36 chars
  // with hyphens) skip the list call.
  let sessionId = rawId;
  if (rawId.length < 36) {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions?limit=200`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    if (!r.ok) { console.error(`  ✗ list: ${r.status} ${r.statusText}`); process.exit(1); }
    const sessions = await r.json();
    const matches = sessions.filter(s => s.id.startsWith(rawId));
    if (matches.length === 0) {
      console.error(`  ${ansi.red(`✗ no session matches prefix '${rawId}'.`)}  ${ansi.dim("run `lap sessions`")}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`  ${ansi.red(`✗ prefix '${rawId}' is ambiguous`)} (${matches.length} matches). use a longer prefix.`);
      process.exit(1);
    }
    sessionId = matches[0].id;
  }
  const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${cfg.key}` },
  });
  if (!r.ok) { console.error(`  ${ansi.red(`✗ session ${sessionId}: ${r.status} ${r.statusText}`)}`); process.exit(1); }
  const session = await r.json();
  if (session.status !== "ready") {
    console.error(`  ${ansi.red(`✗ session is ${session.status}, cannot reattach.`)}  ${ansi.dim("only `ready` sessions are reattachable.")}`);
    process.exit(1);
  }
  const resolved = resolveWsTarget(session, cfg);
  if (!resolved) process.exit(1);
  console.log(`  ${ansi.green("✓")} reattaching to ${ansi.cyan(sessionId.slice(0, 8))}  ${ansi.dim(`→ ${resolved.wsUrl}`)}`);
  console.log(`  ${ansi.dim("(press Ctrl-D to detach again — session stays alive 24h)")}\n`);
  await attachPty(resolved.wsUrl, resolved.ttyToken);
}

async function agentsCmd() {
  const cfg = loadConfig();
  if (!cfg) { console.error("  (no config — run `lap login`)"); process.exit(1); }
  const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
    headers: { "authorization": `Bearer ${cfg.key}` },
  });
  if (!r.ok) { console.error(`  ✗ ${r.status} ${r.statusText}`); process.exit(1); }
  const { data } = await r.json();
  for (const a of data) {
    const name = (a.name ?? "<unnamed>").padEnd(28);
    const harness = (a.harness_id ?? "?").padEnd(20);
    const tag = isTuiAgent(a) ? ansi.cyan("[tui]") : ansi.dim("     ");
    console.log(`  ${name} \x1b[2m${harness}\x1b[0m ${tag} \x1b[2m${a.id.slice(0,8)}\x1b[0m`);
  }
}

// `lap` with no args: banner → ensure login → pick a TUI-compatible agent
// → hand off to openAgent. The picker filters to `supports_tui` because the
// CLI can only attach to PTY-exposing harnesses; non-TUI agents would just
// fail at WS-connect time with a confusing message.
async function wizard() {
  renderBanner();
  let cfg = loadConfig();
  if (!cfg) {
    process.stdout.write(`  ${ansi.yellow("No agent platform configured — let's set one up.")}\n\n`);
    cfg = await login({ banner: false });
  }
  process.stdout.write(`  ${ansi.dim("→ fetching agents…")}\n`);
  let agents;
  try {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    ({ data: agents } = await r.json());
  } catch (e) {
    console.error(`  ${ansi.red(`✗ agent list failed: ${e.message}`)}`);
    process.exit(1);
  }
  const tui = agents.filter(isTuiAgent);
  if (tui.length === 0) {
    console.error(`  ${ansi.red("✗ no TUI-compatible agents on this platform.")}`);
    console.error(`  ${ansi.dim(`TUI requires harness ${[...CLIENT_TUI_HARNESSES].join(" or ")} — visit ${cfg.base}/agents to create one.`)}`);
    process.exit(1);
  }
  // Reposition above the "fetching agents…" line so the picker draws cleanly.
  readline.moveCursor(process.stdout, 0, -1);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`  ${ansi.bold("Pick an agent")}  ${ansi.dim("↑/↓ to move, Enter to open, q to cancel")}\n\n`);
  const picked = await pickFromList(tui, (a) => {
    const name = (a.name ?? "<unnamed>").padEnd(28);
    return `${name} ${ansi.dim(`${a.harness_id ?? "?"}  ${a.id.slice(0, 8)}`)}`;
  });
  if (!picked) { console.log(`  ${ansi.dim("cancelled.")}`); process.exit(0); }
  process.stdout.write("\n");
  await openAgent([picked.name]);
}

async function main() {
  const [, , ...args] = process.argv;
  const cmd = args[0];
  // Subcommands are reserved keywords. Anything else is treated as an agent
  // name shorthand for `lap --agent <name>`.
  switch (cmd) {
    case undefined: await wizard(); break;
    case "-h":
    case "--help":
    case "help":   help(); break;
    case "login":  await login(); break;
    case "agents": await agentsCmd(); break;
    case "sessions": await sessionsCmd(); break;
    case "reattach": await reattachCmd(args[1]); break;
    case "config": {
      const c = loadConfig();
      if (!c) console.log("  (no config — run `lap login`)");
      else console.log(JSON.stringify({ ...c, key: c.key.slice(0,4) + "…" + c.key.slice(-4) }, null, 2));
      break;
    }
    case "logout": try { fs.rmSync(CONFIG, { force: true }); console.log("  logged out"); } catch {} break;
    default: await openAgent(args);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

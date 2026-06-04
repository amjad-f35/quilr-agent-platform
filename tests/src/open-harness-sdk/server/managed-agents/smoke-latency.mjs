// Latency smoke test: measures wall-clock time for each harness at multiple
// checkpoints and prints a comparison table.
//
//   export LITELLM_API_BASE="https://gateway.litellm-sandbox.ai"
//   export LITELLM_API_KEY="<gateway key>"
//   node tests/src/open-harness-sdk/server/managed-agents/smoke-latency.mjs
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createState, createApp } from "../../../../../src/open-harness-sdk/server/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESSES = ["claude-code", "codex"];
const PROMPT = "Reply with exactly one word: hello";

if (!process.env.LITELLM_API_KEY) {
  console.error("LITELLM_API_KEY not set — aborting");
  process.exit(1);
}

function openSseCollect(port, path) {
  const events = [];
  const timestamps = [];
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const parts = buf.split("\n");
        buf = parts.pop();
        for (const line of parts) {
          if (!line.startsWith("data: ")) continue;
          const j = line.slice(6).trim();
          if (!j) continue;
          try {
            const parsed = JSON.parse(j);
            events.push(parsed);
            timestamps.push(Date.now());
          } catch { /* partial */ }
        }
      });
      res.on("end", () => resolve({ events, timestamps }));
    });
    req.on("error", () => resolve({ events, timestamps }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(200);
  }
  return false;
}

async function runHarness(base, port, agent) {
  const timings = { agent };

  // T0: session create
  const tCreate = Date.now();
  const cr = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (cr.status !== 201) throw new Error(`[${agent}] create failed: ${cr.status}`);
  const { id } = await cr.json();
  timings.t_session_create_ms = Date.now() - tCreate;

  // Subscribe to SSE stream
  const events = [];
  const eventTs = [];
  const sseReq = http.get({ host: "127.0.0.1", port, path: `/v1/sessions/${id}/events/stream` }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("data: ")) continue;
        const j = line.slice(6).trim();
        if (!j) continue;
        try {
          events.push(JSON.parse(j));
          eventTs.push(Date.now());
        } catch { /* partial */ }
      }
    });
  });
  sseReq.on("error", () => {});
  await sleep(100);

  // Send message
  const tSend = Date.now();
  const send = await fetch(`${base}/v1/sessions/${id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text: PROMPT }] }],
    }),
  });
  if (send.status !== 200) throw new Error(`[${agent}] send failed: ${send.status}`);
  timings.t_send_ms = Date.now() - tSend;

  // Wait for first event after send
  const nEventsBefore = events.length;
  const gotFirst = await waitFor(() => events.length > nEventsBefore, 90000);
  timings.t_first_event_ms = gotFirst ? eventTs[nEventsBefore] - tSend : null;
  timings.first_event_type = gotFirst ? events[nEventsBefore]?.type : "TIMEOUT";

  // Wait for settle
  const settled = await waitFor(
    () => events.some((e) => e.type === "session.status_idle" || e.type === "session.status_error"),
    90000,
  );
  const idleIdx = events.findIndex((e) => e.type === "session.status_idle" || e.type === "session.status_error");
  timings.t_to_idle_ms = settled && idleIdx >= 0 ? eventTs[idleIdx] - tSend : null;
  timings.settled_event = settled && idleIdx >= 0 ? events[idleIdx]?.type : "TIMEOUT";
  timings.event_count = events.length;

  // Extract assistant text
  timings.response_text = events
    .filter((e) => e.type === "agent.message")
    .flatMap((m) => (m.content || []).map((b) => b.text || ""))
    .join("")
    .slice(0, 80);

  sseReq.destroy();
  await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });

  return timings;
}

function printTable(results) {
  console.log("\n=== LATENCY COMPARISON ===\n");
  const cols = ["agent", "t_session_create_ms", "t_first_event_ms", "t_to_idle_ms", "event_count", "first_event_type", "response_text"];
  const widths = cols.map((c) => Math.max(c.length, ...results.map((r) => String(r[c] ?? "ERR").length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  |  ");
  const sep = widths.map((w) => "-".repeat(w)).join("--+--");
  console.log(header);
  console.log(sep);
  for (const r of results) {
    console.log(cols.map((c, i) => String(r[c] ?? "ERR").padEnd(widths[i])).join("  |  "));
  }

  // Delta summary
  if (results.length === 2) {
    const [a, b] = results;
    console.log("\n=== DELTA (codex vs claude-code) ===");
    for (const k of ["t_session_create_ms", "t_first_event_ms", "t_to_idle_ms"]) {
      if (a[k] != null && b[k] != null) {
        const codexVal = results.find((r) => r.agent === "codex")?.[k];
        const claudeVal = results.find((r) => r.agent === "claude-code")?.[k];
        if (codexVal != null && claudeVal != null) {
          const diff = codexVal - claudeVal;
          const pct = ((diff / claudeVal) * 100).toFixed(1);
          console.log(`  ${k}: codex=${codexVal}ms  claude-code=${claudeVal}ms  diff=${diff > 0 ? "+" : ""}${diff}ms (${pct}%)`);
        }
      }
    }
  }
  console.log("");
}

async function main() {
  const serverPath = resolve(__dirname, "../../../../../src/open-harness-sdk/server/server.mjs");
  const ctx = createState({ serverPath, env: process.env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Server on port ${port}`);

  const results = [];
  try {
    for (const harness of HARNESSES) {
      console.log(`\nRunning harness: ${harness} ...`);
      try {
        const t = await runHarness(base, port, harness);
        results.push(t);
        console.log(`  done: ttff=${t.t_first_event_ms}ms  idle=${t.t_to_idle_ms}ms`);
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        results.push({ agent: harness, error: err.message });
      }
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }

  printTable(results);
}

main().catch((err) => { console.error(err); process.exit(1); });

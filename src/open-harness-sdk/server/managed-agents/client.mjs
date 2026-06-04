// client.mjs — thin async helpers for the managed-agents HTTP server.
// No deps beyond Node's built-in `http` module (Node 18+).
// Pass `baseUrl` (e.g. "http://localhost:4096") as the first arg to every helper.

import http from "node:http";

// ── internal ──────────────────────────────────────────────────────────────────

async function request(baseUrl, method, path, body) {
  const url = new URL(path, baseUrl);
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method,
      headers: {
        "content-type": "application/json",
        ...(payload != null ? { "content-length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (res.statusCode >= 400) {
          const msg = data?.error?.message ?? text;
          reject(Object.assign(new Error(`${method} ${path} → ${res.statusCode}: ${msg}`), { status: res.statusCode, data }));
        } else {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ── exports ───────────────────────────────────────────────────────────────────

/**
 * List available harness IDs.
 * @param {string} baseUrl
 * @returns {Promise<Array<{ id: string }>>}
 */
export async function listHarnesses(baseUrl) {
  const res = await request(baseUrl, "GET", "/v1/harnesses");
  return res.data;
}

/**
 * Create a session.
 * @param {string} baseUrl
 * @param {{ agent: string, model?: string }} options
 * @returns {Promise<object>} session object (includes `id`)
 */
export async function createSession(baseUrl, { agent, model } = {}) {
  return request(baseUrl, "POST", "/v1/sessions", { agent, model });
}

/**
 * Get session status.
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function getSession(baseUrl, sessionId) {
  return request(baseUrl, "GET", `/v1/sessions/${sessionId}`);
}

/**
 * Delete (and kill) a session.
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function deleteSession(baseUrl, sessionId) {
  return request(baseUrl, "DELETE", `/v1/sessions/${sessionId}`);
}

/**
 * Send a user message to a session (fire-and-forget).
 * @param {string} baseUrl
 * @param {string} sessionId
 * @param {string | Array<{type:string,text:string}>} content
 * @returns {Promise<{ ok: boolean }>}
 */
export async function sendMessage(baseUrl, sessionId, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return request(baseUrl, "POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: blocks }],
  });
}

/**
 * List all events for a session (snapshot).
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function listEvents(baseUrl, sessionId) {
  const res = await request(baseUrl, "GET", `/v1/sessions/${sessionId}/events`);
  return res.data;
}

/**
 * Async-iterate SSE events from a session. Replays history then streams live.
 * Terminates after a `session.status_idle` or `session.status_error` event.
 *
 * NOTE: Node's global `fetch` (undici) buffers text/event-stream — use this
 * helper or `node:http` directly instead.
 *
 * @param {string} baseUrl
 * @param {string} sessionId
 * @yields {object} parsed event objects
 */
export async function* streamEvents(baseUrl, sessionId) {
  const url = new URL(`/v1/sessions/${sessionId}/events/stream`, baseUrl);
  const events = [];
  let notify = null;
  let done = false;

  const req = http.get({ hostname: url.hostname, port: url.port || 80, path: url.pathname }, (res) => {
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
          if (notify) { notify(); notify = null; }
        } catch { /* partial frame */ }
      }
    });
    res.on("end", () => { done = true; if (notify) { notify(); notify = null; } });
  });
  req.on("error", () => { done = true; if (notify) { notify(); notify = null; } });

  while (true) {
    while (events.length > 0) {
      const ev = events.shift();
      yield ev;
      if (ev.type === "session.status_idle" || ev.type === "session.status_error") {
        req.destroy();
        return;
      }
    }
    if (done) return;
    await new Promise((r) => { notify = r; });
  }
}

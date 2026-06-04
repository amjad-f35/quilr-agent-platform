# Managed Agents Server (V0)

A zero-dependency Node HTTP server that exposes the lite-harness agents
(Claude Code, Codex, Pi AI) behind the **Claude Managed Agents** wire format.
Apps built against `api.anthropic.com/v1` sessions work against this server.

It is a thin bridge: each session spawns the existing `../server.mjs` subprocess
(stdio NDJSON) and translates its frames to managed-agents HTTP events.

## Layout

```
core.mjs      ids, event factories, HTTP error/response helpers
store.mjs     in-memory session records + event history with SSE pub/sub
runtime.mjs   harness resolution, frame translation, per-session subprocess
routes.mjs    the seven request handlers
index.mjs     state wiring + HTTP router + entry point
client.mjs    thin async client helpers (listHarnesses, createSession, …)
```

Tests live at the repo root, mirroring this path:
`tests/src/open-harness-sdk/server/managed-agents/`.

## Endpoints (V0)

```
GET    /v1/harnesses                      list available harness IDs
POST   /v1/sessions                       create session (spawns a harness subprocess)
GET    /v1/sessions/:id                   get session
DELETE /v1/sessions/:id                   destroy session (kills subprocess)
POST   /v1/sessions/:id/events            send a user message (fire-and-forget, 200)
GET    /v1/sessions/:id/events            event history
GET    /v1/sessions/:id/events/stream     live SSE event stream
```

```bash
curl http://localhost:4096/v1/harnesses
# {"object":"list","data":[{"id":"claude-code"},{"id":"codex"},{"id":"pi-ai"}]}
```

## SDK helper (client.mjs)

`client.mjs` exports thin async helpers — no hand-rolled `fetch`:

```js
import {
  listHarnesses, createSession, sendMessage, streamEvents, deleteSession,
} from "./src/open-harness-sdk/server/managed-agents/client.mjs";

const harnesses = await listHarnesses("http://localhost:4096");
// → [{ id: "claude-code" }, { id: "codex" }, { id: "pi-ai" }]

const session = await createSession("http://localhost:4096", { agent: "claude-code" });
await sendMessage("http://localhost:4096", session.id, "say hello");
for await (const event of streamEvents("http://localhost:4096", session.id)) {
  console.log(event.type, event);
}
await deleteSession("http://localhost:4096", session.id);
```

## Run the server

```bash
export LITELLM_API_BASE="https://gateway.litellm-sandbox.ai"
export LITELLM_API_KEY="<gateway key>"
node src/open-harness-sdk/server/managed-agents/index.mjs   # listens on :4096
```

Example:

```bash
BASE=http://localhost:4096
ID=$(curl -s -XPOST $BASE/v1/sessions -d '{"agent":"claude-code"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -N $BASE/v1/sessions/$ID/events/stream &          # open stream
curl -s -XPOST $BASE/v1/sessions/$ID/events \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"hello"}]}]}'
```

## Tests

Two tiers:

Tests live at `tests/src/open-harness-sdk/server/managed-agents/` (repo root).

**Offline (deterministic, no network/key/SDK):** spawns a fake harness.

```bash
T=tests/src/open-harness-sdk/server/managed-agents
node --test $T/frame-translator.test.mjs $T/bridge-e2e.test.mjs
```

**Live (real harnesses through the LiteLLM gateway):** skips unless
`LITELLM_API_KEY` is set.

```bash
export LITELLM_API_BASE="https://gateway.litellm-sandbox.ai"
export LITELLM_API_KEY="<gateway key>"
node --test tests/src/open-harness-sdk/server/managed-agents/smoke-harnesses.test.mjs
```

## Design notes

- **One subprocess per session.** Spawned lazily on `POST /v1/sessions`.
- **Fire-and-forget.** `POST /events` writes to the subprocess and returns 200;
  output streams back over SSE / lands in history.
- **Reader ownership.** `managed-session` runs one long-lived stdout reader that
  translates frames and publishes to the event store — POST never blocks on a turn.
- **Per-session turn lock.** Concurrent `POST /events` are serialized so writes to
  the subprocess never interleave.
- **In-memory state.** Sessions + event history live in memory; restart clears them.
- **SSE clients:** use `curl -N` or `node:http`. Node's global `fetch` (undici)
  buffers `text/event-stream` bodies and is unsuitable for live SSE consumption.

/**
 * Memory tool spec — used by every harness adapter.
 *
 * Exposes the agent-facing `save_memory` and `search_memory` tools as two
 * pieces:
 *
 *   1. Input schemas (zod) + natural-language descriptions for the LLM.
 *   2. Handler functions that call back into the LAP HTTP API.
 *
 * What's NOT here: the harness-specific tool-registration glue. The Claude
 * Agent SDK harness wraps these with `createSdkMcpServer({ tools: [...] })`;
 * opencode will wrap them with whatever its tool API is. Both adapters
 * stay short — see harnesses/claude-agent-sdk/src/memory-tools.ts.
 *
 * Env contract (read at tool-call time, not at module load):
 *
 *   LAP_BASE_URL       base URL of the platform (e.g. https://lap.example.com)
 *   AGENT_ID           which agent's memory we operate on
 *   LAP_ACCESS_TOKEN   short-lived (~15min) bearer for /api/v1/managed_agents/*
 *   LAP_REFRESH_TOKEN  long-lived (~pod lifetime) — used only when the
 *                      access token returns 401, swapped at /agent-auth/refresh
 *
 * Both tokens arrive in env as vault stubs (`stub_…`). The vault sidecar
 * swaps them for the real values at egress. After a refresh round-trip,
 * the fresh access token is a real value held in this module's in-process
 * cache — the agent (model) never sees either form.
 *
 * If any of the four env vars are missing, `memoryEnv()` returns null and
 * the adapter is expected to skip registering the tools — harness boots
 * cleanly without memory, the LLM simply doesn't see those tool names.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface MemoryEnv {
  base_url: string;
  agent_id: string;
  /** Initial bearer at module load — vault stub at first, swapped to a real,
   *  freshly-minted access token after the first refresh-on-401. */
  access_token: string;
  /** Long-lived bearer for /agent-auth/refresh. Vault stub in env; swapped
   *  on the wire to its real value when sent in the refresh body. */
  refresh_token: string;
}

export interface MemoryEnvStatus {
  env: MemoryEnv | null;
  missing: string[];
}

// Resolve the memory tool env without logging — exposes the missing-var list
// so callers (memoryEnv, /api/health/memory) can decide how to surface it.
export function memoryEnvStatus(): MemoryEnvStatus {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  // Backward-compat with old pods that still have only LAP_AUTH_TOKEN set:
  // treat it as the access token and run without refresh. New pods get
  // both LAP_ACCESS_TOKEN and LAP_REFRESH_TOKEN.
  const access_token =
    process.env.LAP_ACCESS_TOKEN ?? process.env.LAP_AUTH_TOKEN ?? "";
  // Refresh token is OPTIONAL — its absence only means the harness can't
  // recover from an access-token 401 (degraded mode). We don't add it to
  // `missing` because the tools still register and work for the access
  // token's lifetime. The refresh-on-401 path no-ops cleanly if absent.
  const refresh_token = process.env.LAP_REFRESH_TOKEN ?? "";
  const missing: string[] = [];
  if (!base_url) missing.push("LAP_BASE_URL");
  if (!agent_id) missing.push("AGENT_ID");
  if (!access_token) missing.push("LAP_ACCESS_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return {
    env: { base_url, agent_id, access_token, refresh_token },
    missing: [],
  };
}

// Warn-once guard so repeated harness calls don't spam logs. Set per-process;
// the warning fires once per boot when the env is incomplete.
let memoryEnvWarnedOnce = false;

export function memoryEnv(): MemoryEnv | null {
  const status = memoryEnvStatus();
  if (status.env) return status.env;
  if (!memoryEnvWarnedOnce) {
    memoryEnvWarnedOnce = true;
    // Loud because the previous behavior was silent — a missing LAP_BASE_URL
    // in prod made memory tools invisible to every agent with no log signal.
    console.warn(
      `[memory] disabled — missing env: ${status.missing.join(", ")}. ` +
        `save_memory/search_memory will NOT be registered. ` +
        `Fix: set the listed vars on the harness pod's container env.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input schemas (zod raw shapes — harness adapters convert as needed)
// ---------------------------------------------------------------------------

export const saveMemorySchema = {
  text: z
    .string()
    .min(1)
    .describe(
      "The lesson, phrased generically. One rule per call. Markdown OK.",
    ),
  tags: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      "1-4 short kebab-case labels for grouping/filtering (e.g. ui, antd, pr, security).",
    ),
  type: z
    .enum(["convention", "constraint", "reference", "preference"])
    .optional()
    .describe(
      "convention=how things are done; constraint=hard rule; reference=pointer to docs; preference=soft style.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Higher = surfaces first in pre-load and search. Default 0."),
  pinned: z
    .boolean()
    .optional()
    .describe(
      "Always-on: when true, this memory is unconditionally included in the AGENT_PROMPT pre-load on every future session, independent of the priority/usage ranking. Use sparingly — reserve for rules the agent absolutely cannot afford to miss (security constraints, hard requirements the user emphasized with 'always' / 'never'). Defaults to false.",
    ),
} as const;

export const searchMemorySchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Substring filter (case-insensitive) on memory text. Omit to list all.",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Restrict to memories that include this tag (e.g. 'ui', 'security').",
    ),
} as const;

export type SaveMemoryInput = {
  text: string;
  tags?: string[];
  type?: "convention" | "constraint" | "reference" | "preference";
  priority?: number;
  pinned?: boolean;
};

export type SearchMemoryInput = {
  query?: string;
  tag?: string;
};

// ---------------------------------------------------------------------------
// Natural-language descriptions (read by the LLM)
// ---------------------------------------------------------------------------

export const saveMemoryDescription = [
  "Save a durable lesson the user has just taught you, so it applies to",
  "every future run of this agent. Use when the user gives generalizable",
  "feedback ('next time', 'always', 'never', 'going forward', or",
  "explicitly types 'remember:'). Phrase the lesson generically — for",
  "future tasks, not for this PR specifically.",
].join(" ");

export const searchMemoryDescription = [
  "Search this agent's active memory for relevant lessons. MANDATORY",
  "checkpoint before you finalize and file a PR — build a query from what",
  "you actually changed (files, features, components) and read each",
  "returned memory. If your work violates one, fix the violation before",
  "filing. Optional mid-task when making a stylistic decision.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape — adapters re-pack into their harness's expected format
// ---------------------------------------------------------------------------

export interface MemoryToolResult {
  isError: boolean;
  text: string; // human/LLM-readable result body
}

// ---------------------------------------------------------------------------
// Secret scrubbing
//
// Memory is durable: whatever the agent writes here is persisted forever and
// re-loaded into every future session's prompt. If a secret leaks into a
// "lesson" (e.g. the agent pastes a curl command with a real token), it must
// never reach the store. scrubSecrets() runs on the memory body in
// callSaveMemory before it's sent over the wire.
//
// Design: conservative-but-correct. We over-redact a real secret rather than
// risk persisting it, but we deliberately do NOT touch plain IDs (UUIDs,
// short alphanumeric server_ids) — those are useful and not sensitive. The
// generic high-entropy fallback is therefore scoped to >=32-char base64/hex
// runs, which UUIDs (36 chars but hyphen-segmented into <=12-char hex groups)
// don't match.
//
// NOTE: if you change these patterns, mirror them in
// harnesses/opencode/memory-mcp.mjs (that harness self-contains a copy
// because its .mjs runs under plain node with no TS build step).
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

// Each entry redacts a known secret shape. Order matters only for overlap;
// /g so every occurrence in a multi-line memory body is caught.
const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks (any label: RSA, EC, OPENSSH, PRIVATE KEY, ...).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic keys: sk-, sk-ant-, sk-proj-, etc. (token chars after sk-).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, xapp-.
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bxapp-[A-Za-z0-9-]{8,}\b/g,
  // GitHub tokens: ghp_, gho_, ghs_, ghu_, ghr_, and fine-grained github_pat_.
  /\bgh[poseur]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Render API keys.
  /\brnd_[A-Za-z0-9]{20,}\b/g,
  // E2B API keys.
  /\be2b_[A-Za-z0-9]{16,}\b/g,
  // AWS access key IDs.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens in an Authorization-style context.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Generic `name = value` / `name: value` secret assignments. Captures the
  // key portion so we keep the field name but redact the value. Matches keys
  // containing secret/password/passwd/pwd/token/api[_-]?key/access[_-]?key/
  // private[_-]?key/client[_-]?secret/auth.
  /\b([A-Za-z0-9_.-]*(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
];

// Long high-entropy fallback: a >=32-char run of base64/hex chars with no
// hyphens. Catches raw tokens that don't match a known prefix. Excludes
// hyphens so UUIDs (8-4-4-4-12) and other hyphenated IDs are preserved.
const HIGH_ENTROPY = /\b[A-Za-z0-9+/=_]{32,}\b/g;

// A bare >=32-char alnum run could in theory be a long opaque ID. To avoid
// nuking such IDs we only redact when the run shows entropy typical of a
// secret: it must contain at least one of each of lower, upper, and digit, OR
// be a long base64-looking string (contains +, /, or =). Pure-lowercase or
// pure-hex-looking runs that are all one case are left alone if they read like
// an identifier — but a mixed-case 32+ run is almost never a human ID.
function looksHighEntropy(s: string): boolean {
  if (/[+/=]/.test(s)) return true; // base64 padding/url chars -> token
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  return hasLower && hasUpper && hasDigit;
}

/**
 * Redact secrets from free text before it's persisted to durable memory.
 * Replaces every recognized secret with `[REDACTED]`. Plain IDs (UUIDs,
 * short alphanumeric IDs) are intentionally preserved.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, key) =>
      // The generic assignment pattern has a captured key group — keep the
      // key, redact the value. All other patterns redact the whole match.
      typeof key === "string" ? `${key}=${REDACTED}` : REDACTED,
    );
  }
  out = out.replace(HIGH_ENTROPY, (m) => (looksHighEntropy(m) ? REDACTED : m));
  return out;
}

// ---------------------------------------------------------------------------
// Handlers — pure async functions, harness-agnostic
// ---------------------------------------------------------------------------

export async function callSaveMemory(
  env: MemoryEnv,
  input: SaveMemoryInput,
  extra: { source_session_id?: string } = {},
): Promise<MemoryToolResult> {
  const res = await callApi(env, "POST", memoryUrl(env), {
    text: scrubSecrets(input.text),
    tags: input.tags ?? [],
    type: input.type,
    priority: input.priority,
    pinned: input.pinned,
    source: "agent",
    source_session_id: extra.source_session_id,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `save_memory failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  return {
    isError: false,
    text: `Saved memory:\n${JSON.stringify(res.data, null, 2)}`,
  };
}

export async function callSearchMemory(
  env: MemoryEnv,
  input: SearchMemoryInput,
): Promise<MemoryToolResult> {
  const qs = new URLSearchParams();
  if (input.query) qs.set("q", input.query);
  if (input.tag) qs.set("tag", input.tag);
  const res = await callApi(env, "GET", memoryUrl(env, "", qs));
  if (!res.ok) {
    return {
      isError: true,
      text: `search_memory failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) {
    return { isError: false, text: "No matching memories." };
  }
  return { isError: false, text: JSON.stringify(rows, null, 2) };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function memoryUrl(
  env: MemoryEnv,
  suffix = "",
  qs: URLSearchParams | null = null,
): string {
  const base = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/memory${suffix}`;
  return qs && qs.toString() ? `${base}?${qs.toString()}` : base;
}

// ---------------------------------------------------------------------------
// HTTP client with refresh-on-401 retry.
//
// Why a module-local cache rather than an env-var-only read each time: after
// the first refresh, the access token we use is a real value (the refresh
// endpoint returns it in plaintext over the now-trusted TLS channel). The
// vault sidecar's "swap stubs on egress" trick only works for stubs that
// were minted at pod start. So we hold the post-refresh token in memory
// and bypass env for subsequent calls.
//
// Single retry only — if even the refreshed token gets 401, something is
// wrong server-side and the agent should see an error, not loop forever.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Proxy-aware fetch.
//
// Node.js's built-in `fetch` (undici-backed) does NOT automatically honour
// HTTPS_PROXY / https_proxy environment variables. The vault sidecar is an
// HTTP CONNECT proxy at 127.0.0.1:14322 — its whole job is to swap stub
// credentials (e.g. `stub_lap_access_token_xxxx`) for real values on the
// wire. If fetch bypasses the proxy the stub lands on the LAP server as-is,
// HMAC verification fails, and every memory call returns 401.
//
// Fix: use undici's ProxyAgent when HTTPS_PROXY is set. The agent:
//   • tunnels HTTPS through the vault CONNECT proxy
//   • trusts the vault's MITM CA cert (already in NODE_EXTRA_CA_CERTS)
//   • lets vault swap the stub tokens before they reach LAP
//
// When HTTPS_PROXY is absent (local dev, vault disabled) the dispatcher is
// undefined and undici's fetch behaves identically to the global built-in.
// ---------------------------------------------------------------------------

let _proxyAgent: ProxyAgent | null | undefined; // undefined = not yet resolved

function proxyDispatcher(): ProxyAgent | undefined {
  if (_proxyAgent !== undefined) return _proxyAgent ?? undefined;
  const proxyUrl =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  _proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return _proxyAgent ?? undefined;
}

let cachedAccessToken: string | null = null;

function currentBearer(env: MemoryEnv): string {
  return cachedAccessToken ?? env.access_token;
}

async function callApi(
  env: MemoryEnv,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const firstAttempt = await rawCall(env, method, url, body, currentBearer(env));
  if (firstAttempt.status !== 401 || !env.refresh_token) {
    return firstAttempt;
  }

  // 401 path: try to refresh once, retry once.
  const refreshed = await refreshAccessToken(env);
  if (!refreshed) {
    return firstAttempt; // surface the original 401 to the agent
  }
  cachedAccessToken = refreshed;
  return rawCall(env, method, url, body, refreshed);
}

async function rawCall(
  env: MemoryEnv,
  method: "GET" | "POST",
  url: string,
  body: unknown,
  bearer: string,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(dispatcher !== undefined && { dispatcher }),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function refreshAccessToken(env: MemoryEnv): Promise<string | null> {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(
      `${env.base_url}/api/v1/agent-auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: env.refresh_token }),
        ...(dispatcher !== undefined && { dispatcher }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return typeof json.access_token === "string" && json.access_token.length > 0
      ? json.access_token
      : null;
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

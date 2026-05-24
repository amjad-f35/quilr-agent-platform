#!/usr/bin/env node
/**
 * Two modes:
 * 1. Platform delegation: SESSION_ID + LAP_BASE_URL set → calls platform API
 * 2. Direct E2B fallback: SESSION_ID missing (inline) → E2B direct + vault proxy
 */

import { Sandbox } from "e2b";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.LAP_BASE_URL;
const ENV_SESSION_ID = process.env.SESSION_ID;
const TOKEN = process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE || "base";
const VAULT_URL = process.env.VAULT_URL;
const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
const SANDBOX_TIMEOUT_MS = 900_000;
const EXECUTE_TIMEOUT_MS = 120_000;

const USE_DIRECT = !ENV_SESSION_ID;
const sandboxes = new Map();

console.error(`[sandbox-mcp] mode=${USE_DIRECT ? "direct-e2b" : "platform"} template=${E2B_TEMPLATE} vault=${VAULT_URL ? "set" : "none"}`);

const server = new Server({ name: "opencode-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "provision",
    description: "Provision a new sandbox environment. Returns a confirmation message when the sandbox is ready.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label for the sandbox — used in subsequent execute() calls as sandbox_name. Use 'main' if unsure." },
      },
      required: ["name"],
    },
  },
  {
    name: "execute",
    description: "Execute a shell command inside a provisioned sandbox. Returns the command output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Label of the provisioned sandbox" },
        cmd: { type: "string", description: "Shell command to execute" },
      },
      required: ["sandbox_name", "cmd"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from a provisioned sandbox and return its text content, so you can pull files out of the sandbox into your own workspace (no cat/base64 needed). For large files, read a slice instead.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: {
          type: "string",
          description: "Label of the provisioned sandbox to read the file from",
        },
        path: { type: "string", description: "Absolute path of the file inside the sandbox" },
        session_id: {
          type: "string",
          description: "LAP session ID — required when SESSION_ID env var is not set",
        },
      },
      required: ["sandbox_name", "path"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function buildProxyUrl() {
  if (!VAULT_URL) return null;
  if (!VAULT_PROXY_TOKEN) return VAULT_URL;
  try {
    const u = new URL(VAULT_URL);
    u.username = "x";
    u.password = VAULT_PROXY_TOKEN;
    return u.toString();
  } catch { return VAULT_URL; }
}

async function provision({ name, project_id }) {
  if (USE_DIRECT) {
    if (!E2B_API_KEY) return textResult("provision failed: E2B_API_KEY not set", true);
    const existing = sandboxes.get(name);
    if (existing) { try { await existing.kill(); } catch {} }
    try {
      const proxyUrl = buildProxyUrl();
      const sandbox = await Sandbox.create(E2B_TEMPLATE, {
        apiKey: E2B_API_KEY,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        envs: proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {},
      });
      sandboxes.set(name, sandbox);
      console.error(`[sandbox-mcp] provisioned direct: ${sandbox.sandboxId} template=${E2B_TEMPLATE}`);
      return textResult(`sandbox "${name}" ready (${sandbox.sandboxId}, template ${E2B_TEMPLATE})`);
    } catch (e) {
      return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, project_id }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.message ?? "sandbox provisioned");
  } catch (e) {
    return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function execute({ sandbox_name, cmd }) {
  if (USE_DIRECT) {
    const sandbox = sandboxes.get(sandbox_name);
    if (!sandbox) return textResult(`execute failed: no sandbox "${sandbox_name}" — call provision first`, true);
    try {
      const result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
      const out = (result.stdout ?? "") + (result.stderr ?? "");
      const code = result.exitCode ?? 0;
      return code === 0 ? textResult(out) : textResult(`${out}\n[exit ${code}]`, true);
    } catch (e) {
      const err = e && typeof e === "object" ? e : {};
      const out = (err.stdout ?? "") + (err.stderr ?? "");
      const msg = e instanceof Error ? e.message : String(e);
      return textResult(out ? `${out}\n[failed: ${msg}]` : `execute error: ${msg}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, cmd }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`execute failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.output ?? "");
  } catch (e) {
    return textResult(`execute error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

const READ_FILE_MAX_BYTES = 256 * 1024;

async function readFile({ sandbox_name, path }) {
  if (USE_DIRECT) {
    const sandbox = sandboxes.get(sandbox_name);
    if (!sandbox) return textResult(`read_file failed: no sandbox "${sandbox_name}" — call provision first`, true);
    try {
      const content = await sandbox.files.read(path);
      if (content.length > READ_FILE_MAX_BYTES)
        return textResult(`error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice or split it.`, true);
      return textResult(content);
    } catch (e) {
      return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, path }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.content ?? "");
  } catch (e) {
    return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return; cleaningUp = true;
  await Promise.all([...sandboxes.values()].map(s => s.kill().catch(() => {})));
  sandboxes.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanupAll().finally(() => process.exit(0)));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision") return provision(args ?? {});
  if (name === "execute") return execute(args ?? {});
  if (name === "read_file") return readFile(args ?? {});
  return textResult(`unknown tool: ${name}`, true);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sandbox-mcp] ready`);

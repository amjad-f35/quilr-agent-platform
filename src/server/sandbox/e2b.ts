import { Sandbox } from "e2b";

import { env } from "@/server/env";
import { decrypt } from "@/server/integrations/core/crypto";
import { deriveStub } from "./deriveStub";
import { SandboxProvider, type ProvisionParams } from "./provider";

export class E2bProvider extends SandboxProvider {
  readonly urlScheme = "e2b";

  constructor(
    private readonly apiKey: string,
    private readonly template: string,
  ) {
    super();
  }

  async create(params: ProvisionParams): Promise<string> {
    const raw =
      params.agent.env_vars &&
      typeof params.agent.env_vars === "object" &&
      !Array.isArray(params.agent.env_vars)
        ? (params.agent.env_vars as Record<string, string>)
        : {};

    // Build stub env: each agent secret becomes stub_<agentId>_<keyName>.
    // The cloud-vault derives the same stubs independently from the DB,
    // so no registration call is needed — stubs are deterministic.
    const stubEnv: Record<string, string> = {};
    for (const [key, encryptedVal] of Object.entries(raw)) {
      try {
        // Decrypt just to verify the value exists and is readable.
        // The stub (not the real value) is what goes into the sandbox.
        decrypt(encryptedVal);
        stubEnv[key] = deriveStub(params.agent.agent_id, key);
      } catch {
        // Skip keys that can't be decrypted (ENCRYPTION_KEY mismatch in dev).
      }
    }
    // Platform key — always injected, keyed off the "platform" sentinel.
    stubEnv["LITELLM_API_KEY"] = deriveStub("platform", "LITELLM_API_KEY");

    // Proxy config — only injected when cloud-vault is configured.
    // Embed token in URL so curl, Python requests, Node.js, etc. all
    // automatically send Proxy-Authorization: Basic base64(x:<token>).
    const proxyEnv: Record<string, string> = {};
    if (env.VAULT_URL && env.VAULT_PROXY_TOKEN) {
      const parsed = new URL(env.VAULT_URL);
      parsed.username = "x";
      parsed.password = env.VAULT_PROXY_TOKEN;
      const proxyWithAuth = parsed.toString();
      proxyEnv["HTTPS_PROXY"] = proxyWithAuth;
      proxyEnv["HTTP_PROXY"] = proxyWithAuth;
    } else if (env.VAULT_URL) {
      proxyEnv["HTTPS_PROXY"] = env.VAULT_URL;
      proxyEnv["HTTP_PROXY"] = env.VAULT_URL;
    }

    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 24 * 60 * 60 * 1000,
      envs: { ...stubEnv, ...proxyEnv },
    });
    return sandbox.sandboxId;
  }

  async execute(id: string, cmd: string, timeoutMs: number): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
      const result = await sandbox.commands.run(cmd, { timeoutMs });
      return (result.stdout ?? "") + (result.stderr ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("terminated") || msg.includes("doesn't exist")) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async readFile(id: string, path: string): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
      // E2B's files.read returns UTF-8 text by default.
      return await sandbox.files.read(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("terminated") || msg.includes("doesn't exist")) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async terminate(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }
}

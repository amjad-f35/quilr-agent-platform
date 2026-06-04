// Codex provider: drives the @openai/codex-sdk in-process and maps its
// ThreadEvents to the canonical wire. Routes through LiteLLM by configuring
// baseUrl (passed as --config openai_base_url to the Codex CLI) and injecting
// LITELLM_API_KEY as OPENAI_API_KEY so the CLI's model calls hit the gateway.
import { Codex } from "@openai/codex-sdk";
import { createEventTransformer } from "./transformation.mjs";

export const id = "codex";
export const aliases = ["openai-agents", "openai"];
export const harnessId = "codex";
export const displayName = "Codex";

// LiteLLM is optional. When both LITELLM_API_BASE and LITELLM_API_KEY are set,
// route the Codex CLI through the gateway. Otherwise the CLI's own OPENAI_API_KEY
// env var is used directly.
function buildCodexOptions(env) {
  if (!env.LITELLM_API_BASE || !env.LITELLM_API_KEY) return {};
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  const baseUrl = base.endsWith("/v1") ? base : `${base}/v1`;
  // Codex CLI inherits process.env; inject the gateway key as OPENAI_API_KEY so
  // model calls authenticate against LiteLLM.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.LITELLM_API_KEY;
  return { baseUrl };
}

export function createRuntime({ model, env = process.env, diagnostics = () => {} }) {
  let currentModel = model || env.LITELLM_DEFAULT_MODEL || "gpt-4o";
  let aborter = null;

  const codex = new Codex(buildCodexOptions(env));

  return {
    get model() {
      return currentModel;
    },
    setModel(next) {
      if (next) currentModel = next;
    },
    setPermissionMode() {},
    interrupt() {
      aborter?.abort();
    },
    async *runTurn({ prompt, session }) {
      aborter = new AbortController();
      const t0 = Date.now();
      process.stderr.write(`[timing][codex][${session.sessionId}] startThread begin\n`);
      const thread = codex.startThread({ model: currentModel, skipGitRepoCheck: true });
      process.stderr.write(`[timing][codex][${session.sessionId}] startThread done t=${Date.now() - t0}ms\n`);
      const tRunStreamed = Date.now();
      const { events } = await thread.runStreamed(prompt, { signal: aborter.signal });
      process.stderr.write(`[timing][codex][${session.sessionId}] runStreamed returned (stream open) t=${Date.now() - t0}ms (runStreamed_setup=${Date.now() - tRunStreamed}ms)\n`);
      const toFrames = createEventTransformer();
      let firstEvent = true;
      try {
        for await (const event of events) {
          if (firstEvent) {
            process.stderr.write(`[timing][codex][${session.sessionId}] first event type=${event.type} t=${Date.now() - t0}ms\n`);
            firstEvent = false;
          }
          for (const frame of toFrames(event, { sessionId: session.sessionId, model: currentModel })) {
            yield frame;
          }
        }
        process.stderr.write(`[timing][codex][${session.sessionId}] stream complete total_t=${Date.now() - t0}ms\n`);
      } catch (err) {
        if (aborter.signal.aborted) return; // session emits the cancelled result
        diagnostics(`codex runtime error: ${err?.message ?? err}\n`);
        throw err;
      } finally {
        aborter = null;
      }
    },
  };
}

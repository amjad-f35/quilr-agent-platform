/**
 * Linear webhook verification + parsing.
 *
 * Linear signs every webhook with HMAC-SHA256 of the raw body using the
 * signing secret configured on the OAuth app. The signature lives in the
 * `linear-signature` header as a lowercase hex digest.
 *
 * Per-agent model: the secret comes from `AgentIntegrationConfig` — the
 * dispatcher decrypts it and passes it in via `verify(... , ctx)`. No env
 * vars touched here.
 *
 * Payloads we care about: `AgentSessionEvent` with `action: "created"`
 * (delegation start) or `"prompted"` (followup comment). Everything else
 * gets translated to `{ kind: "ignore" }` so the dispatcher 204s out.
 */

import { createHmac } from "node:crypto";
import { safeEqual } from "../../core/crypto";
import type { IntegrationInstall } from "@prisma/client";
import type { IntegrationEvent, WebhookAdapter } from "../../core/types";
import { issueToPrompt } from "./prompt";

const SIGNATURE_HEADER = "linear-signature";

interface LinearAgentSession {
  id?: string;
  issue?: {
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    url?: string | null;
  } | null;
  comment?: { body?: string | null } | null;
  creator?: { name?: string | null } | null;
}

interface LinearAgentSessionEvent {
  type?: string;
  action?: string;
  organizationId?: string;
  appUserId?: string;
  agentSession?: LinearAgentSession;
  agentActivity?: { body?: string | null; userId?: string | null } | null;
}

export function buildWebhookAdapter(): WebhookAdapter {
  return {
    workspaceIdFromPayload(payload: unknown): string | null {
      const p = payload as LinearAgentSessionEvent;
      return typeof p?.organizationId === "string" ? p.organizationId : null;
    },

    verify(rawBody, headers, ctx): boolean {
      const got = headers.get(SIGNATURE_HEADER);
      if (!got) return false;
      const expected = createHmac("sha256", ctx.webhookSecret)
        .update(rawBody)
        .digest("hex");
      return safeEqual(got, expected);
    },

    parse(payload, install: IntegrationInstall): IntegrationEvent {
      const evt = payload as LinearAgentSessionEvent;
      if (evt?.type !== "AgentSessionEvent") return { kind: "ignore" };

      const externalSessionId = evt.agentSession?.id;
      if (!externalSessionId) return { kind: "ignore" };

      if (evt.action === "created") {
        // Delegation start. Linear only fires `created` on a fresh agent
        // session (user-initiated) — no self-echo concern.
        return {
          kind: "new_task",
          external_session_id: externalSessionId,
          prompt: issueToPrompt(evt.agentSession ?? {}),
          external_ref: evt.agentSession?.issue?.identifier ?? undefined,
        };
      }

      if (evt.action === "prompted") {
        const body = evt.agentActivity?.body?.trim();
        if (!body) return { kind: "ignore" };

        // Dedup self-echo: if the activity was created by our own app-user,
        // ignore it so we don't feedback-loop on the agent's own output.
        // Top-level `appUserId` is the recipient, not the source — use
        // `agentActivity.userId` (the activity's creator).
        const appUserId = (install.metadata as Record<string, unknown>)
          ?.app_user_id;
        const activityUserId = evt.agentActivity?.userId;
        if (
          typeof appUserId === "string" &&
          typeof activityUserId === "string" &&
          activityUserId === appUserId
        ) {
          return { kind: "ignore" };
        }

        return {
          kind: "followup",
          external_session_id: externalSessionId,
          body,
        };
      }

      return { kind: "ignore" };
    },
  };
}

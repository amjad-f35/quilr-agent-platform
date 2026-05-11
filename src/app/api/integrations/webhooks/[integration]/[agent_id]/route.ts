/**
 * POST /api/integrations/webhooks/{integration}/{agent_id}
 *
 * Single inbound endpoint for every integration + every agent. The path
 * carries both the medium id and the agent id so the dispatcher can resolve
 * the per-agent AgentIntegrationConfig (and its signing secret) without any
 * payload inspection.
 *
 * Each agent's OAuth app in Linear has THIS exact URL registered as its
 * webhook endpoint, including the agent_id segment.
 *
 * Auth is signature-based, not master-key-based — the dispatcher passes the
 * raw body and headers to the provider's `verify`, which HMAC-checks against
 * the config's `webhook_secret_enc`. Anything failing verification returns
 * 401.
 */

import { handleInbound } from "@/server/integrations/core/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string; agent_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { integration, agent_id } = await ctx.params;
  return handleInbound(integration, agent_id, req);
}

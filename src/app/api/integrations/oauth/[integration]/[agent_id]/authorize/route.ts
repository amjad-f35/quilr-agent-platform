/**
 * GET /api/integrations/oauth/{integration}/{agent_id}/authorize
 *
 * Kicks off the OAuth flow for a specific (agent, integration). Reads the
 * agent's saved config (must exist + be enabled), mints a CSRF state bound
 * to (agent_id, integration_id), and 302s to the provider's authorize URL.
 *
 * Auth: gated by the LAP master key. The UI triggers this by navigating to
 * `${BASE_URL}/api/integrations/oauth/linear/<agent_id>/authorize` with the
 * master key in the Authorization header — usually via a same-origin link
 * that flows through the assertAuth-checked agent page.
 */

import { assertAuth } from "@/server/auth";
import { getProvider } from "@/server/integrations/core/registry";
import { startOAuth } from "@/server/integrations/core/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string; agent_id: string }>;
}

function redirectUriFor(req: Request, integration: string, agentId: string): string {
  const base = process.env.BASE_URL ?? new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}/api/integrations/oauth/${encodeURIComponent(
    integration,
  )}/${encodeURIComponent(agentId)}/callback`;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { integration: integrationId, agent_id: agentId } = await ctx.params;
  const integration = getProvider(integrationId);
  if (!integration) {
    return new Response(
      JSON.stringify({ error: `unknown integration "${integrationId}"` }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const url = await startOAuth(integration, agentId, redirectUriFor(req, integrationId, agentId));
    // Return JSON so the dashboard fetcher (which sends the master key) can
    // read the URL and `window.location.assign` it. A browser-initiated GET
    // (no Accept: application/json) gets a 302 fallback for direct curl use.
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("application/json")) {
      return Response.json({ url });
    }
    return new Response(null, { status: 302, headers: { location: url } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * GET /api/integrations/oauth/{integration}/{agent_id}/callback
 *
 * Receives the redirect from the provider after the user authorizes. Pulls
 * `code` + `state` off the query string, hands them to `completeOAuth(...)`,
 * which exchanges + persists the install row, then redirects the operator
 * back to the agent detail page where the new connection appears.
 *
 * This route is NOT behind `assertAuth` — the OAuth provider is what's
 * calling back, and it doesn't carry our master key. CSRF protection comes
 * from the `state` value `startOAuth` minted earlier (bound to the agent_id
 * the URL also carries).
 */

import { completeOAuth } from "@/server/integrations/core/oauth";
import { getProvider } from "@/server/integrations/core/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string; agent_id: string }>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function htmlResponse(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font:14px/1.5 -apple-system,sans-serif;padding:32px;max-width:560px">` +
      `<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(title)}</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { integration: integrationId, agent_id: agentId } = await ctx.params;
  const integration = getProvider(integrationId);
  if (!integration) {
    return htmlResponse(
      404,
      "Unknown integration",
      `<p>No integration named <code>${escapeHtml(integrationId)}</code> is registered.</p>`,
    );
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      400,
      "OAuth error",
      `<p>${escapeHtml(integration.displayName)} returned an error: <code>${escapeHtml(error)}</code>.</p>` +
        `<p>You can close this tab and retry from the agent page.</p>`,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlResponse(
      400,
      "Missing OAuth params",
      `<p>Both <code>code</code> and <code>state</code> are required.</p>`,
    );
  }

  try {
    const result = await completeOAuth({ integration, code, state });
    // Bounce back to the agent page. The UI re-queries the config endpoint
    // and shows the new install (workspace_name + connected status).
    return redirectResponse(
      `/agents/${encodeURIComponent(result.agent_id)}?integration=${encodeURIComponent(
        integration.id,
      )}&connected=${encodeURIComponent(result.workspace_name)}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return htmlResponse(
      400,
      "OAuth callback failed",
      `<p>Could not complete the install: <code>${escapeHtml(message)}</code></p>`,
    );
  }
}

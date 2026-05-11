# Linear integration — setup

Lets a LAP agent be delegated to from a Linear issue. Webhook in, `agentActivityCreate` out. End-to-end happy path takes ~1.5s from delegation to the "Picking up …" thought appearing on the issue.

Each agent has its own Linear OAuth app, so multiple agents on one LAP deployment appear as distinct app-users in Linear. Credentials are stored encrypted in the DB (no env vars).

## Prerequisites

- Linear workspace where you have admin access
- A reachable HTTPS URL for this LAP deployment. Linear's edge calls the webhook URL directly.
  - **Production**: your `BASE_URL` domain
  - **Local dev**: an `ngrok` / `cloudflared` tunnel
- Two LAP env vars set (one-time, platform-wide — see `.env.example`):
  - `BASE_URL` — the public origin
  - `INTEGRATION_TOKEN_KEY` — base64-encoded 32 bytes for at-rest secret encryption

## 1. Open the agent's Integrations panel

In the LAP dashboard, open the agent → scroll to the **Integrations** card → click **Enable** on the Linear row.

The card lists the exact **Callback URL** and **Webhook URL** to paste into Linear, plus the scopes the install will request.

## 2. Create the OAuth app in Linear

Click the **"Linear's app creation page"** link from the panel (or go to **Settings → API → Applications → Create new** in Linear).

| Field | Value (copy from the LAP card) |
| --- | --- |
| Name | `<agent-name> agent` — whatever you want to appear in the Delegate picker |
| Developer URL | the `BASE_URL` of your LAP deployment |
| Callback URLs | `<BASE_URL>/api/integrations/oauth/linear/<agent_id>/callback` |
| Webhook URL | `<BASE_URL>/api/integrations/webhooks/linear/<agent_id>` |
| Webhook events | **Agent session events** (required) |

Save in Linear, then copy:
- **Client ID**
- **Client secret**
- **Webhook signing secret**

## 3. Save the credentials in LAP

Paste the three values into the panel and click **Save**. The credentials are encrypted with `INTEGRATION_TOKEN_KEY` before they hit the database.

## 4. Connect

Click **Connect to Linear**. You're redirected to Linear's authorize page (`actor=app`); after you approve, you bounce back to the agent page with a "Connected to &lt;workspace&gt;" banner. The agent now appears in Linear's Delegate picker on every issue in that workspace.

## 5. Smoke test

In Linear, open any issue → **Delegate** → pick the agent. Within ~2s a "Picking up &lt;issue-id&gt;" thought appears in the agent activity panel. The session spawn happens in the background.

## Multi-workspace

The same agent can be installed into multiple Linear workspaces. Click **Connect to Linear** again from a different Linear workspace — a new `integration_install` row is created with that workspace's `access_token`. The agent receives webhooks from every connected workspace.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `404 unknown integration` on webhook | The path doesn't match a registered provider | Check the URL — it should be `/api/integrations/webhooks/linear/<agent_id>` |
| `404 no integration configured for this agent` | No `AgentIntegrationConfig` row, or `enabled = false` | Save credentials + ensure the toggle is on |
| `401 bad signature` | `webhook_secret` mismatch | Re-paste from Linear and Save |
| `404 install not found` | OAuth never completed for this workspace | Click **Connect to Linear** |
| `204` on webhook (silent) | Event was `AppUserNotification`, not `AgentSessionEvent` | Expected for non-delegation events |
| Thought activity never appears | Check the dev log for `agentActivityCreate` errors | Usually a stale token — Disconnect + Connect again |
| OAuth says "already installed" in Linear | App was previously installed in that workspace | Linear → Settings → Applications → uninstall, then Connect again |

## Local dev quickstart

```bash
# Tunnel
ngrok http 3000
export BASE_URL=https://<your-ngrok-subdomain>.ngrok-free.dev

# One-time encryption key for at-rest secrets
export INTEGRATION_TOKEN_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

npm run dev
```

Open `http://localhost:3000/agents/<agent_id>` and follow the panel.

To iterate on the parser without re-delegating in Linear, replay a captured webhook from ngrok's inspector:

```bash
python3 <<'PY'
import json, urllib.request, base64
with urllib.request.urlopen("http://localhost:4040/api/requests/http?limit=10") as r:
    d = json.load(r)
rec = next(x for x in d["requests"]
           if "/webhooks/linear/" in x["request"]["uri"]
           and "AgentSessionEvent" in str(x["request"]["headers"].get("Linear-Event","")))
req = rec["request"]
raw = base64.b64decode(req["raw"]).decode()
body = raw.split("\r\n\r\n", 1)[1]
def H(k):
    v = req["headers"].get(k, "")
    return v[0] if isinstance(v, list) else v
r2 = urllib.request.Request(
    f"http://localhost:3000{req['uri']}",
    method="POST", data=body.encode(),
    headers={"content-type": "application/json",
             "linear-signature": H("Linear-Signature"),
             "linear-event": H("Linear-Event")})
print(urllib.request.urlopen(r2).status)
PY
```

## Where the code lives

| Path | Role |
| --- | --- |
| `src/components/integration-section.tsx` | Agent-page UI: card + credentials form + Connect button |
| `src/app/api/v1/managed_agents/agents/[agent_id]/integrations/[integration]/route.ts` | GET / PUT / DELETE config CRUD |
| `src/app/api/integrations/oauth/[integration]/[agent_id]/authorize/route.ts` | Starts OAuth (mints state, returns provider URL) |
| `src/app/api/integrations/oauth/[integration]/[agent_id]/callback/route.ts` | Finishes OAuth (exchange + upsert install + redirect to agent page) |
| `src/app/api/integrations/webhooks/[integration]/[agent_id]/route.ts` | Inbound webhook |
| `src/server/integrations/providers/linear/` | Linear adapter (OAuth, webhook verify+parse, activity post) |
| `src/server/integrations/core/dispatcher.ts` | Medium-agnostic inbound + outbound glue |

See [`../README.md`](../README.md) for the cross-provider architecture and how to add a second medium.

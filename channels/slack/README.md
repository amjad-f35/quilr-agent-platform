# Slack channel

Lets you @mention a LAP agent in Slack, or DM it, and get a reply in-thread.

The whole thing rides on LAP's existing `integrations/` framework — Slack is just another provider next to Linear. No new tables. The conversation map lives in `IntegrationSession` keyed on `slack:{team_id}:{channel_id}[:{thread_ts}]`.

## How a message flows

```
Slack @mention / DM
  └─ POST /api/integrations/webhooks/slack
       ├─ url_verification → 200 with echoed challenge
       └─ event_callback → handleInbound("slack", req)
            ├─ verify signing secret (HMAC v0)
            ├─ parse → { kind: "message", external_session_id, prompt }
            └─ handleMessage()
                 ├─ IntegrationSession exists + ready + < 24h?
                 │    yes → POST /sessions/{id}/message → forward reply
                 │    no  → POST /agents/{OPENCLAW}/session
                 │            └─ poll Session.response → forward reply
                 └─ provider.onSessionEvent(response)
                      └─ chat.postMessage in the same thread
```

## One-time Slack app setup

1. **Create the app.** Go to <https://api.slack.com/apps>, click **Create New App → From a manifest**. Pick your workspace, paste the contents of [`manifest.json`](./manifest.json). Replace `REPLACE_WITH_YOUR_HOSTNAME` with whatever hostname your LAP web container is reachable at (for local dev, an `ngrok` URL; for prod, your real domain).

2. **Grab credentials.** Under **Basic Information**:
   - Copy the **Client ID** → set as `SLACK_CLIENT_ID` in `.env`.
   - Click **Show** next to **Client Secret** → copy → set as `SLACK_CLIENT_SECRET`.
   - Click **Show** next to **Signing Secret** → copy → set as `SLACK_SIGNING_SECRET`.
   Restart the LAP web container so the integration registers (it's gated by `enabled()` checking all three env vars).

3. **Install the app into your workspace.** Visit:
   ```
   https://YOUR_LAP_HOST/api/integrations/oauth/slack/authorize?master_key=$MASTER_KEY
   ```
   Slack will redirect to a consent screen → approve → it bounces back to LAP's `oauth/slack/callback`, which creates an `IntegrationInstall` row with the encrypted bot token and the bot's `bot_user_id`.

4. **Bind the install to your OPENCLAW agent.** v1 doesn't yet have a UI toggle for this — write the row directly:
   ```sql
   INSERT INTO agent_integration_binding (binding_id, agent_id, install_id, enabled)
   VALUES (
     gen_random_uuid(),
     '<OPENCLAW_AGENT_ID>',
     (SELECT install_id FROM integration_install
       WHERE integration_id = 'slack' AND workspace_id = '<YOUR_TEAM_ID>'),
     true
   );
   ```
   Your `OPENCLAW_AGENT_ID` is whatever you named the Claude Agent SDK agent in the LAP web UI (the path will be `/agents/<that-id>`).

5. **Smoke-test.** In Slack, DM **@OPENCLAW** a question. Within ~30s you should see a reply.

## Local development

Slack must reach your dev box on HTTPS. Easiest path:

```bash
# Terminal 1: LAP web
docker compose up

# Terminal 2: ngrok tunnel to :3000
ngrok http 3000
```

Take the `https://<random>.ngrok.app` URL ngrok prints and paste it into the manifest (replacing `REPLACE_WITH_YOUR_HOSTNAME`). Repeat any time ngrok rotates the subdomain.

## What this v1 includes (and what it doesn't)

In:

- DMs (`message` events with `channel_type=im`) and @mentions (`app_mention`).
- DM conversations collapse into one LAP session per DM channel (24h TTL).
- Channel @mentions create one LAP session per thread (24h TTL).
- Self-echo dedup via `bot_user_id` stored in `IntegrationInstall.metadata`.
- HMAC-SHA256 signing-secret verify + 5-min replay window.

Out (deferred):

- Feedback CTAs / "save this as a skill" flows.
- Slash commands (`/feedback`, etc.).
- Streaming token-by-token replies — currently posts one message when the agent finishes.
- Per-workspace settings UI for selecting which agent answers (still SQL-bound).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack says "Your URL didn't respond with the value of the `challenge` parameter" | LAP isn't reachable on the URL you pasted, OR `SLACK_SIGNING_SECRET` isn't set so `enabled()` returns false → 404 |
| `401 bad signature` in logs | `SLACK_SIGNING_SECRET` doesn't match the value in Slack app Basic Information |
| `404 install not found` in logs | OAuth callback hasn't run yet; complete step 3 |
| `404 no agent bound to this install` | Skip step 4 — insert the `agent_integration_binding` row |
| Slack message arrives, no reply | Check Render/docker logs for `[integrations/dispatcher]` errors; the response polling has a 5min cap |

"use client";

/**
 * Per-agent Integrations panel.
 *
 * One row per registered medium. Each row has three visible states:
 *
 *   Not configured  → "Enable" button opens an inline form for the OAuth
 *                     app credentials (client_id, client_secret,
 *                     webhook_secret). Save → PUT config.
 *
 *   Configured, no install → "Connect to <medium>" button. Calls the
 *                     authorize endpoint, follows the returned URL
 *                     (the provider's OAuth page), comes back to the
 *                     callback route which redirects here with a query
 *                     param flagging success.
 *
 *   Connected       → Shows the workspace name + a Disconnect button.
 *                     Disconnect deletes the config (cascading to installs
 *                     and integration_sessions).
 *
 * v1 hardcodes Linear's metadata. Adding Slack/GitHub means appending to
 * `INTEGRATIONS` below; the rest of this component is medium-agnostic.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, ExternalLink, Loader2, Plug, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ApiError,
  IntegrationStatus,
  deleteIntegration,
  getIntegration,
  getIntegrationAuthorizeUrl,
  saveIntegration,
} from "@/lib/api";

interface IntegrationMeta {
  id: string;
  displayName: string;
  appCreateUrl: string;
  docsUrl: string;
  scopes: string[];
  /** Short copy shown beneath the title in the "not configured" state. */
  tagline: string;
  /** Help text shown above the credentials form. */
  setupHelp: string;
}

const INTEGRATIONS: IntegrationMeta[] = [
  {
    id: "linear",
    displayName: "Linear",
    appCreateUrl: "https://linear.app/settings/api/applications/new",
    docsUrl: "https://linear.app/developers/agents",
    scopes: ["read", "write", "app:assignable", "app:mentionable"],
    tagline:
      "Delegate Linear issues to this agent. Posts thoughts and progress back to the issue.",
    setupHelp:
      'In Linear → Settings → API → Applications → "Create new". Use the webhook URL shown below; subscribe to "Agent session events". Paste the three secrets here.',
  },
];

interface Props {
  agentId: string;
}

export function IntegrationSection({ agentId }: Props) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Integrations
      </h2>
      <div className="space-y-3">
        {INTEGRATIONS.map((meta) => (
          <IntegrationCard key={meta.id} agentId={agentId} meta={meta} />
        ))}
      </div>
    </section>
  );
}

function IntegrationCard({ agentId, meta }: { agentId: string; meta: IntegrationMeta }) {
  const searchParams = useSearchParams();
  const justConnected =
    searchParams.get("integration") === meta.id
      ? searchParams.get("connected")
      : null;

  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getIntegration(agentId, meta.id);
      setStatus(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId, meta.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(form: { client_id: string; client_secret: string; webhook_secret: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const next = await saveIntegration(agentId, meta.id, form);
      setStatus(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const url = await getIntegrationAuthorizeUrl(agentId, meta.id);
      window.location.assign(url);
      // browser navigates away; no further state changes needed.
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        `Disconnect ${meta.displayName}? This deletes the OAuth credentials and unbinds every workspace install.`,
      )
    ) {
      return;
    }
    setDisconnecting(true);
    setError(null);
    try {
      await deleteIntegration(agentId, meta.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setDisconnecting(false);
    }
  }

  const configured = status?.configured ?? false;
  const installs = status?.installs ?? [];
  const isConnected = installs.length > 0;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <Plug className="size-4 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-medium">{meta.displayName}</h3>
              {isConnected ? (
                <Badge variant="default" className="text-[10px]">
                  Connected
                </Badge>
              ) : configured ? (
                <Badge variant="secondary" className="text-[10px]">
                  Awaiting connect
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  Not enabled
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">
              {meta.tagline}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {loading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : !configured ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              Enable
            </Button>
          ) : !isConnected ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing((x) => !x)}
                disabled={submitting || connecting}
              >
                {editing ? "Cancel" : "Edit"}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleConnect()}
                disabled={connecting}
              >
                {connecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="size-3.5" />
                )}
                Connect to {meta.displayName}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing((x) => !x)}
                disabled={submitting}
              >
                {editing ? "Cancel" : "Edit credentials"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
                Disconnect
              </Button>
            </>
          )}
        </div>
      </div>

      {justConnected ? (
        <div className="mx-4 mb-3 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
          <CheckCircle2 className="size-4" />
          Connected to <strong>{justConnected}</strong>. {meta.displayName} can
          now delegate to this agent.
        </div>
      ) : null}

      {isConnected && !editing ? (
        <div className="border-t bg-muted/30 px-4 py-3 text-[13px]">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Workspaces
          </div>
          <ul className="mt-2 space-y-1">
            {installs.map((i) => (
              <li key={i.install_id} className="flex items-center gap-2">
                <CheckCircle2 className="size-3.5 text-green-600" />
                <span className="font-medium">{i.workspace_name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {i.workspace_id.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editing || (!loading && !configured) ? (
        <CredentialsForm
          meta={meta}
          webhookUrl={status?.webhook_url ?? ""}
          initialClientId={status?.client_id ?? ""}
          submitting={submitting}
          onSubmit={handleSave}
          onCancel={() => setEditing(false)}
          showCancel={configured}
        />
      ) : null}

      {error ? (
        <div className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function CredentialsForm({
  meta,
  webhookUrl,
  initialClientId,
  submitting,
  onSubmit,
  onCancel,
  showCancel,
}: {
  meta: IntegrationMeta;
  webhookUrl: string;
  initialClientId: string;
  submitting: boolean;
  onSubmit: (form: { client_id: string; client_secret: string; webhook_secret: string }) => void;
  onCancel: () => void;
  showCancel: boolean;
}) {
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  // If the parent re-renders with a new initialClientId (after a load), pick it up.
  useEffect(() => {
    setClientId(initialClientId);
  }, [initialClientId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId || !clientSecret || !webhookSecret) return;
    onSubmit({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      webhook_secret: webhookSecret.trim(),
    });
  }

  const callbackUrl = webhookUrl.replace("/webhooks/", "/oauth/").replace(/\/[^/]+$/, "") + "/callback";

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 border-t bg-muted/10 px-4 py-4 text-[13px]"
    >
      <div className="rounded-md border bg-background p-3 text-[12px] leading-relaxed">
        <p className="font-medium">Setup steps</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">
          <li>
            Open{" "}
            <a
              href={meta.appCreateUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {meta.displayName}'s app creation page
            </a>
            .
          </li>
          <li>
            Set <strong>Callback URL</strong> to:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {callbackUrl}
            </code>
          </li>
          <li>
            Set <strong>Webhook URL</strong> to:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {webhookUrl}
            </code>
          </li>
          <li>
            Subscribe to <strong>Agent session events</strong> on the webhook.
          </li>
          <li>Copy the three values into the fields below and Save.</li>
        </ol>
        <p className="mt-2 text-muted-foreground">
          Scopes auto-requested: {meta.scopes.map((s) => (
            <code key={s} className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{s}</code>
          ))}.{" "}
          <a
            href={meta.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Docs
          </a>
          .
        </p>
      </div>

      <FormField
        label="Client ID"
        value={clientId}
        onChange={setClientId}
        placeholder="e.g. 3549a47de1d4f810…"
        autoComplete="off"
      />
      <FormField
        label="Client secret"
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        placeholder={initialClientId && !clientSecret ? "Paste to rotate (stored encrypted)" : "0ed2712aeda4…"}
        autoComplete="off"
      />
      <FormField
        label="Webhook signing secret"
        value={webhookSecret}
        onChange={setWebhookSecret}
        type="password"
        placeholder="lin_wh_…"
        autoComplete="off"
      />

      <div className="flex items-center justify-end gap-2 pt-1">
        {showCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={submitting || !clientId || !clientSecret || !webhookSecret}
        >
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

function FormField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="rounded-md border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

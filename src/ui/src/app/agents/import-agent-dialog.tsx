"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RuntimeProviderLogo } from "@/components/runtime-provider-logo";
import {
  discoverProviderAgents,
  importProviderAgents,
  listRuntimeHarnesses,
  saveAgentRuntimeCredential,
  type ExternalAgent,
} from "@/lib/api";
import type { Agent, RuntimeHarness } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ImportAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (agents: Agent[]) => void;
}

type ImportStep = "connect" | "select" | "runtime";

export function ImportAgentDialog({ open, onOpenChange, onImported }: ImportAgentDialogProps) {
  const [step, setStep] = useState<ImportStep>("connect");
  const [providers, setProviders] = useState<RuntimeHarness[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialMode, setCredentialMode] = useState<"shared" | "byo">("shared");
  const [externalAgents, setExternalAgents] = useState<ExternalAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvidersLoading(true);
    listRuntimeHarnesses()
      .then((values) => {
        setProviders(values);
        const first = values[0];
        setProviderId(first?.alias ?? "");
      })
      .catch(() => {
        setProviders([]);
        setProviderId("");
      })
      .finally(() => setProvidersLoading(false));
  }, [open]);

  const selectedProvider = providers.find((provider) => provider.alias === providerId);
  const providerName = selectedProvider?.display_name ?? providerId;
  const filteredAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return externalAgents;
    return externalAgents.filter((agent) =>
      `${agent.name} ${agent.description ?? ""} ${agent.id}`.toLowerCase().includes(normalized),
    );
  }, [externalAgents, query]);
  const selectableFilteredAgents = filteredAgents.filter((agent) => !agent.imported_agent_id);
  const selectedCount = selectedIds.length;
  const runtimeCredentialNeeded =
    credentialMode === "shared" && selectedProvider ? !selectedProvider.connected : false;
  const selectedRuntimeId = selectedProvider?.api_spec ?? providerId;

  const reset = () => {
    setStep("connect");
    setEndpoint("");
    setApiKey("");
    setCredentialMode("shared");
    setExternalAgents([]);
    setSelectedIds([]);
    setQuery("");
    setImportedCount(0);
    setError(null);
  };

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) reset();
  };

  const discover = async () => {
    setLoading(true);
    setError(null);
    try {
      const discovered = await discoverProviderAgents({ providerId, endpoint, apiKey });
      setExternalAgents(discovered);
      setSelectedIds([]);
      setStep("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const importSelected = async () => {
    const selected = externalAgents.filter((agent) => selectedIds.includes(agent.id));
    if (selected.length === 0) {
      setError("Select at least one agent.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await importProviderAgents({
        providerId,
        endpoint,
        apiKey: credentialMode === "shared" ? apiKey : undefined,
        credentialMode,
        agents: selected.map((agent) => ({
          externalId: agent.id,
          name: agent.name,
          description: agent.description,
          model: agent.model,
          raw: agent.raw,
        })),
      });
      if (result.agents.length > 0) {
        onImported(result.agents);
        if (runtimeCredentialNeeded) {
          setImportedCount(result.agents.length);
          setStep("runtime");
        } else {
          close(false);
        }
        return;
      }
      if (result.skippedAgents.length > 0 && runtimeCredentialNeeded) {
        setImportedCount(0);
        setStep("runtime");
        return;
      }
      setError(
        result.skippedAgents.length > 0
          ? "Selected agents were already imported."
          : "No agents were imported.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleAgent = (id: string) => {
    const agent = externalAgents.find((value) => value.id === id);
    if (agent?.imported_agent_id) return;
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return [...current, id];
    });
  };

  const saveRuntimeCredential = async () => {
    setRuntimeSaving(true);
    setError(null);
    try {
      await saveAgentRuntimeCredential({
        runtime: selectedRuntimeId,
        apiKey,
        apiBase: endpoint,
      });
      close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRuntimeSaving(false);
    }
  };

  const primaryAction = () => {
    if (step === "connect") return discover();
    if (step === "select") return importSelected();
    return saveRuntimeCredential();
  };

  const primaryDisabled =
    step === "connect"
      ? loading || !providerId || !endpoint.trim() || !apiKey.trim()
      : step === "select"
        ? saving || selectedCount === 0
        : runtimeSaving || !selectedRuntimeId || !endpoint.trim() || !apiKey.trim();

  const primaryLabel =
    step === "connect"
      ? loading
        ? "Connecting..."
        : "Connect"
      : step === "select"
        ? saving
          ? "Importing..."
          : `Import ${selectedCount}`
        : runtimeSaving
          ? "Saving..."
          : "Use these credentials";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[94vw] sm:max-w-3xl max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle>Import agents</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-4 overflow-y-auto">
          {step === "connect" && (
            <>
              <div className="grid gap-1.5">
                <Label>Platform</Label>
                <div className="grid gap-2">
                  {providers.map((provider) => {
                    const selected = provider.alias === providerId;
                    return (
                      <button
                        key={provider.alias}
                        type="button"
                        onClick={() => setProviderId(provider.alias)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-muted/50",
                          selected && "border-ring bg-muted/60 ring-2 ring-ring/20",
                        )}
                      >
                        <RuntimeProviderLogo alias={provider.alias} apiSpec={provider.api_spec} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium leading-tight">
                            {provider.display_name}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                            {provider.alias}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {providersLoading && (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      Loading runtime providers...
                    </div>
                  )}
                  {!providersLoading && providers.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No runtime providers are available.
                    </div>
                  )}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="import-endpoint">{providerName} endpoint</Label>
                <Input
                  id="import-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://deployment.kb.us-central1.gcp.cloud.es.io"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="import-key">{providerName} API key</Label>
                <Input
                  id="import-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="API key"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Credential policy</Label>
                <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/30 p-1">
                  {[
                    { value: "shared" as const, label: "Shared key" },
                    { value: "byo" as const, label: "BYO key" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setCredentialMode(option.value)}
                      className={cn(
                        "h-8 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors",
                        credentialMode === option.value
                          ? "bg-background text-foreground shadow-sm"
                          : "hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {step === "select" && (
            <div className="grid gap-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{externalAgents.length} agents found</p>
                  <p className="text-xs text-muted-foreground">
                    Select the agents to import. Existing imports are disabled.
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setStep("connect")}>
                  Back
                </Button>
              </div>
              {runtimeCredentialNeeded && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {providerName} has no runtime credentials yet. After import, you can reuse this
                  endpoint and key for provisioning and inference.
                </div>
              )}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2 size-4 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search agents"
                    className="pl-8"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(selectableFilteredAgents.map((agent) => agent.id))}
                >
                  Select all available
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds([])}
                >
                  Clear
                </Button>
              </div>
              <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {filteredAgents.map((agent) => (
                  <label
                    key={agent.id}
                    className={cn(
                      "flex items-start gap-2 px-3 py-2 hover:bg-muted/50",
                      agent.imported_agent_id
                        ? "cursor-not-allowed bg-muted/25 opacity-70"
                        : "cursor-pointer",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedIds.includes(agent.id)}
                      disabled={Boolean(agent.imported_agent_id)}
                      onChange={() => toggleAgent(agent.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
                        {agent.imported_agent_id && (
                          <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Imported
                          </span>
                        )}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {agent.id}
                      </span>
                      {agent.description && (
                        <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                          {agent.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {filteredAgents.length === 0 && (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No agents match the search.
                  </p>
                )}
              </div>
            </div>
          )}
          {step === "runtime" && (
            <div className="grid gap-4">
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
                <p className="text-sm font-medium">
                  {importedCount > 0
                    ? `Imported ${importedCount} agent${importedCount === 1 ? "" : "s"}`
                    : "No new agents were imported"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {providerName} still needs runtime credentials before these agents can run.
                </p>
              </div>
              <div className="rounded-lg border border-border px-4 py-3">
                <p className="text-sm font-medium">Use the credential you connected with?</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Save this endpoint and API key as the default runtime credential for provisioning
                  and inference. Existing connected runtime credentials are left unchanged.
                </p>
                <div className="mt-3 grid gap-1 text-xs text-muted-foreground">
                  <span className="font-mono truncate">{endpoint}</span>
                  <span className="font-mono">{selectedRuntimeId}</span>
                </div>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="m-0 rounded-b-xl px-6 py-4">
          <Button variant="outline" onClick={() => close(false)} disabled={saving || runtimeSaving}>
            {step === "runtime" ? "Skip for now" : "Cancel"}
          </Button>
          <Button onClick={primaryAction} disabled={primaryDisabled}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

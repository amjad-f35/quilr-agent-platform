"use client";

import { useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_VAULT_USER,
  saveIntegrationKey,
  savePersonalVaultKey,
} from "@/lib/api";
import type { VaultKeyEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type StoredKeyUpdater = (updater: (entries: VaultKeyEntry[]) => VaultKeyEntry[]) => void;

interface VaultCredentialsEditorProps {
  vaultKeys: string[];
  storedKeyEntries: VaultKeyEntry[];
  vaultUserId?: string;
  disabled?: boolean;
  className?: string;
  onStoredKeyEntriesChange?: StoredKeyUpdater;
  onVaultKeysChange: (keys: string[]) => void | Promise<void>;
}

function uniqueKeys(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isValidVaultKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function VaultCredentialsEditor({
  vaultKeys,
  storedKeyEntries,
  vaultUserId = DEFAULT_VAULT_USER,
  disabled = false,
  className,
  onStoredKeyEntriesChange,
  onVaultKeysChange,
}: VaultCredentialsEditorProps) {
  const keys = useMemo(() => uniqueKeys(vaultKeys), [vaultKeys]);
  const [keyInput, setKeyInput] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [changingKeys, setChangingKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addKey = async () => {
    const key = keyInput.trim();
    if (!key || changingKeys || disabled) return;
    if (!isValidVaultKey(key)) {
      setError("Use letters, numbers, and underscores, starting with a letter or underscore.");
      return;
    }
    if (keys.includes(key)) {
      setKeyInput("");
      setError(null);
      return;
    }
    setChangingKeys(true);
    setError(null);
    try {
      await onVaultKeysChange([...keys, key]);
      setKeyInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach vault key.");
    } finally {
      setChangingKeys(false);
    }
  };

  const detachKey = async (key: string) => {
    if (changingKeys || disabled) return;
    setChangingKeys(true);
    setError(null);
    try {
      await onVaultKeysChange(keys.filter((value) => value !== key));
      setSecretValues(({ [key]: _removed, ...rest }) => rest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to detach vault key.");
    } finally {
      setChangingKeys(false);
    }
  };

  const saveValue = async (key: string) => {
    const value = secretValues[key]?.trim();
    if (!value || disabled) return;
    setSavingKey(key);
    setError(null);
    try {
      if (vaultUserId === DEFAULT_VAULT_USER) {
        await saveIntegrationKey(key, value, "personal");
      } else {
        await savePersonalVaultKey(vaultUserId, key, value);
      }
      onStoredKeyEntriesChange?.((current) => [
        ...current.filter((entry) => !(entry.key === key && entry.scope === "personal")),
        { key, scope: "personal" },
      ]);
      setSecretValues(({ [key]: _saved, ...rest }) => rest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save vault value.");
    } finally {
      setSavingKey(null);
    }
  };

  const toggleSecretVisibility = (key: string) => {
    setVisibleSecrets((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className={cn("grid gap-3 rounded-lg border border-border bg-card p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <KeyRound className="size-4 text-muted-foreground" />
            Vault Credentials
          </h2>
          <p className="text-xs text-muted-foreground">
            Attach secret names to this agent and store values in the encrypted vault.
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {keys.length} attached
        </span>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="vault-key-name">Secret name</Label>
        <div className="flex gap-2">
          <Input
            id="vault-key-name"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addKey();
              }
            }}
            placeholder="BROWSER_USE_API_KEY"
            className="font-mono text-xs"
            disabled={disabled || changingKeys}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void addKey()}
            disabled={disabled || changingKeys || !keyInput.trim()}
          >
            {changingKeys ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add Key
          </Button>
        </div>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-center">
          <KeyRound className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No vault credentials attached</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add a secret name, then save its value before starting a runtime session.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {keys.map((key) => {
            const entry = storedKeyEntries.find((item) => item.key === key);
            const isSet = !!entry;
            const isVisible = visibleSecrets.has(key);
            const saving = savingKey === key;
            return (
              <div key={key} className="grid gap-2 px-3 py-2.5 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{key}</span>
                    <Badge variant={isSet ? "secondary" : "outline"} className="text-[10px]">
                      {isSet
                        ? entry.scope === "global"
                          ? "Set Globally"
                          : "Set Personally"
                        : "No Value"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Available to Claude managed runtime sessions as an environment variable.
                  </p>
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <Input
                    type={isVisible ? "text" : "password"}
                    value={secretValues[key] ?? ""}
                    onChange={(event) =>
                      setSecretValues((current) => ({ ...current, [key]: event.target.value }))
                    }
                    placeholder={isSet ? "Update value" : "Set value"}
                    autoComplete="new-password"
                    aria-label={`Value for ${key}`}
                    className="h-8 w-full font-mono text-xs lg:w-44"
                    disabled={disabled || saving}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={isVisible ? `Hide ${key}` : `Show ${key}`}
                    title={isVisible ? `Hide ${key}` : `Show ${key}`}
                    onClick={() => toggleSecretVisibility(key)}
                    disabled={disabled}
                  >
                    {isVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => void saveValue(key)}
                    disabled={disabled || saving || !secretValues[key]?.trim()}
                  >
                    {saving && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
                    Save Value
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Detach ${key}`}
                    title={`Detach ${key}`}
                    onClick={() => void detachKey(key)}
                    disabled={disabled || changingKeys}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive" aria-live="polite">
          {error}
        </p>
      )}
    </section>
  );
}

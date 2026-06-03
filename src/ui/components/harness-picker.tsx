"use client";

import { Check, ChevronDown } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/ui/lib/utils";

export interface HarnessOption {
  id: string;
  label: string;
  description: string;
  model: string;
  logo: string;
}

export const HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's terminal coding agent.",
    model: "anthropic/claude-sonnet-4-5",
    logo: "/brands/claude-code.svg",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI for coding tasks.",
    model: "openai/gpt-5.1-codex",
    logo: "/brands/codex.svg",
  },
  {
    id: "pi-ai",
    label: "Pi AI",
    description: "Pi coding agent via LiteLLM.",
    model: "openai/gpt-4o",
    logo: "/brands/pi-ai.svg",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Open source coding agent harness.",
    model: "anthropic/claude-haiku-4-5",
    logo: "/brands/opencode.svg",
  },
];

export const DEFAULT_HARNESS_ID = "opencode";

export function getHarnessOption(id: string): HarnessOption | undefined {
  return HARNESS_OPTIONS.find((opt) => opt.id === id);
}

interface HarnessPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function HarnessPicker({ value, onChange, disabled }: HarnessPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = getHarnessOption(value) ?? HARNESS_OPTIONS[0];

  function selectHarness(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className="flex h-[58px] w-full items-center gap-3 rounded-lg border border-input bg-background/50 px-3 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
      >
        <HarnessIdentity option={selected} size="default" />
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Harness"
          className="absolute left-0 right-0 top-[calc(100%+0.375rem)] z-30 rounded-lg border border-input bg-background p-1"
        >
          {HARNESS_OPTIONS.map((opt) => {
            const active = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => selectHarness(opt.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/30",
                  active && "bg-muted/30",
                )}
              >
                <HarnessIdentity option={opt} size="picker" />
                {active ? <Check className="ml-auto size-4 shrink-0 text-foreground" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function HarnessIdentity({
  option,
  harnessId,
  model,
  size = "default",
}: {
  option?: HarnessOption;
  harnessId?: string;
  model?: string | null;
  size?: "default" | "picker" | "compact";
}) {
  const label = option?.label ?? harnessId ?? "Unknown";
  const description = option?.description ?? harnessId ?? "";
  const modelText = model ?? option?.model ?? "";
  const logoSize = size === "compact" ? "size-7" : "size-9";
  const imageSize = size === "compact" ? "size-4" : "size-5";

  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className={cn("flex shrink-0 items-center justify-center rounded-lg border bg-background/70", logoSize)}>
        {option ? <HarnessLogo option={option} className={imageSize} /> : (
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            {label.slice(0, 2)}
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className={cn(
          "block truncate font-medium text-foreground",
          size === "compact" ? "text-[12px]" : "text-[13px]",
        )}>
          {label}
        </span>
        <span className={cn(
          "block truncate text-muted-foreground",
          size === "picker" ? "text-[11px]" : "text-[10px]",
        )}>
          {size === "picker" ? description : modelText || description}
        </span>
      </span>
    </span>
  );
}

export function HarnessLogo({
  option,
  className,
}: {
  option: HarnessOption;
  className?: string;
}) {
  return (
    <Image
      src={option.logo}
      alt={`${option.label} logo`}
      width={28}
      height={28}
      className={cn(
        "shrink-0 object-contain",
        option.id === "opencode" && "dark:invert",
        className,
      )}
    />
  );
}

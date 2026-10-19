"use client";

import { Button } from "@cloudflare/kumo";
import type { WalletVM } from "@farm/ui";

// A slim horizontal strip of the currently-active wallets (quick access to the rotating active
// cohort). Click a chip to open its drawer. Chips are Kumo xs toggle Buttons — the app-wide toggle
// idiom: the open wallet's chip is variant="primary" (the network brand), the rest secondary.
export function CohortFilmstrip({ wallets, selectedId, onSelect }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
}) {
  const active = wallets.filter((w) => w.status === "active").slice(0, 200);
  if (active.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-kumo-line px-4 py-2">
      <span className="shrink-0 text-sm text-kumo-subtle">Active · {active.length}</span>
      <div className="flex gap-2 overflow-x-auto">
        {active.map((w) => {
          const sel = selectedId === w.id;
          return (
            <Button
              key={w.id}
              size="xs"
              variant={sel ? "primary" : "secondary"}
              aria-pressed={sel}
              onClick={() => onSelect(w)}
              icon={<span aria-hidden className="size-1.5 rounded-full bg-kumo-success" />}
            >
              <span className="font-mono">{w.address.value.slice(0, 6)}…</span>
              <span className={sel ? undefined : "text-kumo-subtle"}>{w.accountName.split(" ").pop()}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

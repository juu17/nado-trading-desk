"use client";

import { Button } from "@cloudflare/kumo";
import type { WalletVM } from "@farm/ui";

// One row of the strip: a labelled count + a horizontal scroll of the cohort's active wallets. Click a
// chip to open its drawer. Chips are Kumo xs toggle Buttons — the open wallet's chip is variant="primary"
// (the network brand), the rest secondary. The label is fixed-width so both rows' chips start aligned.
function FilmRow({ label, wallets, selectedId, onSelect }: {
  label: string;
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-sm text-kumo-subtle">{label} · {wallets.length}</span>
      <div className="flex gap-2 overflow-x-auto">
        {wallets.map((w) => {
          const sel = selectedId === w.id;
          return (
            <Button
              key={w.id}
              size="xs"
              variant={sel ? "primary" : "secondary"}
              aria-pressed={sel}
              onClick={() => onSelect(w)}
              // The secondary variant's ring is kumo-line (near-black @10% alpha) — too faint to read as
              // a border on a chip. Give unselected chips a clearly-visible neutral ring; the selected
              // chip keeps its primary brand ring.
              className={sel ? undefined : "ring-kumo-contrast/30"}
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

// The active-wallet strip, split into two rows by the self-cross role: Maker and Taker. Each row is a
// quick-access filmstrip of that cohort's currently-active wallets. Wallets with no cohort assigned sit
// in neither row; the strip hides entirely when neither cohort has an active wallet.
export function CohortFilmstrip({ wallets, selectedId, onSelect }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
}) {
  const active = wallets.filter((w) => w.status === "active");
  const makers = active.filter((w) => w.cohort === "maker").slice(0, 200);
  const takers = active.filter((w) => w.cohort === "taker").slice(0, 200);
  if (makers.length === 0 && takers.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-kumo-line px-4 py-2">
      <FilmRow label="Maker" wallets={makers} selectedId={selectedId} onSelect={onSelect} />
      <FilmRow label="Taker" wallets={takers} selectedId={selectedId} onSelect={onSelect} />
    </div>
  );
}

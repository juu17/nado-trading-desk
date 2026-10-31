"use client";

import { Button } from "@cloudflare/kumo";
import type { WalletVM } from "@farm/ui";
import { useAutomationProgress } from "../lib/automationProgress";

// One row of the strip: a labelled count + a horizontal scroll of the cohort's active wallets. Click a
// chip to open its drawer. Chips are Kumo xs toggle Buttons — the open wallet's chip is variant="primary"
// (the network brand); the pair currently trading gets a pulsing brand ring and sits leftmost; the rest
// secondary. The label is fixed-width so both rows' chips start aligned.
function FilmRow({ label, wallets, selectedId, inTradeId, onSelect }: {
  label: string;
  wallets: WalletVM[];
  selectedId?: string;
  inTradeId?: string;
  onSelect: (w: WalletVM) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-sm text-kumo-subtle">{label} · {wallets.length}</span>
      <div className="flex gap-2 overflow-x-auto">
        {wallets.map((w) => {
          const sel = selectedId === w.id;
          const inTrade = inTradeId === w.id;
          return (
            <Button
              key={w.id}
              size="xs"
              variant={sel ? "primary" : "secondary"}
              aria-pressed={sel}
              onClick={() => onSelect(w)}
              // The secondary variant's ring is kumo-line (near-black @10% alpha) — too faint to read as a
              // border on a chip. Unselected chips get a clearly-visible neutral ring; the pair currently
              // trading gets a pulsing brand ring; the open chip keeps its primary brand ring.
              className={sel ? undefined : inTrade ? "ring-2 ring-kumo-brand" : "ring-kumo-contrast/30"}
              icon={<span aria-hidden className={`size-1.5 rounded-full ${inTrade ? "bg-kumo-brand animate-pulse" : "bg-kumo-success"}`} />}
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

// The active-wallet strip, split into two rows by the self-cross role: Maker and Taker. Idle, each row is
// a quick-access filmstrip of that cohort's active wallets. WHILE the automation runs it becomes a live
// queue: wallets already processed this round drain out and the pair currently trading floats leftmost,
// so the two rows behave like two draining queues. Wallets with no cohort sit in neither row; the strip
// hides when idle and both rows are empty.
export function CohortFilmstrip({ wallets, selectedId, onSelect }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
}) {
  const prog = useAutomationProgress();
  const active = wallets.filter((w) => w.status === "active");

  // Idle: the full cohort, static. Running: drop the wallets already done this round and float the
  // in-trade wallet to the front, so the row drains left-to-right as the round progresses.
  const arrange = (list: WalletVM[], inTradeId?: string): WalletVM[] => {
    if (!prog.running) return list.slice(0, 200);
    const remaining = list.filter((w) => !prog.doneIds.has(w.id));
    const i = inTradeId ? remaining.findIndex((w) => w.id === inTradeId) : -1;
    if (i > 0) { const [w] = remaining.splice(i, 1); remaining.unshift(w!); }
    return remaining.slice(0, 200);
  };

  const makers = arrange(active.filter((w) => w.cohort === "maker"), prog.inTrade?.[0]);
  const takers = arrange(active.filter((w) => w.cohort === "taker"), prog.inTrade?.[1]);
  // Keep the strip up while running (even momentarily empty between rounds); hide only when idle + empty.
  if (!prog.running && makers.length === 0 && takers.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-kumo-line px-4 py-2">
      <FilmRow label="Maker" wallets={makers} selectedId={selectedId} inTradeId={prog.inTrade?.[0]} onSelect={onSelect} />
      <FilmRow label="Taker" wallets={takers} selectedId={selectedId} inTradeId={prog.inTrade?.[1]} onSelect={onSelect} />
    </div>
  );
}

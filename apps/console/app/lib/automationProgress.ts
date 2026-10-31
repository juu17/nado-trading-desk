"use client";

import { useSyncExternalStore } from "react";
import type { WalletVM } from "@farm/ui";

/** Live progress of the running automation, shared from the sidebar's Trading-strategy controls (which
 *  drive the engine) to the main-pane CohortFilmstrip (far apart in the tree) via a tiny module store —
 *  so the filmstrip drains its maker/taker queues as pairs trade, with no prop plumbing through page.tsx.
 *  The engine itself stays pure: TradingStrategy's per-pair/round hooks are what push into this store. */
export interface AutomationProgress {
  running: boolean;
  /** [makerId, takerId] of the pair currently trading — shown leftmost in the filmstrip. */
  inTrade: readonly [string, string] | null;
  /** Wallet ids that have already been processed (traded or skipped) THIS round — drained from the strip
   *  until the next round refills the queue. */
  doneIds: ReadonlySet<string>;
}

const EMPTY: AutomationProgress = { running: false, inTrade: null, doneIds: new Set() };
let state: AutomationProgress = EMPTY;
const listeners = new Set<() => void>();

function emit(next: AutomationProgress): void {
  state = next;
  for (const l of listeners) l();
}

/** Mutators the automation hooks call as a run progresses. Each replaces the snapshot so subscribers
 *  (the filmstrip) re-render; `id` helpers keep the component layer from reaching into wallet objects. */
export const automationProgress = {
  stop(): void { emit(EMPTY); },
  /** A fresh round: mark running and refill the queue (clear the round's drained ids). Also serves as the
   *  run-start reset, since it fires at the top of round 1 — so there's no separate start() to drift. */
  roundStart(): void { emit({ running: true, inTrade: null, doneIds: new Set() }); },
  pairStart(pair: readonly [WalletVM, WalletVM]): void { emit({ ...state, inTrade: [pair[0].id, pair[1].id] }); },
  pairEnd(pair: readonly [WalletVM, WalletVM]): void {
    const doneIds = new Set(state.doneIds);
    doneIds.add(pair[0].id);
    doneIds.add(pair[1].id);
    emit({ ...state, inTrade: null, doneIds });
  },
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function getSnapshot(): AutomationProgress { return state; }

/** Subscribe a component to the live automation progress. The snapshot ref is stable between mutations,
 *  so this re-renders only when a pair starts/ends or a run starts/stops. */
export function useAutomationProgress(): AutomationProgress {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

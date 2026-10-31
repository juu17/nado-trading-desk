"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, Text } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { setWalletCohort } from "../lib/custody";
import { runContinuous, TESTNET_ONLY_MSG } from "../lib/automation";
import { shuffle } from "../lib/rand";
import { useNetwork } from "./NetworkProvider";

/** The trade symbol from a market id — the part after the ":" (e.g. "nado:perp:BTC-PERP" → "BTC-PERP"). */
const symbolOf = (id: string) => id.split(":").pop() ?? id;

/** The sidebar Trading-strategy controls: the min–max per-pair volume, the market picker, the "Cohort"
 *  pre-step (random 50/50 split of un-cohorted wallets into maker/taker), and the Run/Pause toggle that
 *  runs continuous self-cross rounds over the split cohort. Cohort first, then run. Automated order
 *  placement is testnet-only until the mainnet confirm step ships (a later wave); metrics fill in then. */
export function TradingStrategy({ wallets, markets, onWalletChanged, isLive = false }: {
  wallets: WalletVM[];
  markets: Market[];
  onWalletChanged?: () => void;
  isLive?: boolean;
}) {
  const [minVol, setMinVol] = useState("100");
  const [maxVol, setMaxVol] = useState("500");
  const [market, setMarket] = useState<string>("");
  const [busy, setBusy] = useState(false);     // the Cohort split is in flight
  const [running, setRunning] = useState(false); // a round is in flight
  const [log, setLog] = useState<string[]>([]);
  const { net } = useNetwork();
  const abortRef = useRef<AbortController | null>(null); // the in-flight continuous loop, so Pause can stop it

  // Keep a valid market selected as the live market list arrives. Default to BTC-PERP by its EXACT symbol
  // (the part after the ":", same as the option label) — `endsWith("BTC-PERP")` would also catch
  // KBTC-PERP / WBTC-PERP and silently land on whichever appears first.
  useEffect(() => {
    if (markets.length && !markets.some((m) => m.id === market)) {
      const pick = markets.find((m) => symbolOf(m.id) === "BTC-PERP") ?? markets[0]!;
      setMarket(pick.id);
    }
  }, [markets]); // eslint-disable-line react-hooks/exhaustive-deps

  const append = (m: string) => setLog((l) => [m, ...l].slice(0, 40));

  const makerCount = wallets.filter((w) => w.cohort === "maker").length;
  const takerCount = wallets.filter((w) => w.cohort === "taker").length;

  // The Cohort pre-step: randomly split the UN-cohorted wallets 50/50 into maker/taker (manual picks
  // untouched; an odd one out stays unassigned). Writes are sequential — each setWalletCohort read-modify-
  // writes the shared vault tag store, so parallel would race. A pool of <2 can't form a pair, so it's a
  // no-op. If a write fails mid-loop we report how many actually landed (the skew is real, surfaced not
  // hidden) and still repaint, so the button's M/T count reflects persisted truth and a re-run finishes.
  const runCohortSplit = async () => {
    const pool = shuffle(wallets.filter((w) => !w.cohort));
    if (pool.length < 2) {
      append(pool.length ? "Only 1 un-cohorted wallet — need ≥2 to form a maker/taker pair." : "Nothing to split — every wallet already has a cohort.");
      return;
    }
    const half = Math.floor(pool.length / 2);
    const plan = [
      ...pool.slice(0, half).map((w) => [w, "maker"] as const),
      ...pool.slice(half, half * 2).map((w) => [w, "taker"] as const),
    ];
    setBusy(true);
    let done = 0;
    try {
      for (const [w, cohort] of plan) { await setWalletCohort(w.id, cohort); done++; }
      append(`✓ split ${plan.length} wallet(s): ${half} maker / ${half} taker${pool.length % 2 ? " · 1 left unassigned" : ""}`);
    } catch (e) {
      const m = Math.min(done, half);
      append(`✗ split stopped at ${done}/${plan.length} (${m} maker / ${done - m} taker) — re-run to finish: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      onWalletChanged?.();
    }
  };

  // Start/stop the continuous self-cross loop (the Run/Pause toggle). On start we validate the volume
  // range + the per-order cap (the first place they're consumed), refuse off testnet, then run rounds
  // until Pause aborts the loop via its AbortController. The engine flattens every pair, so a pause
  // leaves the cohort flat; each round re-rolls the side.
  const toggleAutomation = async () => {
    // Pause/guard on the ref (set synchronously), NOT `running` (which commits a frame later) — so a fast
    // double-click can't start a second loop and orphan the first, and a click while a loop runs always
    // pauses it (the button stays enabled while running for exactly this).
    if (abortRef.current) { abortRef.current.abort(); return; }
    const min = Number(minVol);
    const max = Number(maxVol);
    if (!net.isTestnet) { append(TESTNET_ONLY_MSG); return; }
    if (!(min > 0) || !(max >= min)) { append(`✗ volume range invalid — need 0 < min ≤ max (got ${minVol}–${maxVol}).`); return; }
    if (max > net.caps.orderNotionalUsdt0) { append(`✗ max volume ${max} exceeds the per-order cap ${net.caps.orderNotionalUsdt0} USDT0.`); return; }
    if (!market) { append("✗ pick a market first."); return; }
    const makers = wallets.filter((w) => w.cohort === "maker");
    const takers = wallets.filter((w) => w.cohort === "taker");
    if (makers.length === 0 || takers.length === 0) { append("✗ run Cohort first — need ≥1 maker and ≥1 taker."); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    append(`▶ start — ${Math.min(makers.length, takers.length)} pair(s)/round @ ${symbolOf(market)}`);
    try {
      await runContinuous(makers, takers, { market, minNotional: min, maxNotional: max }, { log: append, signal: ctrl.signal });
    } catch (e) {
      append(`✗ automation error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
      onWalletChanged?.();
    }
  };

  if (!isLive) return <Text variant="secondary" size="xs">Unlock a live cohort to run a trading strategy.</Text>;

  return (
    <div className="flex flex-col gap-3">
      {/* Point 1 — the per-pair volume range (each pair draws a random USDT0 notional in [min, max]). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Volume / pair (USDT0)</span>
        <div className="flex items-center gap-2">
          <Input size="sm" aria-label="Min volume per pair" className="min-w-0 flex-1" value={minVol} onChange={(e) => setMinVol(e.target.value)} />
          <span className="shrink-0 text-kumo-subtle">–</span>
          <Input size="sm" aria-label="Max volume per pair" className="min-w-0 flex-1" value={maxVol} onChange={(e) => setMaxVol(e.target.value)} />
        </div>
      </div>

      <Select size="sm" label="Market" hideLabel={false} value={market} onValueChange={(v) => { if (v) setMarket(String(v)); }}>
        {markets.map((mk) => <Select.Option key={mk.id} value={mk.id}>{symbolOf(mk.id)}</Select.Option>)}
      </Select>

      {/* Step 1 — the Cohort pre-step. Explicitly the prerequisite to Run automation. */}
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="secondary" loading={busy} onClick={runCohortSplit}>
          Cohort · {makerCount}M / {takerCount}T
        </Button>
        <Text variant="secondary" size="xs">Step 1 — split un-cohorted wallets 50/50 before running.</Text>
      </div>

      {/* Point 4 — the Run/Pause toggle: continuous self-cross rounds over the split cohort. Idle shows a
          play icon in the brand fill; running shows a pause icon in the neutral fill. Disabled until a
          cohort exists and off testnet (mainnet automation needs its confirm step, a later wave) — but it
          stays clickable WHILE running so it can pause. */}
      <div className="flex flex-col gap-1">
        <Button size="sm" variant={running ? "secondary" : "primary"} icon={running ? PauseIcon : PlayIcon} disabled={!running && (!net.isTestnet || makerCount === 0 || takerCount === 0)} onClick={toggleAutomation}>
          {running ? "Pause automation" : "Run automation"}
        </Button>
        {!net.isTestnet && <Text variant="secondary" size="xs">Testnet only — mainnet automation ships with its confirm step.</Text>}
      </div>

      {/* Log pane — per-wallet eligibility + per-pair results land here once the engine runs. */}
      <div className="max-h-28 overflow-y-auto rounded-md bg-kumo-tint px-2 py-1.5 font-mono text-xs">
        {log.length === 0
          ? <span className="text-kumo-subtle">Automation log…</span>
          : log.map((l, i) => <div key={i} className={l.startsWith("✗") ? "text-kumo-danger" : l.startsWith("✓") ? "text-kumo-success" : "text-kumo-subtle"}>{l}</div>)}
      </div>

      {/* Live metrics — filled in once the engine + metrics wave lands. */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><div className="text-kumo-subtle">Pairs</div><div className="tabular-nums">—</div></div>
        <div><div className="text-kumo-subtle">Fills/s</div><div className="tabular-nums">—</div></div>
        <div><div className="text-kumo-subtle">p99 ms</div><div className="tabular-nums">—</div></div>
      </div>
    </div>
  );
}

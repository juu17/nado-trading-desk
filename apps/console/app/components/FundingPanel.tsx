"use client";

import { useRef, useState } from "react";
import { Banner, Button, Input, LayerCard, Text, cn } from "@cloudflare/kumo";
import { CheckCircleIcon, StopIcon, XCircleIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { LIVE_COHORT } from "../lib/live";
import { fundCohortLive, DEFAULT_REFUEL_ETH, DEFAULT_MINT_USDT0, DEFAULT_DEPOSIT_USDT0, TREASURY_WALLET_ID } from "../lib/liveContext";
import type { FundProgress } from "../lib/liveContext";
import { ConfirmDialog } from "./ConfirmDialog";

type LogLine = { ok: boolean; text: string };

/** Bulk cohort funding (TESTNET on-ramp) — the operator path that productizes fund-cohort.mjs. Targets
 *  the LIVE wallets still `unfunded` (and never the treasury) and runs gas → mint → deposit per wallet,
 *  all signed IN-TAB. Idempotent skips (gas floor + USDT0 balance) mean a re-run only does missing steps,
 *  but depositCollateral is NOT idempotent so only `unfunded` wallets are targeted. Abortable (Stop). */
export function FundingPanel({ wallets, onFunded }: { wallets: WalletVM[]; onFunded?: (walletIds: string[]) => void }) {
  // Wallets already funded THIS session are excluded immediately — depositCollateral is not idempotent and
  // the readiness gate lags on-chain confirmation (the sequencer indexes collateral after the tx mines),
  // so without this a re-run during that window would re-target + double-deposit a just-funded wallet.
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const targets = wallets.filter((w) => w.cohorts.includes(LIVE_COHORT) && w.readiness === "unfunded" && w.id !== TREASURY_WALLET_ID && !doneIds.has(w.id));
  const [gasEach, setGasEach] = useState(DEFAULT_REFUEL_ETH);
  const [mintEach, setMintEach] = useState(DEFAULT_MINT_USDT0);
  const [depositEach, setDepositEach] = useState(DEFAULT_DEPOSIT_USDT0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const append = (ok: boolean, text: string) => setLog((l) => [{ ok, text }, ...l].slice(0, 12));

  const run = async () => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;
    setBusy(true); setSummary(null); setLog([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fundCohortLive(ids, {
        gasEach, mintEach, depositEach, signal: ac.signal,
        onProgress: (p: FundProgress) => {
          append(p.status === "ok", `${p.walletId} · ${p.phase}${p.error ? ` — ${p.error}` : ""}${p.tx ? ` · ${p.tx.slice(0, 10)}…` : ""}`);
          // Drop a fully-funded wallet from future targets at once (don't wait for the readiness reconcile),
          // so an immediate re-run can't double-deposit it. A FAILED wallet stays targetable for a retry.
          if (p.phase === "done" && p.status === "ok") setDoneIds((s) => new Set(s).add(p.walletId));
        },
      });
      setSummary(`done — funded ${res.funded}, failed ${res.failed}, skipped ${res.skipped}`);
      onFunded?.(ids); // repaint the attempted wallets + treasury (native/collateral/readiness)
    } catch (e) {
      setSummary(`✗ ${(e as Error).message}`); // the "✗ " prefix is part of the cap-reject e2e contract
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <>
      {/* shrink-0: the layered LayerCard is overflow-hidden, so as a flex item in the fixed-height
          sidebar it would otherwise shrink to 0 min-height and clip its own controls (unclickable)
          instead of letting the sidebar scroll. */}
      <LayerCard className="shrink-0">
        <LayerCard.Secondary>Fund cohort (testnet)</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text variant="secondary" size="xs">
            {targets.length} unfunded live wallet(s) — gas → mint → deposit from the treasury ({TREASURY_WALLET_ID}).
          </Text>
          <div className="flex flex-col gap-2">
            <Input size="sm" label="Gas ETH" value={gasEach} onChange={(e) => setGasEach(e.target.value)} />
            <Input size="sm" label="Mint USDT0" value={mintEach} onChange={(e) => setMintEach(e.target.value)} />
            <Input size="sm" label="Deposit USDT0" value={depositEach} onChange={(e) => setDepositEach(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || targets.length === 0} onClick={() => setConfirm(true)}>
              Fund {targets.length} wallet{targets.length === 1 ? "" : "s"}
            </Button>
            {busy && <Button variant="secondary-destructive" icon={StopIcon} onClick={() => abortRef.current?.abort()}>Stop</Button>}
          </div>
          {summary && (summary.startsWith("✗")
            ? <Banner variant="error" size="sm" icon={<XCircleIcon weight="fill" />} description={summary} />
            : <span className="text-kumo-success">{summary}</span>)}
          {log.length > 0 && (
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {log.map((l, i) => (
                <li key={i} className={cn("flex items-start gap-1.5", l.ok ? "text-kumo-success" : "text-kumo-danger")}>
                  {l.ok ? <CheckCircleIcon className="mt-0.5 shrink-0" /> : <XCircleIcon className="mt-0.5 shrink-0" />}
                  <Text variant="mono" as="span">{l.text}</Text>
                </li>
              ))}
            </ul>
          )}
          <Text variant="secondary" size="xs">
            Bulk testnet on-ramp: each unfunded wallet is refueled (if low), minted USDT0 (if short), then approve+deposit — all signed in this tab. depositCollateral is not idempotent, so already-funded wallets (readiness ≠ unfunded) are not targeted.
          </Text>
        </LayerCard.Primary>
      </LayerCard>

      <ConfirmDialog
        open={confirm}
        title="Fund cohort (on-chain testnet)"
        body={<>Fund <strong className="font-medium text-kumo-default">{targets.length}</strong> unfunded live wallet{targets.length === 1 ? "" : "s"} from the treasury (<strong className="font-medium text-kumo-default">{TREASURY_WALLET_ID}</strong>): refuel <strong className="font-medium text-kumo-default">{gasEach} ETH</strong> (if low) + mint <strong className="font-medium text-kumo-default">{mintEach} USDT0</strong> (if short) + deposit <strong className="font-medium text-kumo-default">{depositEach} USDT0</strong> each — real testnet transactions, signed in this tab.</>}
        danger={<>Real testnet funds move across {targets.length} wallet(s). The key never leaves your browser.</>}
        onConfirm={() => { setConfirm(false); void run(); }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

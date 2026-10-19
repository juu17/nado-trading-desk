"use client";

import { useState } from "react";
import { Banner, Button, Input, InputArea, LayerCard, Text } from "@cloudflare/kumo";
import { KeyIcon, LockIcon, XCircleIcon } from "@phosphor-icons/react";
import { generateCohort, importCohort, importCohortByPrivateKeys, cohortWallets, isUnlocked, lockCohort } from "../lib/custody";
import type { CohortWallet } from "../lib/custody";
import { verifyInTabSigning } from "../lib/liveClient";
import type { InTabProduct } from "../lib/liveClient";
import { resetLiveContexts } from "../lib/liveContext";

/** Custody graduation UI (Stage 2b): generate/import/unlock an IN-TAB cohort (keys live in
 *  this browser), after which the live fleet, order signing, FUNDING, and reads ALL run in
 *  the tab — orders/withdraw via the keyless relay, deposit broadcast straight to the Ink
 *  RPC by a keyless ChainClient. The server holds no key. "Import funded (dev)" pulls the
 *  disposable testnet seed so the in-tab cohort is the already-funded one for verification. */
export function CustodyPanel({ cohortSize, product, onCohortChange, isTestnet }: { cohortSize?: number; product?: InTabProduct; onCohortChange?: () => void; isTestnet?: boolean }) {
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [privKeys, setPrivKeys] = useState("");
  const [wallets, setWallets] = useState<CohortWallet[]>(cohortWallets());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const n = Math.max(1, cohortSize ?? 3);
  const unlocked = wallets.length > 0 && isUnlocked();

  const run = async (fn: () => Promise<CohortWallet[]>, label: string) => {
    setBusy(true); setMsg(null);
    try {
      const ws = await fn();
      resetLiveContexts();
      setWallets(ws); setMsg(`✓ ${label}: ${ws.length} wallet(s) in this tab`);
      onCohortChange?.();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  // DEV: fetch the funded disposable seed over localhost and import it (the mnemonic is
  // consumed straight into custody — never rendered, never stored in component state).
  const importFundedDev = () => run(async () => {
    const r = await fetch("/api/nado/dev-seed", { cache: "no-store" }).then((x) => x.json()) as { mnemonic?: string; error?: string };
    if (r.error || !r.mnemonic) throw new Error(r.error ?? "no seed returned");
    return importCohort(r.mnemonic, n, password);
  }, "imported funded (dev)");

  const verify = async () => {
    if (!product) { setMsg("✗ no live product to sign against"); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await verifyInTabSigning(wallets[0]?.walletId ?? "live:0", product);
      setMsg(r.match ? `✓ in-tab sign + recover OK (${r.address.slice(0, 10)}…)` : "✗ recover mismatch");
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  // A Kumo LayerCard: the Secondary header keeps the literal "In-browser custody · <state>" run (the
  // e2e helpers wait on it). Feedback stays INLINE (a portaled Toast would leave the <aside> the specs
  // scope to). Passwords use Input type="password" — Kumo's SensitiveInput reveals while typing and
  // always offers a clipboard Copy, which this keys-off-the-clipboard custody model must not.
  // shrink-0: an overflow-hidden flex item in the fixed-height sidebar would otherwise shrink and clip
  // its own controls (unclickable) instead of letting the sidebar scroll.
  return (
    <LayerCard className="shrink-0">
      <LayerCard.Secondary>In-browser custody · {unlocked ? "unlocked" : "locked"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        {!unlocked ? (
          <>
            <Input type="password" size="sm" aria-label="Workspace password" placeholder="workspace password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <InputArea size="sm" aria-label="Mnemonic (optional)" placeholder="(optional) import a mnemonic — blank = generate fresh in-tab" rows={2} spellCheck={false} autoComplete="off" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={busy || !password} onClick={() => (mnemonic.trim() ? run(() => importCohort(mnemonic, n, password), "imported") : run(() => generateCohort(n, password), "generated"))}>
                {mnemonic.trim() ? "Import + unlock" : `Generate ${n} in-tab`}
              </Button>
            </div>
            <InputArea size="sm" aria-label="Private keys" placeholder="…or paste private keys — one 0x EVM key per line (creates a PK cohort)" rows={2} spellCheck={false} autoComplete="off" value={privKeys} onChange={(e) => setPrivKeys(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={KeyIcon} disabled={busy || !password || !privKeys.trim()} onClick={() => run(() => importCohortByPrivateKeys(privKeys.split(/[\s,]+/), password), "imported keys")}>Import private keys</Button>
              {/* The dev seed is the funded disposable TESTNET cohort — meaningless on mainnet (its
                  route 403s there), so hide the button off testnet. */}
              {isTestnet && <Button size="sm" variant="ghost" disabled={busy || !password} onClick={importFundedDev}>Import funded (dev)</Button>}
            </div>
          </>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {wallets.map((w) => (
                <li key={w.walletId}><Text variant="mono-secondary" as="span">{w.walletId} · {w.address.slice(0, 10)}…{w.address.slice(-6)}</Text></li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy} onClick={verify}>Verify in-tab signing</Button>
              <Button size="sm" icon={LockIcon} disabled={busy} onClick={() => { lockCohort(); resetLiveContexts(); setWallets([]); setMsg("locked"); onCohortChange?.(); }}>Lock</Button>
            </div>
          </>
        )}
        {msg && (msg.startsWith("✗")
          ? <Banner variant="error" size="sm" icon={<XCircleIcon weight="fill" />} description={msg} />
          : <span className={msg.startsWith("✓") ? "text-kumo-success" : "text-kumo-subtle"}>{msg}</span>)}
        <Text variant="secondary" size="xs">
          Keys are generated/imported and sign in this browser tab (IndexedDB) and never reach the server. The live fleet, order signing, funding (deposit on-chain + withdraw) and reads all run in-tab via the keyless relay (deposits broadcast to the Ink RPC directly) — the server holds no key.
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

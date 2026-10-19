"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, LinkButton, Sidebar as KumoSidebar, Text, Tooltip } from "@cloudflare/kumo";
import { ArrowRightIcon, FunnelIcon, ReceiptIcon, UsersThreeIcon, WalletIcon } from "@phosphor-icons/react";
import { filterWallets, accountOptions, cohortsOf } from "@farm/ui";
import type { WalletVM, Fleet } from "@farm/ui";
import { Sidebar } from "./components/Sidebar";
import { WalletGrid } from "./components/WalletGrid";
import { WalletDrawer } from "./components/WalletDrawer";
import { CohortFilmstrip } from "./components/CohortFilmstrip";
import { AccountingView } from "./components/AccountingView";
import { useNetwork } from "./components/NetworkProvider";
import { bulk } from "./lib/bulk";
import { fetchLiveState, reconcileWallet, mergeWallet, liveWalletVMs, isLiveWallet } from "./lib/live";
import { readBudget, forceRefreshNative, TREASURY_WALLET_ID } from "./lib/liveContext";
import { openOrderUpdateStream } from "./lib/orderUpdateStream";
import type { LiveState } from "./lib/live";
import { openLiveStream } from "./lib/liveStream";
import type { LiveEvent } from "./lib/liveStream";

export default function Page() {
  const { chainId, net } = useNetwork(); // selected network: drives labels + the reconnect-on-switch
  // The fleet is the REAL in-tab cohort only (no mock): the home page shows the unlocked vault's
  // accounts and their wallets, grouped by account in the sidebar filter.
  const [live, setLive] = useState<LiveState>({ enabled: false });
  // Repopulate the live fleet IDENTITIES (keyless config + in-tab cohort; no per-wallet reads).
  // Called on mount and on cohort change (unlock/lock/import); the budget-paced sweep + the
  // WS-targeted reconcile fill in each wallet's reads afterward.
  const refreshLive = useCallback(() => { fetchLiveState().then(setLive).catch(() => {}); }, []);
  useEffect(() => { refreshLive(); }, [refreshLive, chainId]); // re-fetch + reconnect on a network switch

  // Browser-side WS: the public `fill` stream for EVERY cohort subaccount (no key) routes a
  // targeted per-wallet reconcile; a budget-paced round-robin sweep keeps the idle bulk fresh
  // within the per-IP read budget. (order_update is auth-gated — a working-set enhancement, W5.)
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [wsOpen, setWsOpen] = useState(false);
  const subKey = (live.wallets ?? []).map((w) => w.subaccount).filter(Boolean).join(",");
  useEffect(() => {
    if (!live.enabled || !live.wsSubscribeUrl || !subKey) return;
    // subaccount → walletId: a public fill/position_change names its subaccount, so it
    // reconciles ONLY that wallet. This replaces the old "any WS event re-reads the WHOLE
    // cohort" amplifier (2N reads per event) that collapsed the live ceiling below ~20 under
    // any trading activity — read cost is now O(active wallets), not O(cohort).
    // Key lowercased on BOTH sides so a casing difference in the sequencer's echoed subaccount
    // can't silently miss the fast path (subaccountToHex is lowercase; a bytes32 is never
    // EIP-55-checksummed, but normalize defensively). The budget-paced sweep below backstops any residual.
    let stopped = false; // one teardown gate shared by both async paths (targeted + sweep)
    const subToWallet = new Map<string, string>();
    for (const w of live.wallets ?? []) if (w.subaccount) subToWallet.set(w.subaccount.toLowerCase(), w.walletId);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconcile = (walletId: string): void => {
      const prev = timers.get(walletId);
      if (prev) clearTimeout(prev);
      // Coalesce a burst of fills on one wallet into a single targeted re-read.
      timers.set(walletId, setTimeout(() => {
        timers.delete(walletId);
        reconcileWallet(walletId).then((upd) => { if (!stopped) setLive((s) => mergeWallet(s, upd)); }).catch(() => {});
      }, 500));
    };
    const stream = openLiveStream({
      url: live.wsSubscribeUrl, subaccounts: subKey.split(","),
      onStatus: (s) => setWsOpen(s === "open"),
      onEvent: (e) => {
        setLiveEvents((xs) => [e, ...xs].slice(0, 20));
        const walletId = e.subaccount ? subToWallet.get(e.subaccount.toLowerCase()) : undefined;
        if (walletId) reconcile(walletId); // targeted, not a full-cohort re-read
      },
    });
    // Budget-paced round-robin reconcile sweep — replaces the flat O(N)-every-20s poll, which
    // re-read the WHOLE cohort each tick and backlogged the limiter past ~20 wallets. It
    // reconciles ONE wallet at a time (2 metered reads each); each reconcile BLOCKS on the
    // client RateLimiter (~2/s), so the AGGREGATE read rate is bounded regardless of N and never
    // backlogs. Per-wallet freshness is ~cohort-size seconds (worst case, more under write/WS
    // contention) — graceful degradation instead of the whole cohort stalling. This is the
    // STEADY-state N-decoupler that lifts the ceiling toward ~1000; active wallets stay
    // sub-second-fresh via the WS-targeted reconcile above. (Cold-start no longer reads:
    // mount/unlock populates identities only, and the sweep fills reads lazily — first-screen
    // wallets first since it walks the cohort in order.) The sweep reserves budget headroom so
    // it can't starve interactive ops (a kill-switch cancel-all, a drawer read).
    const SWEEP_RESERVE = 3; // leave this many of the 6 burst tokens for interactive/write ops
    const cohort = live.wallets ?? [];
    let cursor = 0;
    const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      while (!stopped) {
        if (cohort.length === 0) { await nap(1000); continue; }
        if (readBudget() <= SWEEP_RESERVE) { await nap(400); continue; } // yield headroom to interactive ops
        const w = cohort[cursor % cohort.length]!;
        cursor++;
        try {
          const upd = await reconcileWallet(w.walletId); // blocks on the RateLimiter inside readWalletLive
          if (!stopped) setLive((s) => mergeWallet(s, upd));
        } catch { /* transient; the next pass retries this wallet */ }
        await nap(50); // floor so a no-op limiter can't hot-loop; real pacing is the limiter
      }
    })();
    return () => { stopped = true; for (const t of timers.values()) clearTimeout(t); stream.close(); };
  }, [live.enabled, live.wsSubscribeUrl, subKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveWallets = useMemo(() => liveWalletVMs(live), [live]);
  const fleet = useMemo<Fleet>(() => ({
    accounts: live.accounts ?? [],
    wallets: liveWallets,
    cohorts: cohortsOf(liveWallets),
  }), [live.accounts, liveWallets]);

  const options = useMemo(() => accountOptions(fleet.accounts), [fleet]);

  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(() => new Set());
  const [selectedCohorts, setSelectedCohorts] = useState<Set<string>>(new Set());
  const [drawerWallet, setDrawerWallet] = useState<WalletVM | null>(null);
  const [accountingOpen, setAccountingOpen] = useState(false);

  // Viewed-wallet priority: reconcile the OPENED live wallet immediately so the drawer shows
  // fresh state without waiting for the round-robin sweep to walk around to it.
  const drawerId = drawerWallet?.id;
  useEffect(() => {
    if (!drawerId || !isLiveWallet({ id: drawerId })) return;
    let cancelled = false;
    reconcileWallet(drawerId).then((upd) => { if (!cancelled) setLive((s) => mergeWallet(s, upd)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [drawerId]);

  // Render the drawer from the CURRENT version of the opened wallet (re-derived from the live
  // fleet), so a reconcile / sweep / WS update reaches the open drawer's tiles — not just the
  // grid card behind it. Without this, the drawer shows a frozen snapshot from when it opened.
  // The reconciled LIVE wallet (openOrders[]/positions[]/subaccount) for the open drawer — the
  // detail the WalletVM flattens to counts. Drives the drawer's positions + open-orders list.
  const drawerLive = useMemo(
    () => (drawerId ? (live.wallets ?? []).find((w) => w.walletId === drawerId) : undefined),
    [drawerId, live.wallets],
  );
  const drawerVM = useMemo(
    () => (drawerWallet ? fleet.wallets.find((w) => w.id === drawerWallet.id) ?? drawerWallet : null),
    [drawerWallet, fleet.wallets],
  );

  // W5 — real-time ORDER STATE for the VIEWED wallet: open an AUTHED order_update WS (signed
  // in-tab, server keyless, direct from the browser) for the open drawer wallet ONLY — a bounded
  // working set of 1 (order_update is per-wallet/per-connection, so it can't be run cohort-wide).
  // order_update emits placed/cancelled/filled, so it is a LOW-LATENCY reconcile TRIGGER for
  // order-state changes the public fill stream wouldn't surface (placed/cancelled): on any frame
  // we coalesce a targeted reconcile so the drawer reflects it. The budget-paced sweep stays the
  // backstop (incl. if auth is rejected). subKey is a dep so a lock/unlock/re-import re-runs this.
  useEffect(() => {
    if (!drawerId || !isLiveWallet({ id: drawerId }) || !live.wsSubscribeUrl || !live.chainId || !live.endpoint) return;
    const sub = (live.wallets ?? []).find((x) => x.walletId === drawerId)?.subaccount;
    if (!sub) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const stream = openOrderUpdateStream({
      url: live.wsSubscribeUrl, walletId: drawerId, subaccount: sub, endpoint: live.endpoint, chainId: live.chainId,
      onEvent: () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { reconcileWallet(drawerId).then((upd) => { if (!stopped) setLive((s) => mergeWallet(s, upd)); }).catch(() => {}); }, 300);
      },
    });
    return () => { stopped = true; if (t) clearTimeout(t); stream.close(); };
  }, [drawerId, subKey, live.wsSubscribeUrl, live.chainId, live.endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default every real account to checked as it appears (so new accounts show up without the user
  // re-checking); only ADD, so a user's explicit un-check of an existing account is preserved.
  const accountKey = (live.accounts ?? []).map((a) => a.id).join(",");
  useEffect(() => {
    const ids = (live.accounts ?? []).map((a) => a.id);
    if (ids.length) setSelectedAccounts((s) => {
      const next = new Set(s);
      let added = false;
      for (const id of ids) if (!next.has(id)) { next.add(id); added = true; }
      return added ? next : s;
    });
  }, [accountKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => filterWallets(fleet.wallets, [...selectedAccounts], [...selectedCohorts]),
    [fleet, selectedAccounts, selectedCohorts],
  );

  const toggleCohort = (c: string) =>
    setSelectedCohorts((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  // Kumo Sidebar.Provider is the app shell: collapsible="none" keeps the left rail frozen (a fixed
  // <aside>, never a mobile sheet); only <main> scrolls. Width: Kumo honours `defaultWidth` only when
  // `resizable`, otherwise it pins --sidebar-width to its 16.25rem constant — so the rail is widened
  // (16.25rem → 20rem, 320px) through that variable on the Provider.
  return (
    <KumoSidebar.Provider
      collapsible="none"
      style={{ "--sidebar-width": "20rem" } as React.CSSProperties}
      className="h-dvh overflow-hidden bg-kumo-canvas text-kumo-default"
    >
      <Sidebar
        workspaceName={live.enabled ? net.networkName : "offline"}
        totalWallets={fleet.wallets.length}
        shownWallets={shown.length}
        shown={shown}
        accountOptions={options}
        selectedAccounts={selectedAccounts}
        onAccountsChange={setSelectedAccounts}
        cohorts={fleet.cohorts}
        selectedCohorts={selectedCohorts}
        onToggleCohort={toggleCohort}
        liveMarkets={live.markets}
        liveEnabled={live.enabled}
        liveDefaultProduct={live.defaultProduct}
        liveCohortSize={live.wallets?.length || 3}
        onLiveCohortChange={refreshLive}
        liveWallets={liveWallets}
        onFunded={(ids) => {
          // After a bulk fund, repaint each attempted wallet + the treasury (native gas, collateral,
          // readiness) via the same force-refresh + reconcile chain used by onRefueled.
          for (const id of new Set([...ids, TREASURY_WALLET_ID])) {
            void forceRefreshNative(id)
              .then(() => reconcileWallet(id))
              .then((upd) => setLive((s) => mergeWallet(s, upd)))
              .catch(() => {});
          }
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
          {/* The title + status pill never shrink; the "N shown" hint on the right is the part that yields
              (truncates) when the header runs out of room, so the heading never wraps. */}
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Text variant="heading" as="h1">All wallets</Text>
            {live.enabled && (
              // The network-accent status pill: no Kumo Badge variant fills with the brand, so it's a Badge
              // whose fill is overridden (Kumo cn) with the re-pointed brand token. Badge drops `title`, so
              // the detail moves to a Kumo Tooltip. The status string stays ONE text run (e2e contract).
              <Tooltip side="bottom" content={live.error ?? (live.locked ? `Unlock the in-tab cohort to go live on ${net.networkName}` : `${liveWallets.length} independent EOA wallet(s) live on ${net.networkName}`)}>
                <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-kumo-inverse" />
                  {live.locked
                    ? `LIVE ${net.networkName} · locked`
                    : `LIVE ${net.networkName} · ${liveWallets.length} EOAs${wsOpen ? " · WS live" : ""}${liveEvents.length > 0 ? ` · ${liveEvents.length} events` : ""}`}
                </Badge>
              </Tooltip>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex min-w-0 items-center gap-1 text-kumo-subtle">
              <span className="truncate">{shown.length} shown · scroll horizontally</span>
              <ArrowRightIcon className="shrink-0" />
            </span>
            <LinkButton href="/accounts" variant="secondary" icon={UsersThreeIcon} className="shrink-0">Accounts</LinkButton>
            <Button icon={ReceiptIcon} className="shrink-0" onClick={() => setAccountingOpen(true)}>Accounting</Button>
          </div>
        </header>
        <CohortFilmstrip wallets={shown} selectedId={drawerWallet?.id} onSelect={setDrawerWallet} />
        <div className="min-h-0 flex-1">
          {fleet.wallets.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <Empty
                icon={<WalletIcon size={48} className="text-kumo-inactive" />}
                title="No wallets yet"
                description="Create an account to derive or import wallets."
                contents={<LinkButton href="/accounts" variant="primary">Create an account</LinkButton>}
              />
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <Empty size="sm" icon={<FunnelIcon size={32} className="text-kumo-inactive" />} title="No wallets match the filter" />
            </div>
          ) : (
            <WalletGrid wallets={shown} selectedId={drawerWallet?.id} onSelect={setDrawerWallet} />
          )}
        </div>
      </main>
      <WalletDrawer
        wallet={drawerVM}
        onClose={() => setDrawerWallet(null)}
        isLive={drawerWallet ? isLiveWallet(drawerWallet) : false}
        liveEvents={drawerWallet && isLiveWallet(drawerWallet) ? liveEvents : undefined}
        liveMarkets={live.markets}
        openOrders={drawerLive?.openOrders}
        positions={drawerLive?.positions}
        balances={drawerLive?.balances}
        subaccount={drawerLive?.subaccount}
        onRefueled={(ids) => {
          // Force a fresh native read (bypass the SWR TTL) then reconcile so the recipient + treasury
          // gas badges + readiness repaint immediately instead of waiting out the next sweep pass.
          for (const id of ids) {
            void forceRefreshNative(id)
              .then(() => reconcileWallet(id))
              .then((upd) => setLive((s) => mergeWallet(s, upd)))
              .catch(() => {});
          }
        }}
      />
      <AccountingView open={accountingOpen} records={bulk.activity} onClose={() => setAccountingOpen(false)} />
    </KumoSidebar.Provider>
  );
}

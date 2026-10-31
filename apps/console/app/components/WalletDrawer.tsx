"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Button, Collapsible, Grid, InlineCopyText, Input, LayerCard, Loader, Text, cn } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import type { Order, Position, Market, Balance } from "@farm/adapter-api";
import { MARKETS } from "../lib/runtime";
import { depositLive, withdrawLive, refuelGasLive, mintUsdt0Live, depositAddressLive, TREASURY_WALLET_ID, DEFAULT_REFUEL_ETH } from "../lib/liveContext";
import type { LiveEvent } from "../lib/liveStream";
import { ConfirmDialog } from "./ConfirmDialog";
import { OrderTicket, useOrderTicket } from "./OrderTicket";
import { AccountKindBadge } from "./AccountKindBadge";
import { useNetwork } from "./NetworkProvider";
import { QRCodeSVG } from "qrcode.react";

/** A labelled stat tile from Kumo pieces (Kumo ships no stat primitive). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard className="flex flex-col gap-0.5 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className="capitalize tabular-nums">{value}</span>
    </LayerCard>
  );
}

/** One drawer section = a layered Kumo LayerCard (title in the Secondary strip, body in Primary).
 *  shrink-0: an overflow-hidden flex item in the fixed-height scroll column would otherwise shrink and
 *  clip its own controls instead of letting the column scroll. Titles stay ONE text run (e2e contract). */
function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <LayerCard className="shrink-0">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className={cn("flex flex-col gap-3", className)}>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

const em = (v: ReactNode) => <strong className="font-medium text-kumo-default">{v}</strong>;

/** The Order-book section frame: titled with the ticket's selected market (keeping the e2e's
 *  "Order book · <market>" run) and wrapping the frameless <OrderTicket.Book/>. Rendered inside the
 *  <OrderTicket> provider so it can read the selection. */
function BookSection() {
  const { market, mkt } = useOrderTicket();
  return (
    <Section title={`Order book · ${mkt(market)}`}>
      <OrderTicket.Book />
    </Section>
  );
}

export function WalletDrawer({ wallet, onClose, isLive = false, liveEvents, liveMarkets, openOrders, positions, balances, subaccount, onRefueled }: {
  wallet: WalletVM | null;
  onClose: () => void;
  isLive?: boolean;
  liveEvents?: LiveEvent[];
  liveMarkets?: Market[];
  openOrders?: Order[];      // the reconciled open-order LIST for this wallet (not just the count)
  positions?: Position[];    // the reconciled open positions for this wallet
  balances?: Balance[];      // the reconciled per-asset balance LIST for this wallet
  subaccount?: string;       // this wallet's subaccount hex — filters the live feed to THIS wallet
  onRefueled?: (walletIds: string[]) => void; // after a successful gas refuel → repaint these wallets' balances
}) {
  const open = wallet !== null;
  const isTreasury = wallet?.id === TREASURY_WALLET_ID; // the gas source — it funds others, not itself
  const mkt = (id: string): string => id.split(":").pop() ?? id;
  // Show only THIS wallet's live events: a public fill/position_change carries `subaccount`, so keep
  // the ones that match this wallet. (order_update is not pushed to this feed — order state surfaces
  // via the Open-orders list.) With no known subaccount, show nothing rather than leak the cohort feed.
  const walletEvents = subaccount
    ? (liveEvents ?? []).filter((e) => e.subaccount?.toLowerCase() === subaccount.toLowerCase())
    : [];
  const marketOptions = isLive && liveMarkets && liveMarkets.length ? liveMarkets : MARKETS;
  const { net } = useNetwork(); // the active network: gates the testnet-only faucet/mint UI + labels the copy
  const [amount, setAmount] = useState("100");
  const [gasAmount, setGasAmount] = useState(DEFAULT_REFUEL_ETH);
  const [pending, setPending] = useState<null | "deposit" | "withdraw" | "refuel" | "mint">(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dda, setDda] = useState<string | null>(null); // this wallet's Nado direct-deposit address
  const [balancesOpen, setBalancesOpen] = useState(true); // the Balances list is collapsible

  // Escape closes the drawer (a Kumo overlay gets this for free; this hand-rolled <aside> must add it).
  // Skipped while a confirm is open — Escape belongs to that dialog then.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pending === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onClose]);

  // Fetch this wallet's Nado direct-deposit address (DDA) while a LIVE drawer is open (keyless
  // indexer read via the server route). Re-fetches per wallet; aborts on close/switch.
  useEffect(() => {
    if (!isLive || !open || !wallet) { setDda(null); return; }
    const owner = wallet.address.value;
    const ac = new AbortController();
    setDda(null);
    void depositAddressLive(owner, ac.signal).then((a) => { if (!ac.signal.aborted) setDda(a); }).catch(() => {});
    return () => ac.abort();
  }, [isLive, open, wallet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const append = (m: string) => setLog((l) => [m, ...l].slice(0, 8));

  const doFund = async (action: "deposit" | "withdraw") => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Stage 2b: funding signs IN-TAB. Deposit = sealed-key on-chain tx broadcast by a
      // keyless ChainClient; withdraw = in-tab EIP-712 → keyless relay. No server key.
      const r = action === "deposit"
        ? await depositLive(wallet.id, amount)
        : await withdrawLive(wallet.id, amount);
      if (action === "deposit") {
        // Deposit is an on-chain tx: gate on !r.ok, NOT the absence of an error — a mined-but-REVERTED
        // deposit returns { ok:false, status:"reverted" } with no `error` and must not be logged as confirmed.
        if (!r.ok) append(`✗ deposit ${amount} USDT0 — ${r.error ?? r.status ?? "failed"}`);
        else append(`✓ deposit ${amount} USDT0 confirmed in-tab${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
      } else {
        // Withdraw is an async EIP-712 relay submit: a non-"success" status (ok=false) without an error is a
        // legitimate accepted-pending submission, so keep the error-gated "submitted · status" reporting.
        if (r.error) append(`✗ withdraw ${amount} USDT0 — ${r.error}`);
        else append(`✓ withdraw ${amount} USDT0 submitted (in-tab → sequencer)${r.status ? ` · ${r.status}` : ""}`);
      }
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doMint = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Testnet faucet: the TREASURY mints USDT0 to this wallet (openly-mintable test token), signed by
      // the treasury's sealed key in-tab + broadcast keyless. Gate on !r.ok so a reverted mint isn't a ✓.
      const r = await mintUsdt0Live(wallet.id, amount, { treasuryWalletId: TREASURY_WALLET_ID });
      if (!r.ok) append(`✗ mint ${amount} USDT0 — ${r.error ?? r.status ?? "failed"}`);
      else append(`✓ mint ${amount} USDT0 → this wallet${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doRefuel = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Gas refuel: send native ETH from the in-tab TREASURY to THIS wallet, signed by the treasury's
      // sealed key in-tab + broadcast by a keyless client (serialized on the treasury nonce). No server key.
      const r = await refuelGasLive(wallet.id, { amountEth: gasAmount, treasuryWalletId: TREASURY_WALLET_ID });
      // Gate on the explicit success flag, NOT the absence of an error: a MINED-but-REVERTED tx returns
      // { ok:false, status:"reverted" } with no `error`, and must never be reported as a ✓ confirmed refuel.
      if (!r.ok) append(`✗ refuel ${gasAmount} ETH — ${r.error ?? r.status ?? "failed"}`);
      else {
        append(`✓ refuel ${gasAmount} ETH → this wallet${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
        onRefueled?.([wallet.id, TREASURY_WALLET_ID]); // repaint recipient + treasury gas badges now
      }
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runPending = (): void => {
    const p = pending;
    setPending(null);
    if (p === "deposit" || p === "withdraw") void doFund(p);
    else if (p === "refuel") void doRefuel();
    else if (p === "mint") void doMint();
  };

  // Balances ordered so a NON-ZERO balance ranks above a zero one (then larger first); zeros sink.
  const sortedBalances = [...(balances ?? [])].sort((a, b) => {
    const na = Number(a.total) || 0, nb = Number(b.total) || 0;
    return (nb > 0 ? 1 : 0) - (na > 0 ? 1 : 0) || nb - na;
  });

  // Kumo has no drawer/sheet primitive, so the drawer stays a hand-rolled <aside> (the e2e locate it as
  // such) built from Kumo pieces: Kumo's own scrim (the recessed token at 80% opacity, exactly as Kumo's
  // Dialog/Sidebar backdrops) and Kumo Sidebar's right-edge recipe (bg-kumo-base, border-l border-kumo-line).
  // Full-width sheet on phones, 440px (w-110) from sm up.
  return (
    <>
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-kumo-recessed opacity-80" onClick={onClose} />}
      <aside
        className={cn(
          "fixed right-0 top-0 z-40 flex h-dvh w-full transform flex-col border-l border-kumo-line bg-kumo-base text-kumo-default transition-transform sm:w-110",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {wallet && (
          <>
            {/* Pinned header: identity + full address (InlineCopyText) + close. */}
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <AccountKindBadge kind={wallet.accountKind}>{wallet.accountName}</AccountKindBadge>
                  {isLive && <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">Live</Badge>}
                </div>
                <div className="flex items-start gap-1.5">
                  <Text variant="mono-secondary" as="span">#{wallet.index}</Text>
                  {/* FULL address (not truncated) so the operator can read/verify it; copy built in. */}
                  <InlineCopyText value={wallet.address.value} truncate={false} className="min-w-0 break-all text-left" labels={{ copyAction: "Copy address", copied: "Address copied" }}>
                    {wallet.address.value}
                  </InlineCopyText>
                </div>
              </div>
              <Button variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" onClick={onClose} />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <Grid variant="side-by-side" gap="sm" className="shrink-0">
                <Stat label="Quote" value={`${wallet.quoteBalance} USDT0`} />
                <Stat label="Native" value={`${wallet.nativeBalance} ETH`} />
                <Stat label="Open orders" value={String(wallet.openOrders)} />
                <Stat label="Readiness" value={wallet.readiness} />
              </Grid>

              {/* Deposit address (Nado DDA) — swapped up to sit right under the stats (was near the foot). */}
              {isLive && (
                <Section title="Deposit address (Nado DDA)">
                  {dda ? (
                    <div className="flex flex-col items-center gap-2">
                      <div data-testid="dda-qr" className="rounded-lg bg-kumo-base p-2 ring ring-kumo-hairline"><QRCodeSVG value={dda} size={132} /></div>
                      <InlineCopyText value={dda} truncate={false} className="w-full break-all text-left" labels={{ copyAction: "Copy DDA", copied: "DDA copied" }}>
                        {dda}
                      </InlineCopyText>
                      <Text variant="secondary" size="xs">Send USDT0 on Ink to this address to fund this wallet&apos;s subaccount — an alternative to an on-chain deposit.</Text>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" /> Fetching the deposit address…</div>
                  )}
                </Section>
              )}

              {isLive && positions && positions.length > 0 && (
                <Section title={`Positions (${positions.length})`}>
                  <ul className="flex flex-col gap-1 font-mono">
                    {positions.map((p, i) => (
                      <li key={`${p.market}-${i}`} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {mkt(p.market)} · <span className={p.side === "long" ? "text-kumo-success" : p.side === "short" ? "text-kumo-danger" : "text-kumo-subtle"}>{p.side}</span> {p.size}
                        </span>
                        <span className="shrink-0 text-kumo-subtle">mark {p.markPrice}{p.liquidationPrice ? ` · liq ${p.liquidationPrice}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {isLive && openOrders && openOrders.length > 0 && (
                <Section title={`Open orders (${openOrders.length})`}>
                  <ul className="flex flex-col gap-1 font-mono">
                    {openOrders.map((o, i) => (
                      <li key={o.venueId || o.clientId || i} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {mkt(o.market)} · <span className={o.side === "buy" ? "text-kumo-success" : "text-kumo-danger"}>{o.side}</span> {o.remaining}/{o.size}
                        </span>
                        <span className="shrink-0 text-kumo-subtle">@ {o.price ?? "mkt"} · {o.status}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* The order ticket: entry controls + the 4 action buttons live in one "Order box"; the order
                  book is its own section below it. */}
              <OrderTicket wallet={wallet} isLive={isLive} marketOptions={marketOptions} onActivity={append}>
                <Section title="Order box">
                  <OrderTicket.Entry />
                  <OrderTicket.Actions />
                </Section>
                {isLive && <BookSection />}
              </OrderTicket>

              {isLive && (
                <Section title="Funding (USDT0 collateral)">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1 basis-32"><Input label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
                    <Button onClick={() => setPending("deposit")} disabled={busy}>Deposit</Button>
                    <Button onClick={() => setPending("withdraw")} disabled={busy}>Withdraw</Button>
                  </div>
                  {net.isTestnet && (
                    <div className="flex items-center justify-between gap-2">
                      <Text variant="secondary" size="xs">Testnet faucet — mint USDT0 (6-dp) from the treasury to this wallet.</Text>
                      <Button onClick={() => setPending("mint")} disabled={busy}>Mint {amount}</Button>
                    </div>
                  )}
                  <Text variant="secondary" size="xs">Deposit = on-chain approve + depositCollateral, built and signed in this tab and broadcast by a keyless client; withdraw = a Nado EIP-712 signed in-tab then relayed. The server holds no key — funding, orders and reads all sign in your browser.</Text>

                  {/* Gas refuel (native ETH) — merged into the Funding card: collateral (USDT0) and gas (ETH)
                      are the two things a wallet needs funded, so they share one card now. */}
                  <div className="flex flex-col gap-3 border-t border-kumo-line pt-3">
                    <span className="text-sm font-medium">Gas refuel (native ETH)</span>
                    {isTreasury ? (
                      <Text variant="secondary">This is the gas {em("treasury")} ({TREASURY_WALLET_ID}) — the source wallet for refuels. Fund it externally; it cannot refuel itself.</Text>
                    ) : (
                      <>
                        <div className="flex items-end gap-2">
                          <div className="min-w-0 flex-1"><Input label="ETH amount" value={gasAmount} onChange={(e) => setGasAmount(e.target.value)} /></div>
                          <Button onClick={() => setPending("refuel")} disabled={busy}>Refuel gas</Button>
                        </div>
                        <Text variant="secondary" size="xs">Sends native ETH from the treasury ({TREASURY_WALLET_ID}) to this wallet so it can run the on-chain funding bootstrap (approve + deposit). Signed by the treasury&apos;s sealed key in this tab, broadcast by a keyless client; serialized on the treasury nonce.</Text>
                      </>
                    )}
                  </div>
                </Section>
              )}

              {isLive && (
                <Section title={<span className="flex items-center gap-1.5"><span aria-hidden className="size-1.5 animate-pulse rounded-full bg-kumo-brand" />Live stream (WS)</span>}>
                  {walletEvents.length === 0 ? (
                    <Text variant="secondary" size="xs">Subscribed to the public fill + position_change streams for this subaccount — events appear here and refresh this wallet in real time. Order placed/cancelled streams over the authed order_update WS and refreshes in the background.</Text>
                  ) : (
                    <ul className="flex flex-col gap-1 font-mono">
                      {/* Each row's text starts with the event type (the e2e anchors on it). */}
                      {walletEvents.slice(0, 8).map((e, i) => (
                        <li key={i}>{e.type}{e.reason ? ` · ${e.reason}` : ""}{e.digest ? ` · ${e.digest.slice(0, 12)}…` : ""}</li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}

              <Section title="Activity">
                {log.length === 0 ? (
                  <Text variant="secondary" size="xs">{isLive ? "Live orders sign in this browser tab (in-tab key) and relay to the real sequencer — the server holds no order key." : "No actions yet — each runs through the real NadoAdapter + plan runner (EIP-712 build → sign → mock gateway)."}</Text>
                ) : (
                  <ul className="flex flex-col gap-1 font-mono">
                    {/* The ✓/✗ prefixes are part of the e2e contract (refuel / cap-reject match them). */}
                    {log.map((l, i) => (
                      <li key={i} className={l.startsWith("✓") ? "text-kumo-success" : "text-kumo-danger"}>{l}</li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Balances — swapped down to the foot (was right under the stats). */}
              {isLive && (
                <LayerCard className="shrink-0 p-4">
                  {/* Kumo Collapsible: the trigger is a button named "Balances (N)"; the panel UNMOUNTS
                      when closed (default — never keepMounted), which the e2e relies on. */}
                  <Collapsible.Root open={balancesOpen} onOpenChange={setBalancesOpen}>
                    <Collapsible.DefaultTrigger>Balances{sortedBalances.length ? ` (${sortedBalances.length})` : ""}</Collapsible.DefaultTrigger>
                    <Collapsible.Panel className="mt-3">
                      {sortedBalances.length > 0 ? (
                        <ul className="flex flex-col gap-1 font-mono text-sm">
                          {sortedBalances.map((b, i) => (
                            <li key={`${b.asset}-${b.scope ?? ""}-${i}`} className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate">
                                {b.symbol || b.asset}{b.scope ? <span className="text-kumo-subtle"> · {b.scope}</span> : null}
                              </span>
                              <span className="shrink-0 tabular-nums">
                                {b.total}
                                {b.available !== b.total ? <span className="text-kumo-subtle"> · {b.available} avail</span> : null}
                                {b.usdValue ? <span className="text-kumo-subtle"> · ${b.usdValue}</span> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Text variant="secondary" size="xs">No collateral balances yet — deposit{net.isTestnet ? " or mint" : ""} USDT0 to fund this wallet&apos;s subaccount.</Text>
                      )}
                    </Collapsible.Panel>
                  </Collapsible.Root>
                </LayerCard>
              )}

              <div className="mt-auto flex shrink-0 flex-wrap gap-1">
                {wallet.tags.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
              </div>
            </div>
          </>
        )}
      </aside>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending === "deposit" ? "Deposit collateral (on-chain)"
            : pending === "withdraw" ? "Withdraw collateral"
            : pending === "refuel" ? "Refuel gas (native ETH transfer)"
            : "Mint USDT0 (testnet faucet)"
        }
        body={<>
          {pending === "deposit" && <>Approve + deposit {em(amount)} USDT0 on-chain to the Nado Endpoint — a real {net.networkName} transaction (gas), built and signed in this tab.</>}
          {pending === "withdraw" && <>Withdraw {em(amount)} USDT0 collateral via a Nado EIP-712 signed in this tab, relayed to the sequencer.</>}
          {pending === "refuel" && <>Send {em(`${gasAmount} ETH`)} from the treasury ({em(TREASURY_WALLET_ID)}) to this wallet ({em(`#${wallet?.index}`)}) — a real {net.networkName} native transfer (irreversible), signed by the treasury&apos;s sealed key in this tab.</>}
          {pending === "mint" && <>Mint {em(`${amount} USDT0`)} to this wallet ({em(`#${wallet?.index}`)}) from the treasury ({em(TREASURY_WALLET_ID)}) — a real {em("testnet")} faucet mint (gas), signed by the treasury&apos;s sealed key in this tab. Mainnet USDT0 is bridged, not minted.</>}
        </>}
        danger={<>Real {net.networkName} order / funds move. Everything signs in this tab — the key never leaves your browser.</>}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

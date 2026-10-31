"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, ButtonGroup, Grid, Input, Loader, Select, Text, cn } from "@cloudflare/kumo";
import type { WalletVM } from "@farm/ui";
import type { Order, OrderBook, Decimal, Market, PlaceOrderInput } from "@farm/adapter-api";
import { MARKETS, placeOrder, cancelOrders } from "../lib/runtime";
import { placeOrderLive, closePositionLive, readOrderBookLive, readBudget } from "../lib/liveContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { useNetwork } from "./NetworkProvider";

const em = (v: ReactNode) => <strong className="font-medium text-kumo-default">{v}</strong>;

/** Levels per side the ticket reads AND renders — the ladder's row count is fixed to this. */
const BOOK_DEPTH = 6;

/** One side of the order-book ladder: always exactly BOOK_DEPTH rows (missing levels render as blank,
 *  aria-hidden rows) so the box never changes height as levels come and go — a reflow here moved the
 *  controls a consumer renders below the book mid-click. */
function BookSide({ label, levels, tone }: { label: string; levels: OrderBook["bids"]; tone: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Text variant="secondary" size="xs">{label}</Text>
      {Array.from({ length: BOOK_DEPTH }, (_, i) => {
        const l = levels[i];
        return l ? (
          <div key={i} className="flex justify-between gap-2">
            <span className={cn("min-w-0 truncate", tone)}>{l.price}</span><span className="shrink-0 text-kumo-subtle">{l.size}</span>
          </div>
        ) : (
          <div key={i} aria-hidden>{" "}</div>
        );
      })}
    </div>
  );
}

/** The shared state + handlers for one order ticket (one wallet, one selected market). The provider owns
 *  it all; the three subcomponents consume it, so a consumer can place Entry / Book / Actions anywhere. */
interface OrderTicketValue {
  market: string; setMarket: (v: string) => void;
  side: "buy" | "sell"; setSide: (s: "buy" | "sell") => void;
  kind: "limit" | "market"; setKind: (k: "limit" | "market") => void;
  size: string; setSize: (v: string) => void;
  price: string; setPrice: (v: string) => void;
  isLive: boolean;
  marketOptions: Market[];
  shownBook: OrderBook | null;   // the book for the CURRENT market (a kept prior-market snapshot is null)
  bookLevels: OrderBook | null;  // shownBook, but only when it has levels to draw
  busy: boolean;
  submit: () => void;
  doCancel: () => void;
  requestTaker: () => void;      // opens the IOC-cross confirm (the provider owns the dialog)
  requestClose: () => void;      // opens the close-position confirm
  mkt: (id: string) => string;
}

const Ctx = createContext<OrderTicketValue | null>(null);

/** Read the enclosing ticket's state — e.g. to title a frame with the selected market. */
export function useOrderTicket(): OrderTicketValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOrderTicket must be used inside <OrderTicket>");
  return v;
}

/** The order ticket as a compound component: a frameless, title-less provider you wrap your own layout
 *  around, plus <OrderTicket.Entry/>, <OrderTicket.Book/> and <OrderTicket.Actions/> you place wherever
 *  the layout wants them (one card, three cards, separate grid cells — the provider shares state across
 *  them). Order placement AND the IOC taker / close-position flows all sign in-tab; `onActivity` relays
 *  each ✓/✗ result line so the host can log it. Book + taker/close are live-only; entry + submit + cancel
 *  work in both mock and live modes. */
function OrderTicket({ wallet, isLive = false, marketOptions, onActivity, children }: {
  wallet: WalletVM | null;
  isLive?: boolean;
  marketOptions: Market[];
  onActivity?: (line: string) => void;
  children: ReactNode;
}) {
  const { net } = useNetwork(); // the active network: labels the IOC/close confirm copy
  const mkt = (id: string): string => id.split(":").pop() ?? id;
  const [market, setMarket] = useState(MARKETS[0]!.id);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("63120");
  const [size, setSize] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [pending, setPending] = useState<null | "taker" | "close">(null);

  const append = (m: string) => onActivity?.(m);

  // Keep the selected market valid for the current option set (mock vs live). Idempotent: setting a
  // valid id makes the next run's guard true, so there is no loop even if marketOptions changes identity.
  useEffect(() => {
    if (!marketOptions.some((m) => m.id === market)) {
      setMarket((marketOptions.find((m) => m.id.endsWith("BTC-PERP")) ?? marketOptions[0]!).id);
    }
  }, [isLive, marketOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the selected market's order book while a LIVE ticket is mounted, and refresh it on an interval
  // (a book goes stale fast). A small debounce coalesces rapid market switches; the refresh yields when
  // the shared read budget is low so it never starves cancels/kill-switch. On a failed read we KEEP the
  // prior snapshot — the render only shows it while its market matches the selection, so a stale snapshot
  // for a previous market is never shown under the new market's header.
  useEffect(() => {
    if (!isLive || !wallet) { setBook(null); return; }
    let cancelled = false;
    const walletId = wallet.id;
    const load = () => readOrderBookLive(walletId, market, BOOK_DEPTH).then((b) => { if (!cancelled && b) setBook(b); }).catch(() => {});
    const t = setTimeout(load, 120);
    const iv = setInterval(() => { if (readBudget() > 1) void load(); }, 5_000);
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
  }, [isLive, market, wallet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      const input: PlaceOrderInput = {
        market, side, kind,
        size: size as Decimal,
        price: kind === "limit" ? (price as Decimal) : undefined,
        postOnly: kind === "limit",
        clientId: `c-${Date.now()}`,
      };
      const order: Order = await placeOrder(wallet, input);
      append(`✓ ${side} ${size} ${mkt(market)} → ${order.status} · role=${order.role} · ${String(order.venueId).slice(0, 12)}…`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      const r = await cancelOrders(wallet, { market });
      append(`✓ cancelled ${r.cancelled.length} on ${mkt(market)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doTaker = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Taker IOC signs IN-TAB → keyless relay (Stage 2a).
      const order = await placeOrderLive(wallet.id, market, { side, size, taker: true });
      append(`✓ taker ${side} ${mkt(market)} (IOC) → ${order.status} · filled ${order.filled}/${order.size} · ${String(order.venueId).slice(0, 12)}…`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Close = opposite crossing IOC, signed IN-TAB (Stage 2a).
      const r = await closePositionLive(wallet.id, market);
      append(`✓ close ${mkt(market)} — position ${r.closed} ${r.closed ? "flattening (IOC)" : "(nothing open)"}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runPending = (): void => {
    const p = pending;
    setPending(null);
    if (p === "taker") void doTaker();
    else if (p === "close") void doClose();
  };

  // The book for the CURRENT market only (a kept snapshot of a previous market is never shown), and that
  // book only when it has levels to draw — otherwise the fixed slot shows its loading/empty overlay.
  const shownBook = book && book.market === market ? book : null;
  const bookLevels = shownBook && (shownBook.bids.length > 0 || shownBook.asks.length > 0) ? shownBook : null;

  const value: OrderTicketValue = {
    market, setMarket, side, setSide, kind, setKind, size, setSize, price, setPrice,
    isLive, marketOptions, shownBook, bookLevels, busy, submit, doCancel,
    requestTaker: () => setPending("taker"), requestClose: () => setPending("close"), mkt,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={pending === "taker" ? "Taker order (IOC cross)" : "Close position"}
        body={<>
          {pending === "taker" && <>Fire a {em(side)} {em("IOC crossing")} order on {mkt(market)} — fills resting liquidity and cancels the rest, opening a position.</>}
          {pending === "close" && <>Flatten the open position on {mkt(market)} with an opposite {em("IOC")} order.</>}
        </>}
        danger={<>Real {net.networkName} order / funds move. Everything signs in this tab — the key never leaves your browser.</>}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </Ctx.Provider>
  );
}

/** Section 1 — order entry: the market dropdown, side, order type, size and (for limits) price. */
function Entry() {
  const t = useOrderTicket();
  return (
    <div className="flex flex-col gap-3">
      <Select
        label={`Market${t.isLive ? ` (live · ${t.marketOptions.length})` : ""}`}
        hideLabel={false}
        value={t.market}
        onValueChange={(v) => { if (v) t.setMarket(String(v)); }}
      >
        {t.marketOptions.map((m) => (
          <Select.Option key={m.id} value={m.id}>{t.isLive ? m.id.split(":").pop() : `${m.base}-${m.quote}`} ({m.product})</Select.Option>
        ))}
      </Select>
      <div className="flex flex-wrap gap-2">
        <ButtonGroup aria-label="Side">
          {(["buy", "sell"] as const).map((s) => (
            <Button key={s} size="sm" variant={t.side === s ? "primary" : "secondary"} aria-pressed={t.side === s} className="capitalize" onClick={() => t.setSide(s)}>{s}</Button>
          ))}
        </ButtonGroup>
        <ButtonGroup aria-label="Order type">
          {(["limit", "market"] as const).map((k) => (
            <Button key={k} size="sm" variant={t.kind === k ? "primary" : "secondary"} aria-pressed={t.kind === k} className="capitalize" onClick={() => t.setKind(k)}>{k}</Button>
          ))}
        </ButtonGroup>
      </div>
      <Grid variant="side-by-side" gap="sm">
        {/* w-full min-w-0: fill the grid track instead of the input's intrinsic size=20 width. */}
        <Input label="Size" className="w-full min-w-0" value={t.size} onChange={(e) => t.setSize(e.target.value)} />
        {t.kind === "limit" && <Input label="Price" className="w-full min-w-0" value={t.price} onChange={(e) => t.setPrice(e.target.value)} />}
      </Grid>
      {t.isLive && <Text variant="secondary" size="xs">Live: your price is used (configurability-first) and must be within the oracle 80–120% band; size clamps to the market min. Leave price blank only for a book-derived fallback.</Text>}
    </div>
  );
}

/** Section 2 — the order book for the selected market. Live-only (renders nothing in mock mode). A
 *  FIXED-HEIGHT slot: the book lands ~200ms after mount (debounce + metered relay read), and a section
 *  popping in would push whatever a consumer renders below it down mid-click, so the ladder always draws
 *  BOOK_DEPTH rows per side and a pending / stale-market / empty book overlays the same box — no book
 *  state ever changes this section's height. Each price sits alone in its element (the e2e matches it). */
function Book() {
  const t = useOrderTicket();
  if (!t.isLive) return null;
  return (
    <div className="relative">
      <Grid variant="side-by-side" gap="sm" className="font-mono" aria-hidden={!t.bookLevels || undefined}>
        <BookSide label="Bids" levels={t.bookLevels?.bids ?? []} tone="text-kumo-success" />
        <BookSide label="Asks" levels={t.bookLevels?.asks ?? []} tone="text-kumo-danger" />
      </Grid>
      {!t.bookLevels && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-kumo-subtle">
          {t.shownBook ? "No resting liquidity on this market." : <><Loader size="sm" /> Loading the order book…</>}
        </div>
      )}
    </div>
  );
}

/** Section 3 — actions: the commands fired at the venue for the selected market. Sign & submit (the maker
 *  from Entry) and Cancel on market run in both modes; Taker (IOC) and Close position are live-only and
 *  route through the provider's confirm dialog. */
function Actions() {
  const t = useOrderTicket();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" loading={t.busy} onClick={t.submit}>Sign &amp; submit</Button>
      <Button variant="secondary-destructive" onClick={t.doCancel} disabled={t.busy}>Cancel on market</Button>
      {t.isLive && <Button onClick={t.requestTaker} disabled={t.busy}>Taker (IOC)</Button>}
      {t.isLive && <Button variant="secondary-destructive" onClick={t.requestClose} disabled={t.busy}>Close position</Button>}
    </div>
  );
}

const OrderTicketCompound = Object.assign(OrderTicket, { Entry, Book, Actions });
export { OrderTicketCompound as OrderTicket };

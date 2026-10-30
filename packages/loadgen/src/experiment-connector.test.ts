// Offline skeleton gate for the base-native ExperimentConnector: a FAKE gateway + FAKE signer
// prove the wiring of OrderIdentityCache (idempotent prepare) + the OrderLedger (no-double-
// place) + classifyDispatch (halt vs drop-one). No funds, no live network. The LIVE Nado read
// path (authoritative per-order fill / A-5) and the real classify code table are the testnet
// gate (docs/phasea-testnet-validation.md) and are injected here as seams.
import { describe, expect, it, vi } from "vitest";
import { InMemoryOperationsStore, type ExperimentCampaign, type ExperimentPair, type ExperimentOrderRequest, type ExperimentOrder } from "@farm/core";
import type { NadoGateway } from "@farm/adapter-nado";
import type { WalletSigner } from "@farm/adapter-api";
import { NadoExperimentConnector, defaultNormaliseError, type OrderFillSource, type EquitySource } from "./experiment-connector.js";
import { classifyDispatch } from "./classify.js";

const address = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const A = address(1), B = address(2);

function campaign(over: Partial<ExperimentCampaign> = {}): ExperimentCampaign {
  return { id: "c", chainId: 763373, mode: "LIVE", productId: 2, orderNotionalX18: "1000000000000000000000",
    targetNotionalPerWalletX18: "2000000000000000000000", slippageBps: 10, state: "RUNNING", epoch: 0,
    createdAt: 0, updatedAt: 0, activeGroup: 0, groups: [{ id: "g1", pairs: [pair()] }], wallets: {},
    rollovers: [], exitRequested: false, ...over } as ExperimentCampaign;
}
const pair = (): ExperimentPair => ({ id: "p1", a: A, b: B, state: "ACTIVE", rounds: [] });
const request = (over: Partial<ExperimentOrderRequest> = {}): ExperimentOrderRequest =>
  ({ id: "experiment:c:p1:1:A_OPEN:1", role: "A_OPEN", owner: A, side: "BUY", postOnly: true, reduceOnly: false, ...over });

type SubmitResult = { digest: string; status: string; raw: unknown };
function makeDeps(opts: { onSubmit?: (s: unknown) => SubmitResult; fill?: OrderFillSource; book?: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }; makerHeadroomTicks?: number; equityFor?: EquitySource; positions?: { side: "long" | "short"; size: string }[] } = {}) {
  let bookReads = 0;
  const gateway = {
    // Default book has a >=2-tick spread (100/103) so A's open maker has a fresh strictly-better
    // EMPTY tick to rest at; a 1-tick spread now SKIPS the round (EXPERIMENT_NO_EMPTY_TICK, §2).
    async getOrderBook() { bookReads++; return { market: "nado:perp:BTC-PERP", bids: opts.book?.bids ?? [{ price: "100", size: "10" }], asks: opts.book?.asks ?? [{ price: "103", size: "10" }], ts: 0, raw: null } as never; },
    async submitOrder(signed: unknown) { return (opts.onSubmit ?? (() => ({ digest: "0x" + "d".repeat(64), status: "open", raw: {} })))(signed); },
    async cancelOrders() { return { cancelled: [], raw: {} }; },
    async getPositions() { return (opts.positions ?? []) as never; },
    async getOpenOrders() { return []; },
    async getMarkets() { return []; },
    async getFills() { return []; },
    async getBalances() { return []; },
  } as unknown as NadoGateway;
  const signer: WalletSigner = { address: A as unknown as WalletSigner["address"], signTypedData: async () => ("0x" + "ab".repeat(32) + "1b") as `0x${string}`, signMessage: async () => "0x" as `0x${string}`, signBytes: async () => new Uint8Array() };
  const store = new InMemoryOperationsStore<ExperimentCampaign>();
  const fill: OrderFillSource = opts.fill ?? (async () => undefined);
  const conn = new NadoExperimentConnector({
    chainId: 763373, endpoint: address(99), forOwner: () => gateway, signerFor: () => signer,
    sizingFor: () => ({ tickSize: "1", stepSize: "0.001", minSize: "0.001", minNotional: "100" }),
    clock: () => 1_000_000_000_000, marketIdFor: () => "nado:perp:BTC-PERP", orderFill: fill,
    equityFor: opts.equityFor, admit: () => {}, store, makerHeadroomTicks: opts.makerHeadroomTicks,
  });
  return { conn, store, gateway, get bookReads() { return bookReads; } };
}

describe("NadoExperimentConnector skeleton (fake gateway)", () => {
  it("prepare is idempotent: a retried request.id rebuilds the byte-identical order (reads the book once)", async () => {
    const d = makeDeps();
    const c = campaign();
    const first = await d.conn.prepare(c, pair(), request());
    const retry = await d.conn.prepare(c, pair(), request());
    expect(d.bookReads).toBe(1);                 // the book/price is resolved ONCE per request.id
    expect(retry.digest).toBe(first.digest);     // same digest ⇒ sequencer dedups a resend
    expect([retry.nonce, retry.expiration, retry.priceX18, retry.quantityX18]).toEqual([first.nonce, first.expiration, first.priceX18, first.quantityX18]);
    expect(first.postOnly).toBe(true);           // A_OPEN rests as a maker
    expect(/^0x[0-9a-f]{64}$/.test(first.digest)).toBe(true);
  });

  it("the deeper post-only maker rests inside the opposite touch with headroom, and still improves its near touch", async () => {
    // Wide 10-tick book (bid 100 / ask 110, tick 1). A deeper maker (larger makerHeadroomTicks)
    // rests further from the opposite touch so it survives a tighten, while staying inside the
    // book so the self-cross taker crosses it, not resting external liquidity.
    const book = { bids: [{ price: "100", size: "10" }], asks: [{ price: "110", size: "10" }] };
    const c = campaign();
    const buy = async (h: number) => (await makeDeps({ book, makerHeadroomTicks: h }).conn.prepare(c, pair(), request({ side: "BUY" }))).priceX18;
    const sell = async (h: number) => (await makeDeps({ book, makerHeadroomTicks: h }).conn.prepare(c, pair(), request({ id: "experiment:c:p1:1:B_CLOSE:1", side: "SELL", postOnly: true, reduceOnly: true }))).priceX18;
    const [b1, b3] = [await buy(1), await buy(3)];
    const [s1, s3] = [await sell(1), await sell(3)];
    // A deeper BUY maker sits LOWER (further below the ask = more headroom); a deeper SELL maker sits HIGHER.
    expect(BigInt(b3)).toBeLessThan(BigInt(b1));
    expect(BigInt(s3)).toBeGreaterThan(BigInt(s1));
    // All rest strictly inside the 100/110 book — never at/through a touch (would cross → 2008).
    const x18 = (p: number) => BigInt(p) * 10n ** 18n;
    for (const p of [b1, b3, s1, s3]) { expect(BigInt(p)).toBeGreaterThan(x18(100)); expect(BigInt(p)).toBeLessThan(x18(110)); }
    // Headroom 3 on a 10-tick spread: BUY rests 3 ticks below the ask (107); SELL 3 above the bid (103).
    expect(BigInt(b3)).toBe(x18(107)); expect(BigInt(s3)).toBe(x18(103));
  });

  it("A's open maker SKIPS the round (EXPERIMENT_NO_EMPTY_TICK) when the spread has no strictly-better tick", async () => {
    // 1-tick spread (100/101): there is NO tick strictly inside, so A cannot post a fresh,
    // strictly-better, empty tick without joining a touch → skip the round (§2). Models the live
    // book collapsing between market selection and A's prepare (the testnet ASTER incident).
    const d = makeDeps({ book: { bids: [{ price: "100", size: "10" }], asks: [{ price: "101", size: "10" }] } });
    await expect(d.conn.prepare(campaign(), pair(), request())).rejects.toMatchObject({ notSubmitted: true, message: "EXPERIMENT_NO_EMPTY_TICK" });
  });

  it("A's open maker skips an OCCUPIED inside tick and rests at the nearest empty one (sole order at its price)", async () => {
    // Preferred tick (headroom 3 → ask−3 = 107) carries an external order; A steps one tick nearer
    // the touch to 106 — still strictly inside, and now alone at its price.
    const book = { bids: [{ price: "100", size: "10" }, { price: "107", size: "5" }], asks: [{ price: "110", size: "10" }] };
    const prepared = await makeDeps({ book, makerHeadroomTicks: 3 }).conn.prepare(campaign(), pair(), request({ side: "BUY" }));
    expect(BigInt(prepared.priceX18)).toBe(106n * 10n ** 18n);
  });

  it("B's open taker is HARD-limited to exactly A's price (no slippage, cannot sweep past A)", async () => {
    // A rests at 105; B's BUY taker is hard-limited to 105, NOT the slippage-swept best ask (110+),
    // so it can cross only A and never reaches higher external asks (§2 — bind B to A's price).
    const d = makeDeps({ book: { bids: [{ price: "100", size: "10" }], asks: [{ price: "110", size: "10" }] } });
    const aPriceX18 = (105n * 10n ** 18n).toString();
    const prepared = await d.conn.prepare(campaign(), pair(), request({
      id: "experiment:c:p1:1:B_OPEN:1", role: "B_OPEN", side: "BUY", postOnly: false, reduceOnly: false,
      quantityX18: "1000000000000000000", limitPriceX18: aPriceX18,
    }));
    expect(prepared.priceX18).toBe(aPriceX18);   // exactly A's price
    expect(prepared.postOnly).toBe(false);        // a taker (IOC), hard-limited
  });

  it("dispatch routes through the ledger and returns the digest on ACK", async () => {
    const d = makeDeps();
    const c = campaign();
    const prepared = await d.conn.prepare(c, pair(), request());
    // The sequencer echoes the order's digest; the ledger verifies it matches before ACK.
    (d.gateway as unknown as { submitOrder: unknown }).submitOrder = async () => ({ digest: prepared.digest, status: "open", raw: {} });
    await d.conn.ledger.enable();
    const digest = await d.conn.dispatch(c, prepared, () => true);
    expect(digest).toBe(prepared.digest);
  });

  it("classifies a transport abort as not-sent (ABORTED_UNSENT, no halt)", async () => {
    const d = makeDeps({ onSubmit: () => { throw new Error("connect ECONNREFUSED 1.2.3.4:443"); } }); // provably pre-send
    const c = campaign();
    const prepared = await d.conn.prepare(c, pair(), request());
    await d.conn.ledger.enable();
    await expect(d.conn.dispatch(c, prepared, () => true)).rejects.toMatchObject({ notSubmitted: true });
    expect(d.conn.ledger.halted).toBe(false); // one order dropped; the desk is NOT halted
  });

  it("classifies a market-state refusal (2006) as a one-order refusal, not a fatal halt", async () => {
    const d = makeDeps({ onSubmit: () => { throw Object.assign(new Error("margin too low"), { nadoCode: 2006 }); } });
    const c = campaign();
    const prepared = await d.conn.prepare(c, pair(), request());
    await d.conn.ledger.enable();
    await expect(d.conn.dispatch(c, prepared, () => true)).rejects.toThrow("ORDER_REFUSED_2006");
    expect(d.conn.ledger.halted).toBe(false);
  });

  it("treats a deduped retry (2013) as placed — returns the digest, no double place", async () => {
    const d = makeDeps({ onSubmit: () => { throw Object.assign(new Error("digest already exists"), { nadoCode: 2013 }); } });
    const c = campaign();
    const prepared = await d.conn.prepare(c, pair(), request());
    await d.conn.ledger.enable();
    const digest = await d.conn.dispatch(c, prepared, () => true);
    expect(digest).toBe(prepared.digest);
  });

  it("refuses to send when the coordinator's allowed() is already false (ABORTED_UNSENT)", async () => {
    const d = makeDeps();
    const c = campaign();
    const prepared = await d.conn.prepare(c, pair(), request());
    await d.conn.ledger.enable();
    await expect(d.conn.dispatch(c, prepared, () => false)).rejects.toMatchObject({ notSubmitted: true });
  });

  it("lookup maps the injected (A-5) fill source to an ExperimentOrderFact", async () => {
    const d = makeDeps({ fill: async () => ({ filledX18: "5", quoteFilledX18: "50", feePaidX18: "1", terminal: true, resting: false }) });
    const c = campaign();
    const order = { digest: "0x" + "e".repeat(64), owner: A, productId: 2, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0" } as unknown as ExperimentOrder;
    const fact = await d.conn.lookup(c, order);
    expect(fact).toMatchObject({ known: true, terminal: true, filledX18: "5", identityMatches: true });
  });

  it("preflight maps positions + open orders to a pair snapshot", async () => {
    const d = makeDeps();
    const snap = await d.conn.preflight(campaign(), pair());
    expect(snap.complete).toBe(true);
    expect(snap.a.owner).toBe(A);
    expect(snap.a.positionX18).toBe("0");
    expect(snap.a.openDigests).toEqual([]);
  });

  it("with NO equityFor injected, preflight equity is the inert placeholder (offline/benchmark path)", async () => {
    const snap = await makeDeps().conn.preflight(campaign(), pair());
    expect(snap.a.equityX18).toBe("100000000000000000000000");
    expect(snap.b.equityX18).toBe("100000000000000000000000");
  });

  it("with an injected equityFor, preflight carries the REAL per-wallet equity (the maxLoss input)", async () => {
    // Distinct equity per owner proves the source is consulted per wallet, not a shared constant.
    const equityFor: EquitySource = async (owner) => (owner === A ? "9000000000000000000" : "7000000000000000000");
    const snap = await makeDeps({ equityFor }).conn.preflight(campaign(), pair());
    expect(snap.a.equityX18).toBe("9000000000000000000");
    expect(snap.b.equityX18).toBe("7000000000000000000");
  });

  it("a null equityFor result flows through as null (blocks new risk; core keeps the flat baseline)", async () => {
    const snap = await makeDeps({ equityFor: async () => null }).conn.preflight(campaign(), pair());
    expect(snap.a.equityX18).toBeNull();
    expect(snap.b.equityX18).toBeNull();
  });
});

describe("defaultNormaliseError — pre-send classification safety (never not-sent on ambiguity)", () => {
  it("maps ONLY provably pre-send connect failures to transportAborted", () => {
    expect(defaultNormaliseError({ message: "connect ECONNREFUSED 1.2.3.4:443" }).transportAborted).toBe(true);
    expect(defaultNormaliseError({ message: "getaddrinfo ENOTFOUND api.test.nado.xyz" }).transportAborted).toBe(true);
    expect(defaultNormaliseError({ transportAborted: true }).transportAborted).toBe(true); // explicit live marker
  });

  it("keeps post-send-capable errnos and a bare AbortError as UNKNOWN (not not-sent)", () => {
    for (const errno of ["ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
      const info = defaultNormaliseError({ message: `socket ${errno} after write` });
      expect(info.transportAborted, errno).toBe(false);
      expect(classifyDispatch(info).kind, errno).toBe("unknown");
    }
    expect(classifyDispatch(defaultNormaliseError({ name: "AbortError", message: "The operation was aborted" })).kind).toBe("unknown");
  });

  it("does NOT mine a bare number from free text (no phantom deduped/placement)", () => {
    // A stray number must not be read as a sequencer code (a false 2013 → phantom placement).
    expect(defaultNormaliseError({ message: "waited 2013ms then the socket hung up" }).nadoCode).toBeUndefined();
    expect(classifyDispatch(defaultNormaliseError({ message: "waited 2013ms then the socket hung up" })).kind).toBe("unknown");
    // A code-TAGGED token (or a structured field) IS read.
    expect(defaultNormaliseError({ message: "engine error code: 2006 (margin)" }).nadoCode).toBe(2006);
    expect(defaultNormaliseError({ nadoCode: 2013 }).nadoCode).toBe(2013);
  });

  it("never sets transportAborted alongside a structured code — a real fatal is not masked", () => {
    const info = defaultNormaliseError({ nadoCode: 2095, message: "looks like ECONNREFUSED but carries code 2095" });
    expect(info.transportAborted).toBe(false);
    expect(classifyDispatch(info).kind).toBe("rejected-fatal");
  });
});

describe("defaultNormaliseError — the REAL adapter/transport error shapes (testnet-gate confirmed)", () => {
  // The two concrete shapes the live stack throws (live-gateway assertOk / core MeteredTransport).
  it("sequencer refusal AdapterError: code lives at raw.error_code (status is the STRING failure)", () => {
    const info = defaultNormaliseError({ category: "rejected", message: "sequencer 2007: price band", raw: { status: "failure", error_code: 2007 } });
    expect(info.nadoCode).toBe(2007);
    expect(info.httpStatus).toBeUndefined();          // H1: "failure" string must NOT become an httpStatus
    expect(classifyDispatch(info)).toEqual({ kind: "refused", code: "2007" });
  });

  it("a stringified error_code is read (dedup 2013 → placed), not free-text mined", () => {
    const info = defaultNormaliseError({ category: "rejected", message: "sequencer 2013: digest exists", raw: { status: "failure", error_code: "2013" } });
    expect(info.nadoCode).toBe(2013);
    expect(classifyDispatch(info).kind).toBe("deduped");
  });

  it("transport 403 (edge/WAF block) → not-sent, never unknown", () => {
    const info = defaultNormaliseError({ category: "rejected", message: "HTTP 403", code: "403", raw: { status: 403 } });
    expect(info.nadoCode).toBeUndefined();            // H3: "403" is an HTTP status, not a venue code
    expect(info.httpStatus).toBe(403);
    expect(classifyDispatch(info).kind).toBe("not-sent");
  });

  it("transport 429 → not-sent (rate limited), not mistaken for a nadoCode", () => {
    const info = defaultNormaliseError({ category: "rate-limited", message: "HTTP 429", code: "429", retryAfterMs: 2000, raw: { status: 429 } });
    expect(info.nadoCode).toBeUndefined();
    expect(info.httpStatus).toBe(429);
    expect(classifyDispatch(info)).toEqual({ kind: "not-sent", code: "RATE_LIMITED" });
  });

  it("transport 5xx → unknown (maybe placed → halt)", () => {
    const info = defaultNormaliseError({ category: "retryable-unsafe", message: "HTTP 502", code: "502", raw: { status: 502 } });
    expect(info.nadoCode).toBeUndefined();
    expect(info.httpStatus).toBe(502);
    expect(classifyDispatch(info).kind).toBe("unknown");
  });

  it("H2: a code-tagged token in a NETWORK/relay error's free text is NOT mined (no phantom dedup)", () => {
    const info = defaultNormaliseError({ category: "network", message: "relay/sequencer error: upstream code: 2013", raw: { error: "bad gateway" } });
    expect(info.nadoCode).toBeUndefined();            // would otherwise fabricate a deduped=placed
    expect(classifyDispatch(info).kind).toBe("unknown");
  });

  it("H3: a 4-digit numeric-string code IS read as a venue code (future gateway honoring AdapterError.code)", () => {
    const info = defaultNormaliseError({ category: "rejected", message: "refused", code: "2094" });
    expect(info.nadoCode).toBe(2094);
    expect(classifyDispatch(info).kind).toBe("refused");
  });
});

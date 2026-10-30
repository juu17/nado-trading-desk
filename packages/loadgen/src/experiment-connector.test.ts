// Offline skeleton gate for the base-native ExperimentConnector: a FAKE gateway + FAKE signer
// prove the wiring of OrderIdentityCache (idempotent prepare) + the OrderLedger (no-double-
// place) + classifyDispatch (halt vs drop-one). No funds, no live network. The LIVE Nado read
// path (authoritative per-order fill / A-5) and the real classify code table are the testnet
// gate (docs/phasea-testnet-validation.md) and are injected here as seams.
import { describe, expect, it, vi } from "vitest";
import { InMemoryOperationsStore, type ExperimentCampaign, type ExperimentPair, type ExperimentOrderRequest, type ExperimentOrder } from "@farm/core";
import type { NadoGateway } from "@farm/adapter-nado";
import type { WalletSigner } from "@farm/adapter-api";
import { NadoExperimentConnector, defaultNormaliseError, type OrderFillSource } from "./experiment-connector.js";
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
function makeDeps(opts: { onSubmit?: (s: unknown) => SubmitResult; fill?: OrderFillSource } = {}) {
  let bookReads = 0;
  const gateway = {
    async getOrderBook() { bookReads++; return { market: "nado:perp:BTC-PERP", bids: [{ price: "100", size: "10" }], asks: [{ price: "101", size: "10" }], ts: 0, raw: null } as never; },
    async submitOrder(signed: unknown) { return (opts.onSubmit ?? (() => ({ digest: "0x" + "d".repeat(64), status: "open", raw: {} })))(signed); },
    async cancelOrders() { return { cancelled: [], raw: {} }; },
    async getPositions() { return []; },
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
    admit: () => {}, store,
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

// =============================================================================
// @farm/core · funding/order-ledger — the single-dispatch order state machine, the
// no-double-place kernel of the capacity engine. Ported from lucklab 1.4.3 with the
// Phase-0 adaptations (every behavioural invariant of the fault path preserved):
//
//  • The circular `../experiment/guards.js` edge is CUT: experiment order-admission
//    is now an INJECTED `admit` hook (default no-op). Phase A wires
//    experiment/guards.assertExperimentOrderAdmission in — no core→experiment import.
//  • 🎯 PER-WALLET re-scope: the admission concurrency gate (the scan that "caps
//    concurrency at 1" by refusing a new order while ANY order is UNKNOWN/DISPATCHED)
//    is scoped to the order's OWNER. N wallets therefore keep N concurrent in-flight
//    dispatches on the happy path — the density unlock. Per-order writes run on the
//    store's per-owner lane (updateOwner) when available.
//  • Ink chain-id de-pinned: `chainId` is a required plain number (the adapter
//    supplies Ink's value), not a 763373 default.
//  • The dropped hedgeRules/hedgeTickets fields are no longer referenced.
//
// NOTE (Phase-A seam, surfaced to the user): a GENUINE fault (UNKNOWN send / lookup
// failure / mismatching ACK / fatal reject) still trips the GLOBAL trading halt
// (`tradingStopped`), exactly as the port. That is a density ceiling under faulty
// load, but its correct per-wallet form is entangled with the experiment
// coordinator's recovery (Phase A), so it is deliberately preserved here rather than
// re-invented without its consumer. "UNKNOWN != didn't place" is preserved: an
// ambiguous order stays UNKNOWN (never silently cleared) until positively reconciled.
//
// 🚨 INVARIANT the per-owner re-scope relies on — order `id` MUST be globally unique
// (the engine namespaces ids by wallet/campaign, e.g. `<account>:<n>` or
// `experiment:<id>:...`). Over the sharded store the prior-by-id idempotency lookup in
// submit() and reconcile()'s by-id lookup see only ONE owner's shard, so a SAME id
// reused across two owners would escape the submit refuse (the port scanned globally)
// and later trip journal.ts's global id-uniqueness guard at persist (fail-closed: a
// loud JOURNAL_DAMAGED, never a silent double-fill). journal.ts is the enforcement
// backstop; restoring a clean submit-time refuse would need a global id index on the
// store (a Phase-A follow-up, only if the id scheme can't guarantee owner-namespacing).
// =============================================================================
import {
  owner,
  rawAmount,
  refuse,
  type DeskOperations,
  type ExperimentCampaignSlot,
  type OperationsStore,
  type ProtectedOrder,
  type ShardedOperationsStore,
} from "./types.js";
import { assertWalletPlanOwner } from "./wallet-use-plan.js";

export interface OrderEvidence {
  digest: string;
  owner: string;
  productId: number;
  quantityX18: string;
  filledX18: string;
  known: boolean;
}
/** The exchange answered with an explicit failure: the order was never placed.
 *  `fatal` (malformed or mis-signed requests) also stops all trading for review; a
 *  market-state refusal (post-only would cross, IOC did not cross, health) only ends
 *  this one order. */
export class KnownOrderRejection extends Error {
  constructor(readonly rejectionCode: number, readonly fatal = true) {
    // Distinct codes: ORDER_REJECTED_n stopped all trading, ORDER_REFUSED_n ended one order.
    super((fatal ? "ORDER_REJECTED_" : "ORDER_REFUSED_") + rejectionCode);
  }
}
/** Trusted local connector evidence: its external order-send callback was never
 * entered. A timeout, a plain STOPPED error, or a remote message is not this proof. */
export class KnownOrderNotSent extends Error {
  readonly reason: string;
  constructor(reason: string) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(reason) ? reason : "LOCAL_PREFLIGHT_REJECTED";
    super("ORDER_NOT_SENT_" + code); this.reason = code;
  }
}
/** Only the authenticated ledger's explicit new no-I/O result has this meaning.
 * Legacy UNKNOWN/rejection text and a bare cleared flag remain insufficient. */
export function knownOrderNotSentReason(row: Pick<ProtectedOrder, "state" | "filledX18" | "cleared" | "payload" | "errorCode">): string | undefined {
  if (row.state !== "REJECTED" || row.filledX18 !== "0" || row.cleared !== true || row.payload !== "") return undefined;
  return /^ORDER_NOT_SENT_([A-Z][A-Z0-9_]{0,79})$/.exec(row.errorCode ?? "")?.[1];
}
export interface ProtectedOrderConnector {
  dispatch(order: ProtectedOrder, allowed: () => boolean): Promise<string>;
  lookup(order: ProtectedOrder): Promise<OrderEvidence>;
}
/** Experiment order-admission hook — the Phase-A seam that replaces the cut
 *  `../experiment/guards.js` import. Default no-op (no experiments). Phase A injects
 *  the real guard so ordinary writes cannot borrow an experiment's wallet/identity. */
export type OrderAdmission<C extends ExperimentCampaignSlot = ExperimentCampaignSlot> = (
  state: DeskOperations<C>,
  input: Omit<ProtectedOrder, "state" | "filledX18" | "createdAt">,
) => void;

export class OrderLedger<C extends ExperimentCampaignSlot = ExperimentCampaignSlot> {
  private stopped = true;
  private generation = 0;
  constructor(
    private readonly store: OperationsStore<C>,
    private readonly connector: ProtectedOrderConnector,
    private readonly chainId: number,
    private readonly admit: OrderAdmission<C> = () => {},
  ) {}

  /** Per-owner store lane when the store supports it (density); else the global lane
   *  — the per-wallet admission filter below holds either way. */
  private perOwner<T>(ownerAddr: string, fn: (s: DeskOperations<C>) => T): Promise<T> {
    const sharded = this.store as Partial<ShardedOperationsStore<C>>;
    return sharded.updateOwner ? sharded.updateOwner(ownerAddr, fn) : this.store.update(fn);
  }

  /** Whether new orders are refused right now (after a stop or an unknown send). */
  get halted(): boolean { return this.stopped; }
  stop() {
    this.stopped = true;
    this.generation++;
    return this.store.update((s) => {
      s.tradingStopped = true;
    });
  }
  async enable() {
    const generation = this.generation;
    await this.store.update((s) => {
      if (
        s.orders.some((o) => o.state === "UNKNOWN" || o.state === "DISPATCHED")
      )
        refuse("UNRESOLVED_ORDER");
      s.tradingStopped = false;
    });
    if (generation !== this.generation) refuse("STOPPED_DURING_ENABLE");
    this.stopped = false;
    this.generation++;
  }
  async prior(id: string) {
    return (await this.store.read()).orders.find((o) => o.id === id);
  }
  async submit(
    input: Omit<ProtectedOrder, "state" | "filledX18" | "createdAt">,
  ): Promise<ProtectedOrder> {
    if (this.stopped) refuse("TRADING_STOPPED");
    const generation = this.generation;
    if (
      input.chainId !== this.chainId ||
      owner(input.owner) !== input.owner ||
      !/^0x[0-9a-f]{64}$/.test(input.digest) ||
      !input.id ||
      !input.payload ||
      !Number.isSafeInteger(input.productId) ||
      input.productId <= 0 ||
      !Number.isSafeInteger(input.expiration)
    )
      refuse("INVALID_ORDER_INTENT");
    rawAmount(input.quantityX18, true);
    rawAmount(input.priceX18, true);
    rawAmount(input.nonce);
    const claim = await this.perOwner(input.owner, (s) => {
      this.admit(s, input);
      if (s.tradingStopped) refuse("TRADING_STOPPED");
      assertWalletPlanOwner(s, input.owner);
      const prior = s.orders.find((o) => o.id === input.id);
      if (prior) {
        if (
          prior.digest !== input.digest ||
          prior.owner !== input.owner ||
          prior.productId !== input.productId
        )
          refuse("ORDER_INTENT_CONFLICT");
        return { send: false, row: prior };
      }
      // 🎯 PER-WALLET admission gate (was a GLOBAL store scan capping concurrency at
      // 1): only THIS owner's in-flight orders block a new one, so other wallets keep
      // dispatching concurrently.
      if (
        s.orders.some(
          (o) =>
            o.owner === input.owner &&
            (o.state === "UNKNOWN" || o.state === "DISPATCHED"),
        )
      )
        refuse("UNRESOLVED_ORDER");
      // Over the sharded store this digest/nonce scan is per-owner (was global in the
      // port). Benign: the EIP-712 order digest binds the owner, so two owners cannot
      // collide on a correctly-formed digest; the nonce clause was already per-owner.
      // A digest-construction bug would surface at the sequencer's digest-dedup, not here.
      if (
        s.orders.some(
          (o) =>
            o.digest === input.digest ||
            (o.owner === input.owner && o.nonce === input.nonce),
        )
      )
        refuse("ORDER_DIGEST_OR_NONCE_RESERVED");
      const row: ProtectedOrder = {
        ...input,
        state: "DISPATCHED",
        filledX18: "0",
        createdAt: Date.now(),
      };
      s.orders.push(row);
      return { send: true, row };
    });
    if (!claim.send)
      return ["ACKED", "REJECTED"].includes(claim.row.state)
        ? claim.row
        : this.reconcile(input.id);
    const allowed = () => !this.stopped && generation === this.generation;
    if (!allowed()) return this.notSent(input, "STOPPED_AFTER_ORDER_CLAIM");
    try {
      if (
        (await this.connector.dispatch(claim.row, allowed)).toLowerCase() !==
        input.digest
      )
        return this.unknown(input.id, "ORDER_ACK_MISMATCH");
    } catch (e) {
      if (e instanceof KnownOrderNotSent) return this.notSent(input, e.reason);
      if (e instanceof KnownOrderRejection) {
        if (e.fatal) {
          this.stopped = true;
          this.generation++;
        }
        return this.store.update((s) => {
          if (e.fatal) s.tradingStopped = true;
          const row = s.orders.find((o) => o.id === input.id)!;
          // A query/observed fill can prove acceptance before this old response
          // arrives. Never replace that execution with a zero-fill rejection.
          // A contradictory fatal reply still stops and is surfaced for review.
          if (row.state === "ACKED") {
            if (e.fatal) row.errorCode = "ORDER_ACK_REJECTION_CONFLICT_" + e.rejectionCode;
            return { ...row };
          }
          row.state = "REJECTED";
          row.payload = "";
          row.errorCode = e.message;
          row.cleared = true;
          return { ...row };
        });
      }
      return this.unknown(input.id, "ORDER_RESULT_UNKNOWN", true);
    }
    return this.perOwner(input.owner, (s) => {
      const row = s.orders.find((o) => o.id === input.id)!;
      row.state = "ACKED";
      row.payload = "";
      row.errorCode = undefined;
      return { ...row };
    });
  }
  private async notSent(input: Omit<ProtectedOrder, "state" | "filledX18" | "createdAt">, reason: string) {
    const proof = new KnownOrderNotSent(reason);
    return this.perOwner(input.owner, s => {
      const row = s.orders.find(o => o.id === input.id);
      if (!row || !["DISPATCHED", "UNKNOWN"].includes(row.state) || row.filledX18 !== "0" ||
          row.digest !== input.digest || row.owner !== input.owner || row.chainId !== input.chainId || row.productId !== input.productId ||
          row.nonce !== input.nonce || row.side !== input.side || row.quantityX18 !== input.quantityX18 || row.priceX18 !== input.priceX18 ||
          row.expiration !== input.expiration || row.payload !== input.payload) refuse("ORDER_NOT_SENT_PROOF_CONFLICT");
      row.state = "REJECTED"; row.cleared = true; row.payload = ""; row.errorCode = proof.message;
      // Stop/trading permission is untouched; the original nonce remains reserved.
      return { ...row };
    });
  }
  private async unknown(id: string, errorCode: string, submissionResponse = false) {
    // Current read failures and mismatching ACKs retain immediate revocation.
    // A late lost submission response has no new uncertainty once this original
    // is positively ACKed. Until then its durable DISPATCHED/UNKNOWN row already
    // prevents another claim; decide against the writer's current snapshot.
    // An UNKNOWN trips the GLOBAL halt (preserved from the port); its orders scan
    // is global here (the global lane), honoring "UNKNOWN != didn't place".
    if (!submissionResponse) { this.stopped = true; this.generation++; }
    return this.store.update((s) => {
      const row = s.orders.find((o) => o.id === id);
      if (submissionResponse && row?.state === "ACKED") return { ...row };
      if (submissionResponse) { this.stopped = true; this.generation++; }
      s.tradingStopped = true;
      if (!row) refuse("ORDER_INTENT_MISSING");
      if (row.state !== "ACKED") {
        row.state = "UNKNOWN";
        row.errorCode = errorCode;
      }
      return { ...row };
    });
  }
  async reconcile(id: string) {
    const row = await this.prior(id);
    if (!row) refuse("ORDER_INTENT_MISSING");
    // The passive helper owns recovery of a reserved but not dispatched close.
    // Its durable count-zero intent stays blocking and never becomes an ACK here.
    if (row.state === "REJECTED" || (row.purpose === "RISK_CLOSE" && row.dispatchCount === 0)) return row;
    let fact: OrderEvidence;
    try {
      fact = await this.connector.lookup(row);
    } catch {
      return this.unknown(id, "ORDER_LOOKUP_FAILED");
    }
    if (!fact.known) return this.unknown(id, "ORDER_NOT_YET_PROVEN");
    if (
      fact.digest !== row.digest ||
      fact.owner !== row.owner ||
      fact.productId !== row.productId ||
      fact.quantityX18 !== row.quantityX18
    )
      return this.unknown(id, "ORDER_LOOKUP_IDENTITY_MISMATCH");
    const filled = rawAmount(fact.filledX18);
    if (filled > BigInt(row.quantityX18) || filled < BigInt(row.filledX18))
      return this.unknown(id, "ORDER_FILL_INVALID");
    return this.perOwner(row.owner, (s) => {
      const current = s.orders.find((o) => o.id === id)!;
      current.state = "ACKED";
      current.payload = "";
      current.filledX18 = String(filled);
      current.errorCode = undefined;
      return { ...current };
    });
  }
  async recover() {
    this.stopped = true;
    this.generation++;
    await this.store.update((s) => {
      s.tradingStopped = true;
      for (const o of s.orders)
        if (o.state === "DISPATCHED") o.state = "UNKNOWN";
    });
  }
}

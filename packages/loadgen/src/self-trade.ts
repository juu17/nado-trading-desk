// =============================================================================
// @farm/loadgen · self-trade — the self-trade-prevention (STP) policy (Phase B-2, decision #2).
//
// The benchmark runs ONE market with many self-crossing pairs. Within a pair the A↔B cross IS
// the fill mechanism (decision #2) and MUST be permitted — `selfTradePrevention: "none"` is set
// on the signed order so the exchange does not auto-cancel it. But in a single shared book a
// pair's taker, crossing the best price, can accidentally cross a resting maker belonging to a
// DIFFERENT pair. That UNINTENDED cross-pair self-match fills the taker against the wrong
// counterparty and strands both pairs' hedge accounting (pair X's B has nothing left to cross;
// pair Y's A is now half-filled by a stranger), so it corrupts both the positions and the
// measured matched fills.
//
// This policy tracks the campaign's live resting makers in the one market and, before a taker
// goes in, reports the OTHER pairs' resting makers it would cross — the collisions to cancel
// first, so the taker reaches only its own pair-mate. It exposes `own_conflict_cancel` (how
// often a pair had to withdraw another pair's maker) as an observability metric. The intended
// same-pair cross is NEVER reported.
//
// Harness-native: re-derived from the intern's live `cancelOwnConflicts`
// (apps/console/app/lib/experimentConnector.ts) without folding its console/projection plumbing.
// Pure + deterministic; the actual cancels execute through the connector's cancel seam (the
// caller loops conflicts() → cancel → recordConflictCancel). Whether Nado even applies an
// account-group STP to two DISTINCT wallets is a LIVE question deferred to the testnet gate
// (docs/phasea-testnet-validation.md §4); this policy guards the cross-PAIR case regardless.
// =============================================================================
import type { ExperimentSide } from "@farm/core";

/** A resting maker the harness has live in the one market. Keyed by its EIP-712 digest. */
export interface RestingMaker {
  digest: string;
  /** The pair that owns this maker. Same pairId as a taker ⇒ the INTENDED cross. */
  pairId: string;
  /** The wallet that signed it (A and B of a pair are distinct wallets). */
  owner: string;
  side: ExperimentSide;
  /** Resting price, X18 decimal-integer string (bigint-parseable). */
  priceX18: string;
}

/** A taker about to cross. Its own pair-mate maker is the intended target; makers of OTHER
 *  pairs it would cross are the unintended collisions. */
export interface CrossCandidate {
  pairId: string;
  side: ExperimentSide;
  priceX18: string;
}

export interface OwnTradeMetrics {
  /** How many of OTHER pairs' resting makers this run had to withdraw to protect an intended
   *  cross (the `own_conflict_cancel` count; single market ⇒ one counter per run). */
  ownConflictCancel: number;
  /** Of those, how many had ALREADY (partly) filled when withdrawn — a cross-pair self-match
   *  that actually happened, not merely one prevented. */
  ownConflictFilled: number;
  /** Resting makers currently tracked. */
  restingMakers: number;
}

/** The outcome of cancelling one conflicting maker, from the connector's cancel seam. */
export interface ConflictCancelOutcome {
  /** The maker is no longer resting (cancelled, or it filled before the cancel landed). */
  removed: boolean;
  /** It had (partly) filled when withdrawn — the unintended cross partly happened. */
  filled: boolean;
}

const PRICE_RE = /^(0|[1-9][0-9]*)$/;
function priceOf(label: string, priceX18: string): bigint {
  if (typeof priceX18 !== "string" || !PRICE_RE.test(priceX18)) throw new Error(`SELF_TRADE_${label}_PRICE_INVALID`);
  return BigInt(priceX18);
}

/**
 * Tracks one market's resting makers and classifies crosses as intended (same pair, permitted)
 * or own-conflict (cross-pair, to cancel). Construct ONE per run (single market, decision #2);
 * for a second market use a second registry.
 */
export class OwnTradeRegistry {
  private readonly makers = new Map<string, RestingMaker>();
  private conflictCancels = 0;
  private conflictFilled = 0;

  /** Track a maker once it is acked RESTING. Idempotent on digest (a re-register updates it).
   *  Validated fail-closed on every field a mis-value could corrupt the classification with. */
  register(maker: RestingMaker): void {
    if (!maker.digest) throw new Error("SELF_TRADE_DIGEST_REQUIRED");
    if (!maker.pairId) throw new Error("SELF_TRADE_PAIR_REQUIRED");
    if (maker.side !== "BUY" && maker.side !== "SELL") throw new Error("SELF_TRADE_MAKER_SIDE_INVALID");
    priceOf("MAKER", maker.priceX18); // validate shape up front so a bad price never mis-classifies
    this.makers.set(maker.digest, { ...maker });
  }

  /** Stop tracking a maker (it went terminal, was cancelled, or crossed). */
  release(digest: string): void { this.makers.delete(digest); }

  has(digest: string): boolean { return this.makers.has(digest); }
  get size(): number { return this.makers.size; }

  /**
   * The resting makers of OTHER pairs that `candidate` (a taker) would cross — the UNINTENDED
   * cross-pair collisions to cancel before it goes in, so the taker reaches only its own
   * pair-mate. A BUY taker crosses SELL makers priced at/below it; a SELL taker crosses BUY
   * makers priced at/above it. The candidate's OWN pair's makers are never returned (that cross
   * is the designed fill mechanism — decision #2). Sorted worst-first: a BUY taker meets the
   * lowest ask first, a SELL taker the highest bid.
   */
  conflicts(candidate: CrossCandidate): RestingMaker[] {
    // Validate the candidate's pair + side too: an empty/garbage pairId would make the same-pair
    // skip below miss, and the INTENDED cross would be flagged — the one way a caller bug could
    // zero out fills. Fail loud instead.
    if (!candidate.pairId) throw new Error("SELF_TRADE_CANDIDATE_PAIR_REQUIRED");
    if (candidate.side !== "BUY" && candidate.side !== "SELL") throw new Error("SELF_TRADE_CANDIDATE_SIDE_INVALID");
    const takerP = priceOf("CANDIDATE", candidate.priceX18);
    const hits: RestingMaker[] = [];
    for (const m of this.makers.values()) {
      if (m.pairId === candidate.pairId) continue;       // same pair ⇒ the intended cross
      if (m.side === candidate.side) continue;           // same side never crosses
      const makerP = BigInt(m.priceX18);
      const crosses = candidate.side === "BUY" ? takerP >= makerP : takerP <= makerP;
      if (crosses) hits.push(m);
    }
    hits.sort((a, b) => {
      const d = BigInt(a.priceX18) - BigInt(b.priceX18);
      const asc = d < 0n ? -1 : d > 0n ? 1 : 0;
      return candidate.side === "BUY" ? asc : -asc;      // BUY taker: cheapest ask first; SELL: dearest bid first
    });
    return hits;
  }

  /** Classify a cross the harness observed/anticipates against a specific tracked maker:
   *  intended (same pair), own-conflict (cross-pair), or unknown (maker not tracked). */
  classifyCross(makerDigest: string, takerPairId: string): "intended" | "own-conflict" | "unknown" {
    const m = this.makers.get(makerDigest);
    if (!m) return "unknown";
    return m.pairId === takerPairId ? "intended" : "own-conflict";
  }

  /** Record that an OTHER pair's maker was withdrawn to protect an intended cross: release it
   *  and bump the own_conflict_cancel metric (noting whether it had already filled). */
  recordConflictCancel(digest: string, filled = false): void {
    this.release(digest);
    this.conflictCancels++;
    if (filled) this.conflictFilled++;
  }

  /**
   * Resolve every cross-pair collision for `candidate`: cancel each conflicting maker via the
   * injected seam and record it. Stops early if `allowed()` turns false (an operator stop). A
   * maker the seam cannot remove (still resting / unknown) is left for the caller to retry and
   * is NOT counted. Returns how many were withdrawn.
   *
   * It works from a ONE-SHOT `conflicts()` snapshot: a maker registered AFTER this call starts is
   * not seen here — the caller re-checks `conflicts()` right before each taker send (the makers
   * set changes between sends), so a late arrival is caught on the next pass. The testnet cancel
   * seam MUST only ever cancel a campaign-owned resting maker (never a foreign/manual/IOC order);
   * offline that holds by construction (the registry only ever holds makers the harness
   * registered).
   */
  async resolveConflicts(
    candidate: CrossCandidate,
    cancel: (maker: RestingMaker) => Promise<ConflictCancelOutcome>,
    opts: { allowed?: () => boolean } = {},
  ): Promise<number> {
    let withdrawn = 0;
    for (const maker of this.conflicts(candidate)) {
      if (opts.allowed && !opts.allowed()) break;
      if (!this.makers.has(maker.digest)) continue;      // released by another lane before we got here
      const outcome = await cancel(maker);
      // Re-check AFTER the await: a concurrent lane resolving the SAME maker may have recorded +
      // released it while we awaited, so only the lane that still sees it counts (no double-count).
      if (outcome.removed && this.makers.has(maker.digest)) { this.recordConflictCancel(maker.digest, outcome.filled); withdrawn++; }
    }
    return withdrawn;
  }

  metrics(): OwnTradeMetrics {
    return { ownConflictCancel: this.conflictCancels, ownConflictFilled: this.conflictFilled, restingMakers: this.makers.size };
  }
}

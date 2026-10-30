// =============================================================================
// @farm/loadgen · order-identity — the no-double-place foundation (A-4 / correctness
// invariant #2). Nado dedups a resubmitted order by its EIP-712 DIGEST (ENGINE error
// 2013 DIGEST_ALREADY_EXISTS), within a ~90 s recvTime window (2011) and until the
// order's expiration (2004) — see the project's nado-order-dedup-semantics note. So a
// retry is absorbed as a no-op ONLY if it rebuilds the BYTE-IDENTICAL order: same nonce,
// expiration, price AND size (any field change → new digest → a SECOND placement).
//
// 🚨 Therefore a retried experiment order (same request.id) MUST reuse the SAME resolved
// {nonce, expiration, priceX18, sizeX18}. Never re-mint a nonce or re-read the price on
// retry. This cache memoizes those params per request.id so prepare() rebuilds the identical
// NUMERIC identity on every attempt; the first resolve fixes them, and the clock/book are read
// only then. (The digest also binds the appendix's side/reduce/exec-type bits, but those are
// pure functions of the order's role and so already stable per id — the cache fixes the
// numeric part.) The end-to-end no-double-place guarantee rests JOINTLY on this stable identity
// AND the coordinator's claim guard, which dispatches at most ONE order per request.id. A nonce
// embeds recvTime = now + 90 s, so a retry past ~90 s stale-fails at the sequencer (2011) rather
// than double-placing — safe by construction.
//
// SCOPE: in-memory, single-process (one tab / one node), matching the OperationsStore. If a
// persisted/recoverable job store is ever adopted, these params must be persisted too, or a
// post-reload retry re-mints and double-places (the Wave B lesson).
// =============================================================================

/** The resolved, retry-stable identity of one experiment order. Everything the signed
 *  typed-data depends on is fixed here at first resolve. */
export interface OrderIdentity {
  /** recvTime-encoded order nonce (decimal string). Fixed at first resolve; NEVER re-minted. */
  nonce: string;
  /** Unix-seconds expiration. Fixed at first resolve. */
  expiration: number;
  /** Resolved human price (decimal string) at first resolve — not re-read from the book on retry. */
  price: string;
  /** Resolved base size (human decimal string) at first resolve. */
  size: string;
}

export class OrderIdentityCache {
  private readonly byId = new Map<string, OrderIdentity>();

  /** Resolve the retry-stable identity for `requestId`. The FIRST call computes it via
   *  `mint` (reads the clock + book) and stores it; every later call with the same id returns
   *  the stored identity verbatim, so the rebuilt order is byte-identical and the sequencer
   *  dedups a resend instead of double-placing. `mint` is never called twice for one id. */
  resolve(requestId: string, mint: () => OrderIdentity): OrderIdentity {
    const prior = this.byId.get(requestId);
    if (prior) return prior;
    const fresh = frozen(mint());
    this.byId.set(requestId, fresh);
    return fresh;
  }

  /** The stored identity, if this id was already resolved (no minting). */
  peek(requestId: string): OrderIdentity | undefined {
    return this.byId.get(requestId);
  }

  /** Drop a round's/campaign's ids once its orders are terminal, to bound memory. A dropped
   *  id that is somehow re-resolved re-mints — safe only because a terminal order is never
   *  retried (the coordinator never re-sends a TERMINAL/ABORTED order). */
  forget(requestId: string): void {
    this.byId.delete(requestId);
  }

  forgetPrefix(prefix: string): void {
    for (const id of this.byId.keys()) if (id.startsWith(prefix)) this.byId.delete(id);
  }

  get size(): number {
    return this.byId.size;
  }
}

function frozen(identity: OrderIdentity): OrderIdentity {
  // Validate shape so a malformed mint can never produce a drifting/NaN identity that would
  // change the digest between attempts.
  if (!/^(0|[1-9][0-9]*)$/.test(identity.nonce)) throw new Error("ORDER_IDENTITY_NONCE_INVALID");
  if (!Number.isSafeInteger(identity.expiration) || identity.expiration <= 0) throw new Error("ORDER_IDENTITY_EXPIRATION_INVALID");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(identity.price) || Number(identity.price) <= 0) throw new Error("ORDER_IDENTITY_PRICE_INVALID");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(identity.size) || Number(identity.size) <= 0) throw new Error("ORDER_IDENTITY_SIZE_INVALID");
  return Object.freeze({ ...identity });
}

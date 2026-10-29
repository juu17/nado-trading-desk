// =============================================================================
// @farm/adapter-nado · multi-wallet gateway — per-wallet NadoGateway VIEWS over ONE
// shared transport + limiter + engine. BASE's createLiveNadoGateway bakes in a single
// `owner` (reads form owner+subaccount from it; writes already carry their own
// `sender`). The capacity engine drives MANY wallets, so this factory hands out a
// memoized gateway per owner — every view sharing the one transport and the one
// RateLimiter, so the whole cohort's reads AND writes respect a SINGLE per-IP budget
// (single-IP egress, decision #6). No multi-worker / multi-IP plumbing.
//
// On-chain nonce serialization (deposits/withdrawals — funding, deferred to Phase A/C)
// is NOT this module's concern: orders are off-chain (recvTime nonces). When an
// on-chain action is driven per wallet, the composition root reuses core's existing
// `SerialNonceLane` (packages/core/src/plan/runner.ts), one shared instance keyed per
// (wallet, chain) — adapter-nado stays free of a @farm/core import (no layering
// inversion), so that wiring lives at the seam (see Phase-A wiring), not here.
//
// 🚨 KEYLESS-ENGINE PRECONDITION: sharing one EngineClient across all owner views is
// safe ONLY because the engine is KEYLESS (no walletClient, `setLinkedSigner` never
// called) — reads pass `subaccountOwner` per call and the payload builders take the
// signature as an argument. If a future wiring ever gives the shared engine a signer,
// every view would share it → cross-wallet signature bleed. Keep the engine keyless,
// or give each owner its own engine.
//
// OWNER CASING: the memo key is case-folded, but a view binds whatever casing FIRST
// created it (reads use that casing; writes always use the authoritative
// `signed.sender`, so writes are never affected). Callers must therefore pass ONE
// consistent casing per wallet — the composition root derives it from the signer's
// address (as the console does), so this holds by construction.
// =============================================================================
import { createLiveNadoGateway } from "./live-gateway.js";
import type { LiveNadoGatewayDeps } from "./live-gateway.js";
import type { NadoGateway } from "./gateway.js";

/** The shared, owner-free slice of the live-gateway deps (engine, transport, limiter,
 *  engineUrl, chainId, endpoint, markets, productIds). */
export type MultiWalletNadoGatewayDeps = Omit<LiveNadoGatewayDeps, "owner">;

export interface MultiWalletNadoGateway {
  /** A NadoGateway bound to `owner`, created once per owner and memoized. Reads form
   *  the sequencer owner+subaccount from this owner; writes carry their own `sender`.
   *  Every view shares the one transport + limiter + engine (one per-IP budget). */
  forOwner(owner: string): NadoGateway;
  /** The owners that currently have a live view (lower-cased keys). */
  owners(): string[];
}

export function createMultiWalletNadoGateway(
  shared: MultiWalletNadoGatewayDeps,
): MultiWalletNadoGateway {
  // Memoize per owner. The MAP KEY is case-folded so the same wallet in different
  // casings yields one view; the owner string handed to the view is preserved as
  // given (the sequencer's expected owner identity is the caller's to decide).
  const views = new Map<string, NadoGateway>();
  return {
    forOwner(owner: string): NadoGateway {
      const key = owner.toLowerCase();
      let view = views.get(key);
      if (!view) {
        view = createLiveNadoGateway({ ...shared, owner });
        views.set(key, view);
      }
      return view;
    },
    owners(): string[] {
      return [...views.keys()];
    },
  };
}

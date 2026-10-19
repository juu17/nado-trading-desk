// =============================================================================
// @farm/core · spend-cap enforcer — stateful enforcement of a SpendCapPolicy
// (A2 opt-in): a per-op cap, sliding-window caps per wallet / per cohort /
// global, and a blast-radius ceiling. Charges on ATTEMPT (pessimistic — prevents
// over-spend across retries). Clock injectable for deterministic tests.
// =============================================================================
import type { SpendCapPolicy, SpendEnforcer, SpendRequest, SpendDecision, BlastRadiusClass } from "@farm/adapter-api";

const BLAST_RANK: Record<BlastRadiusClass, number> = {
  none: 0, trading: 1, approval: 2, "funds-move": 3, "account-control": 4,
};

interface Entry { ts: number; usd: number }

function prune(entries: Entry[], now: number, windowMs: number): Entry[] {
  const cutoff = now - windowMs;
  return entries.filter((e) => e.ts > cutoff);
}
function sum(entries: readonly Entry[]): number {
  let s = 0;
  for (const e of entries) s += e.usd;
  return s;
}

export class SpendCapEnforcer implements SpendEnforcer {
  private readonly byWallet = new Map<string, Entry[]>();
  private readonly byCohort = new Map<string, Entry[]>();
  private global: Entry[] = [];

  constructor(private readonly policy: SpendCapPolicy, private readonly now: () => number = Date.now) {}

  charge(req: SpendRequest): SpendDecision {
    if (!this.policy.enabled) return { allowed: true };
    const now = this.now();
    const windowMs = this.policy.windowMs ?? 60_000;

    if (this.policy.maxBlastRadius && BLAST_RANK[req.blastRadius] > BLAST_RANK[this.policy.maxBlastRadius]) {
      return { allowed: false, code: "BLAST_RADIUS_CAP", reason: `blast radius '${req.blastRadius}' exceeds cap '${this.policy.maxBlastRadius}'` };
    }
    if (this.policy.perOpUsd !== undefined && req.usd > this.policy.perOpUsd) {
      return { allowed: false, code: "PER_OP_CAP", reason: `op $${req.usd} exceeds per-op cap $${this.policy.perOpUsd}` };
    }

    // check every windowed cap BEFORE recording (no partial charge)
    const walletEntries = prune(this.byWallet.get(req.walletId) ?? [], now, windowMs);
    if (this.policy.perWalletWindowUsd !== undefined && sum(walletEntries) + req.usd > this.policy.perWalletWindowUsd) {
      return { allowed: false, code: "PER_WALLET_CAP", reason: `wallet window spend would exceed $${this.policy.perWalletWindowUsd}` };
    }

    let cohortEntries: Entry[] | undefined;
    if (this.policy.perCohortUsd !== undefined && req.cohortId !== undefined) {
      cohortEntries = prune(this.byCohort.get(req.cohortId) ?? [], now, windowMs);
      if (sum(cohortEntries) + req.usd > this.policy.perCohortUsd) {
        return { allowed: false, code: "PER_COHORT_CAP", reason: `cohort window spend would exceed $${this.policy.perCohortUsd}` };
      }
    }

    if (this.policy.globalPerWindowUsd !== undefined) {
      this.global = prune(this.global, now, windowMs);
      if (sum(this.global) + req.usd > this.policy.globalPerWindowUsd) {
        return { allowed: false, code: "GLOBAL_CAP", reason: `global window spend would exceed $${this.policy.globalPerWindowUsd}` };
      }
    }

    // all passed → record the spend
    const entry: Entry = { ts: now, usd: req.usd };
    walletEntries.push(entry);
    this.byWallet.set(req.walletId, walletEntries);
    if (req.cohortId !== undefined) {
      const c = cohortEntries ?? prune(this.byCohort.get(req.cohortId) ?? [], now, windowMs);
      c.push(entry);
      this.byCohort.set(req.cohortId, c);
    }
    this.global.push(entry);
    return { allowed: true };
  }
}

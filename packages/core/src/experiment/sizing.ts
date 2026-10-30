import { rawAmount, refuse } from "../funding/types.js";
import type { ExperimentSizing } from "./types.js";

export interface PairTurnoverInput {
  /** Flat baseline equity each side actually holds in this group (x18). */
  capitalA: bigint;
  capitalB: bigint;
  /** Confirmed open + close notional already executed by each wallet (x18). */
  filledA: bigint;
  filledB: bigint;
  targetPerWallet: bigint;
  sizing: ExperimentSizing;
  /** Catch-up: a lagging pair's normal round is this percentage of the usual (100-200). */
  boostPercent?: number;
}
export interface PairTurnover {
  /** multiplier x min(K_A, K_B): the normal round turnover of both wallets. */
  baseTurnover: bigint;
  remainingA: bigint;
  remainingB: bigint;
  /** Planned open + close turnover of the next round; zero when both wallets are done. */
  roundTurnover: bigint;
  /** Opening notional of the next round, half of the round turnover. */
  openNotional: bigint;
}
const ceilTo = (n: bigint, step: bigint) => (n + step - 1n) / step * step;

/**
 * Next round of a pair. Each wallet's gap is rounded up to the tail step and capped by the
 * pair's base turnover; the pair runs the larger of the two, so the wallet that is closer
 * to its target may overshoot. Only confirmed fills ever count as executed turnover.
 */
export function pairRoundTurnover(input: PairTurnoverInput): PairTurnover {
  const { sizing } = input;
  if (sizing.kind !== "CAPITAL_MULTIPLE" || !Number.isSafeInteger(sizing.multiplier) || sizing.multiplier < 1 || sizing.multiplier > 50) refuse("EXPERIMENT_SIZING_INVALID");
  const step = rawAmount(sizing.tailStepX18, true);
  if (input.capitalA <= 0n || input.capitalB <= 0n) refuse("EXPERIMENT_CAPITAL_UNKNOWN");
  if (input.filledA < 0n || input.filledB < 0n || input.targetPerWallet <= 0n) refuse("EXPERIMENT_SIZING_INVALID");
  const capital = input.capitalA < input.capitalB ? input.capitalA : input.capitalB;
  const boost = input.boostPercent ?? 100;
  if (!Number.isSafeInteger(boost) || boost < 100 || boost > 200) refuse("EXPERIMENT_SIZING_INVALID");
  const baseTurnover = capital * BigInt(sizing.multiplier) * BigInt(boost) / 100n;
  const remainingA = input.targetPerWallet > input.filledA ? input.targetPerWallet - input.filledA : 0n;
  const remainingB = input.targetPerWallet > input.filledB ? input.targetPerWallet - input.filledB : 0n;
  const buffer = sizing.tailBufferX18 === undefined ? 0n : rawAmount(sizing.tailBufferX18);
  const candidate = (remaining: bigint) => { if (remaining === 0n) return 0n; const want = ceilTo(remaining + buffer, step); return want < baseTurnover ? want : baseTurnover; };
  const a = candidate(remainingA), b = candidate(remainingB), roundTurnover = a > b ? a : b;
  return { baseTurnover, remainingA, remainingB, roundTurnover, openNotional: roundTurnover / 2n };
}
export function validateSizing(sizing: ExperimentSizing): void {
  if (!sizing || sizing.kind !== "CAPITAL_MULTIPLE" || !Number.isSafeInteger(sizing.multiplier) || sizing.multiplier < 1 || sizing.multiplier > 50) refuse("EXPERIMENT_SIZING_INVALID");
  rawAmount(sizing.tailStepX18, true);
  if (sizing.tailBufferX18 !== undefined) rawAmount(sizing.tailBufferX18);
}

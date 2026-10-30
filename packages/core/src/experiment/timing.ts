/**
 * Round timing (1.3.4). A round lives in a time slot: A opens at a random moment early in
 * the slot (random direction), B follows, both hold for a random time after they are paired,
 * then B closes by maker and A by taker. The slot length is kept on the task and on every
 * round it draws (`slotMs`). A task or round without it is a 5-minute one (all tasks before
 * 1.3.4): its saved open times, hold times, orders and route are never re-drawn.
 *
 * New tasks use 3-minute slots: open 0–30 s into the slot, hold exactly 60 s after both sides
 * are paired (1.4.0, the operator's choice: 1.3.4 drew 60–90 s; a shorter hold lets a round
 * whose A filled late still end within its slot, so its pair does not skip a whole slot), A
 * may still open until 2 minutes into the slot, B's maker close is given 30 s. The slot is a rhythm, not a deadline: a round that is not flat yet
 * simply makes its pair skip the next slots (a new round is drawn only after it completed).
 */
import { refuse } from "../funding/types.js";

export const LEGACY_SLOT_MS = 300_000, FAST_SLOT_MS = 180_000;
export interface SlotTiming {
  slotMs: number;
  /** A's opening moment: uniformly random in [slot start, slot start + openOffsetMs). */
  openOffsetMs: number;
  /** A may open (or re-post) until slot start + openWindowMs; B must follow within the slot. */
  openWindowMs: number;
  /** Hold after pairing: holdMinMs + a random whole number of ms in [0, holdRandomMs]. */
  holdMinMs: number; holdRandomMs: number;
  /** Longest hold a saved round of this slot length may carry (journal validation): rounds
   *  drawn by an earlier version keep their hold. */
  holdValidMaxMs: number;
  /** Low-cost opening: a round that waited opens only before slot start + gatedOpenByMs, at its
   *  own moment of each openOffsetMs period (within gatedReleaseMs). */
  gatedOpenByMs: number; gatedReleaseMs: number;
  /** How long B's maker close may rest after the hold before A closes by taker. */
  closeMakerMs: number;
}
const LEGACY: SlotTiming = { slotMs: LEGACY_SLOT_MS, openOffsetMs: 60_000, openWindowMs: 240_000, holdMinMs: 120_000, holdRandomMs: 60_000, holdValidMaxMs: 180_000,
  gatedOpenByMs: 120_000, gatedReleaseMs: 15_000, closeMakerMs: 60_000 };
const FAST: SlotTiming = { slotMs: FAST_SLOT_MS, openOffsetMs: 30_000, openWindowMs: 120_000, holdMinMs: 60_000, holdRandomMs: 0, holdValidMaxMs: 90_000,
  gatedOpenByMs: 60_000, gatedReleaseMs: 10_000, closeMakerMs: 30_000 };
export function slotTiming(slotMs?: number): SlotTiming {
  if (slotMs === undefined || slotMs === LEGACY_SLOT_MS) return LEGACY;
  if (slotMs === FAST_SLOT_MS) return FAST;
  return refuse("EXPERIMENT_SLOT_INVALID");
}
export const slotStart = (at: number, slotMs?: number) => Math.floor(at / slotTiming(slotMs).slotMs) * slotTiming(slotMs).slotMs;
/** Whether a saved round's open time and hold fit its slot timing (journal validation). */
export function roundTimingValid(r: { openAt: number; holdMs: number; slotMs?: number }): boolean {
  if (r.slotMs !== undefined && r.slotMs !== LEGACY_SLOT_MS && r.slotMs !== FAST_SLOT_MS) return false;
  const t = slotTiming(r.slotMs);
  return r.openAt % t.slotMs < t.openOffsetMs && r.holdMs >= t.holdMinMs && r.holdMs <= t.holdValidMaxMs;
}

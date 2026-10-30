// =============================================================================
// @farm/core · scheduler/lanes — bounded N-lane fan-out, stop-on-first-failure.
// Ported VERBATIM from lucklab 1.4.3 scheduler/lanes.ts (zero-dep, 17 L): the
// capacity engine's coordinator fans a pass across many pairs/wallets on a bounded
// number of concurrent lanes so one slow pair cannot starve the others, and a single
// failure cleanly drains every in-flight lane before surfacing. No behavioural change.
// =============================================================================

/**
 * Runs `fn` over `items` on at most `lanes` workers. After the first failure no worker takes
 * another item, and the call settles only once every item already under way has ended, so
 * nothing started here outlives the caller (its lock, its finally, its next pass). The first
 * failure is then thrown.
 */
export async function runLanes<T>(items: readonly T[], lanes: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.max(0, Math.min(lanes, queue.length)) }, async () => {
    while (!failure && queue.length) {
      const item = queue.shift() as T;
      try { await fn(item); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

/**
 * Automatic pause and resume. A pair (or the campaign's group step) that hits an error
 * is paused with a retry time instead of stopping the whole task. Network-type errors
 * are retried every minute for as long as they last; on each retry the coordinator only
 * queries the original requests first, so nothing is ever re-sent blindly. Any other
 * error gets a few spaced retries (to ride out read races), then waits for the operator.
 */
export const EXPERIMENT_RETRY_MS = 60_000;
export const EXPERIMENT_REVIEW_AFTER = 3;
/** A pair failing the same non-network way this many times in a row (about 45 minutes with
 *  the growing spacing) is set aside so its group goes on (see ExperimentPair.setAsideAt). */
export const EXPERIMENT_SET_ASIDE_AFTER = 8;
/** Two stages for a pair that keeps failing the same non-network way. First close-only (it
 *  closes what it holds and ends early once flat, its money moving on with the group); if it
 *  still cannot finish, set aside (it no longer holds the group). The group waits on it at
 *  most PAIR_LONELY_MS per stage once it is the only unfinished pair; otherwise the attempt
 *  count starts close-only and PAIR_CLOSE_ONLY_MS later it is set aside. Network-type
 *  failures never count (the whole group is waiting for the network then). */
export const PAIR_LONELY_MS = 5 * 60_000, PAIR_CLOSE_ONLY_MS = 10 * 60_000;
const TRANSIENT = new Set([
  "EXPERIMENT_NETWORK_UNAVAILABLE", "ENGINE_READ_UNKNOWN", "RPC_UNAVAILABLE", "RPC_RESULT_UNKNOWN", "JOURNAL_BUSY_TIMEOUT",
  "EXPERIMENT_ACCOUNT_UNKNOWN", "EXPERIMENT_ACCOUNT_VALUE_UNKNOWN", "EXPERIMENT_EQUITY_UNKNOWN", "OWN_ORDER_COVERAGE_INCOMPLETE",
  "EXPERIMENT_MARKET_STATUS_UNKNOWN", "EXPERIMENT_MARKET_NOT_TRADABLE", "EXPERIMENT_BOOK_INVALID", "EXPERIMENT_MARGIN_UNKNOWN",
  "EXPERIMENT_LOOKUP_UNKNOWN", "EXPERIMENT_DISPATCH_UNKNOWN", "EXPERIMENT_CANCEL_UNKNOWN", "EXPERIMENT_CANCEL_NOT_PROVEN",
  "EXPERIMENT_RECOVERY_UNKNOWN", "EXPERIMENT_ORDER_FACT_UNKNOWN", "EXPERIMENT_CLOSE_NONFINAL", "EXPERIMENT_EXIT_RECONCILE_REQUIRED",
  "EXPERIMENT_CONFLICT_CANCEL_PENDING", "EXPERIMENT_CONFLICT_FACT_INCOMPLETE", "EXPERIMENT_ROLLOVER_UNKNOWN", "EXPERIMENT_ROLLOVER_FACT_UNKNOWN", "EXPERIMENT_COORDINATOR_BLOCKED",
  "NADO_READ_BUDGET_TIMEOUT", "UNRESOLVED_ORDER", "ORDER_RESULT_UNKNOWN", "ORDER_ADMISSION_IN_PROGRESS",
  "ISOLATED_COVERAGE_UNKNOWN", "ISOLATED_ACCOUNT_UNKNOWN", "OWN_ORDERS_UNKNOWN", "FILL_COVERAGE_GAP", "FILL_HISTORY_UNKNOWN",
  "FILL_COVERAGE_UNKNOWN", "TRIGGER_READ_UNKNOWN", "TRIGGER_COVERAGE_INCOMPLETE", "PLATFORM_INTEGER_UNKNOWN",
  "EXCLUSIVE_INVENTORY_UNRESOLVED_ORDER", "UNRESOLVED_ORDER_HISTORY", "EXPERIMENT_REDUCE_ONLY_POSITION_MISMATCH", "EXPERIMENT_ENDPOINT_UNKNOWN", "INCREMENT_UNKNOWN", "EXPERIMENT_INCREMENT_UNKNOWN",
  "EXPERIMENT_RATE_LIMITED", "EXPERIMENT_ADDRESS_SCREENING",
  // 1.4.0: trading switched off or its order session dropped after an unknown send; the
  // runtime re-admits and re-enables by itself once every order is resolved.
  "TRADING_STOPPED", "EXPERIMENT_EXCLUSIVE_CONFIRMATION_REQUIRED", "EXCLUSIVE_INVENTORY_TOKEN_INVALID", "EXCLUSIVE_INVENTORY_INVALIDATED",
  "EXCLUSIVE_INVENTORY_UNRESOLVED_ORDER", "ORDER_LOOKUP_FAILED", "ORDER_NOT_YET_PROVEN", "DDA_LOOKUP_UNAVAILABLE", "PLATFORM_RESULT_UNKNOWN",
  "TOKEN_BALANCE_UNKNOWN", "RPC_BLOCK_UNKNOWN", "QUERY_UNCERTAIN", "JOURNAL_BACKUP_UNAVAILABLE",
]);
export function isTransientExperimentError(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT.has(code);
}
/** Whether a pause with this code and attempt count retries by itself. 1.4.0 unattended
 *  rule (the operator sleeps while the task runs): every pause does. A retry only queries
 *  original requests first and re-checks every fact, so nothing is ever re-sent blindly; a
 *  passing cause heals, a lasting one only costs reads. The "needs review" notice still
 *  shows after EXPERIMENT_REVIEW_AFTER attempts, for the operator to look when awake. */
export function experimentAutoRetry(_code: string | undefined, _attempts: number): boolean {
  return true;
}
/** Spacing of the next automatic retry: network-type codes every minute (a rate limit 5 s);
 *  anything else 1, 2, 4, 8 minutes, then every 10 minutes. */
export const EXPERIMENT_RETRY_MAX_MS = 10 * 60_000;
export function experimentRetryDelay(code: string | undefined, attempts: number): number {
  if (code === "EXPERIMENT_RATE_LIMITED") return 5000;
  if (isTransientExperimentError(code)) return EXPERIMENT_RETRY_MS;
  return Math.min(EXPERIMENT_RETRY_MS * 2 ** Math.min(10, Math.max(0, attempts - 1)), EXPERIMENT_RETRY_MAX_MS);
}
/** Whether this pause asks the operator to look (retries continue regardless). */
export const experimentNeedsReview = (code: string | undefined, attempts: number) =>
  !isTransientExperimentError(code) && attempts >= EXPERIMENT_REVIEW_AFTER;
/** Plain error to a stable code: anything without a code is a lost network call. */
export function experimentErrorCode(e: unknown): string {
  return e instanceof Error && /^[A-Z][A-Z0-9_]{0,99}$/.test(e.message) ? e.message : "EXPERIMENT_NETWORK_UNAVAILABLE";
}

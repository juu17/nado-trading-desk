// =============================================================================
// @farm/core · AdapterError normalization — driven by wative's OWN taxonomy.
//
// The seam's `AdapterError` is a normalization TARGET, not a parallel error model.
// Core maps `WativeErrorCode` (+ the TransactionTracker terminal status) into the
// handful of categories the retry logic branches on. wative already draws the
// landed-vs-not-landed line; we preserve it rather than re-deriving it.
// =============================================================================
import { WativeError } from "wative-core";
import type { WativeErrorCode, TransactionStatus } from "wative-core";
import type { AdapterError, ErrorCategory } from "@farm/adapter-api";

/** Total map over every WativeErrorCode (2.6.0) → seam ErrorCategory. */
const CATEGORY: Record<WativeErrorCode, ErrorCategory> = {
  // may have landed → reconcile by hash FIRST before any resend
  TX_TIMEOUT: "retryable-unsafe",
  RPC_UNREACHABLE: "retryable-unsafe",
  PROVIDER_IO: "retryable-unsafe",
  // provably not landed → safe to rebuild/resend
  TX_DROPPED: "retryable-safe",
  TX_BUILD_FAILED: "retryable-safe",
  TX_SIGN_FAILED: "retryable-safe",
  TX_ABORTED: "retryable-safe",
  // the chain / RPC rejected it → do not resend as-is
  RPC_REJECTED: "rejected",
  TX_SUBMIT_FAILED: "rejected",
  IRREGULAR_DESTINATION: "rejected",
  UNSUPPORTED_OP: "rejected",
  UNSUPPORTED_NETWORK: "network",
  PARAMETER_ERROR: "rejected",
  INVALID_MNEMONIC: "rejected",
  INVALID_PRIVATE_KEY: "rejected",
  DUPLICATE_IDENTITY: "rejected",
  RECORD_NOT_FOUND: "rejected",
  DISK_FULL: "rejected",
  ENCRYPT_FAILED: "rejected",
  ALGORITHM_IRREVERSIBLE: "rejected",
  // signer / permission / unlock failures
  BAD_PASSWORD: "auth",
  WEAK_PASSWORD: "auth",
  WORKSPACE_LOCKED: "auth",
  ACCOUNT_LOCKED: "auth",
  WALLET_DISABLED: "auth",
  RECORD_LOCKED: "auth",
  PERMISSION_DENIED: "auth",
  DECRYPT_FAILED: "auth",
  // durability / connectivity
  STORAGE_NOT_DURABLE: "network",
};

/** Map a wative TransactionTracker terminal status → retry category. */
export function categoryForTxStatus(status: TransactionStatus): ErrorCategory | null {
  switch (status) {
    case "failed": return "retryable-safe";    // mined-and-reverted or build/sign fail → never landed as success
    case "dropped": return "retryable-safe";
    case "aborted": return "retryable-safe";
    case "timeout": return "retryable-unsafe";  // unknown fate → reconcile by hash first
    default: return null;                        // non-terminal / success
  }
}

const looksRateLimited = (msg: string): boolean =>
  /\b429\b|rate.?limit|too many requests/i.test(msg);

/**
 * Normalize ANY thrown value into a seam `AdapterError`. Preserves an already-
 * normalized AdapterError; maps WativeError via its code; falls back conservatively
 * (unknown → 'network', never auto-safe-resend).
 */
export function normalizeWativeError(e: unknown): AdapterError {
  // already normalized?
  if (e && typeof e === "object" && "category" in e && "retrySafe" in e) {
    return e as AdapterError;
  }
  if (e instanceof WativeError) {
    const category = CATEGORY[e.code] ?? "network";
    const resolved: ErrorCategory = looksRateLimited(e.message) ? "rate-limited" : category;
    return {
      category: resolved,
      retrySafe: resolved === "retryable-safe",
      message: e.message,
      code: e.code,
      raw: e,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  const category: ErrorCategory = looksRateLimited(message) ? "rate-limited" : "network";
  return { category, retrySafe: false, message, raw: e };
}

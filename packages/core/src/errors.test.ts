import { describe, it, expect } from "vitest";
import { WativeError } from "wative-core";
import { normalizeWativeError, categoryForTxStatus } from "./errors.js";

describe("AdapterError normalization (driven by WativeErrorCode)", () => {
  it("maps the landed-vs-not-landed line from wative codes", () => {
    expect(normalizeWativeError(new WativeError("TX_TIMEOUT", "t")).category).toBe("retryable-unsafe");
    expect(normalizeWativeError(new WativeError("RPC_UNREACHABLE", "t")).category).toBe("retryable-unsafe");
    const dropped = normalizeWativeError(new WativeError("TX_DROPPED", "t"));
    expect(dropped.category).toBe("retryable-safe");
    expect(dropped.retrySafe).toBe(true);
    expect(normalizeWativeError(new WativeError("RPC_REJECTED", "t")).category).toBe("rejected");
    expect(normalizeWativeError(new WativeError("BAD_PASSWORD", "t")).category).toBe("auth");
    expect(normalizeWativeError(new WativeError("UNSUPPORTED_NETWORK", "t")).category).toBe("network");
  });

  it("preserves the wative code and detects rate limiting", () => {
    const e = normalizeWativeError(new WativeError("RPC_REJECTED", "HTTP 429 too many requests"));
    expect(e.category).toBe("rate-limited");
    const to = normalizeWativeError(new WativeError("TX_TIMEOUT", "t"));
    expect(to.code).toBe("TX_TIMEOUT");
  });

  it("falls back conservatively for unknown errors (never auto-safe-resend)", () => {
    const e = normalizeWativeError(new Error("boom"));
    expect(e.category).toBe("network");
    expect(e.retrySafe).toBe(false);
  });

  it("maps tracker terminal status to retry category", () => {
    expect(categoryForTxStatus("failed")).toBe("retryable-safe");
    expect(categoryForTxStatus("dropped")).toBe("retryable-safe");
    expect(categoryForTxStatus("timeout")).toBe("retryable-unsafe");
    expect(categoryForTxStatus("confirmed")).toBeNull();
  });
});

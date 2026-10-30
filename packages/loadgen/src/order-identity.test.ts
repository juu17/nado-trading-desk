// Guards the no-double-place foundation (A-4 / invariant #2): a retried order (same
// request.id) rebuilds BYTE-IDENTICAL params, so the sequencer dedups the resend (2013)
// instead of placing a second order. Re-derived independently of the intern suite.
import { describe, expect, it, vi } from "vitest";
import { OrderIdentityCache, type OrderIdentity } from "./order-identity.js";

const id = (over: Partial<OrderIdentity> = {}): OrderIdentity => ({ nonce: "123", expiration: 1_000_000, price: "100", size: "0.5", ...over });

describe("OrderIdentityCache — retry-stable order identity", () => {
  it("mints once per request.id and returns the identical identity on every retry", () => {
    const cache = new OrderIdentityCache();
    const mint = vi.fn(() => id({ nonce: "777" }));
    const first = cache.resolve("experiment:c:p:1:A_OPEN:1", mint);
    const retry = cache.resolve("experiment:c:p:1:A_OPEN:1", mint);
    const retry2 = cache.resolve("experiment:c:p:1:A_OPEN:1", mint);
    expect(mint).toHaveBeenCalledTimes(1);            // the clock/book are read ONCE
    expect(retry).toBe(first);                        // identical object
    expect(retry2).toEqual(first);
    // Byte-identity of the digest-determining fields (never re-minted / re-priced on retry).
    expect([retry.nonce, retry.expiration, retry.price, retry.size]).toEqual(["777", 1_000_000, "100", "0.5"]);
  });

  it("mints independently per distinct request.id", () => {
    const cache = new OrderIdentityCache();
    let n = 0;
    const a = cache.resolve("a", () => id({ nonce: String(++n) }));
    const b = cache.resolve("b", () => id({ nonce: String(++n) }));
    expect(a.nonce).toBe("1");
    expect(b.nonce).toBe("2");
    expect(cache.resolve("a", () => id({ nonce: "999" })).nonce).toBe("1"); // a is still stable
  });

  it("never lets a different mint override a resolved id (a retry cannot change the digest)", () => {
    const cache = new OrderIdentityCache();
    cache.resolve("x", () => id({ nonce: "1", price: "100", size: "1" }));
    // A buggy retry that tried to re-price/re-size is ignored: the stored identity wins.
    const retry = cache.resolve("x", () => id({ nonce: "2", price: "101", size: "2" }));
    expect([retry.nonce, retry.price, retry.size]).toEqual(["1", "100", "1"]);
  });

  it("rejects a malformed mint so a drifting/NaN identity can never reach the wire", () => {
    const cache = new OrderIdentityCache();
    expect(() => cache.resolve("n", () => id({ nonce: "-5" }))).toThrow("ORDER_IDENTITY_NONCE_INVALID");
    expect(() => cache.resolve("e", () => id({ expiration: 0 }))).toThrow("ORDER_IDENTITY_EXPIRATION_INVALID");
    expect(() => cache.resolve("p", () => id({ price: "0" }))).toThrow("ORDER_IDENTITY_PRICE_INVALID");
    expect(() => cache.resolve("s", () => id({ size: "x" }))).toThrow("ORDER_IDENTITY_SIZE_INVALID");
  });

  it("forget / forgetPrefix bound memory without affecting other ids", () => {
    const cache = new OrderIdentityCache();
    cache.resolve("experiment:c1:p:1:A_OPEN:1", () => id());
    cache.resolve("experiment:c1:p:2:A_OPEN:1", () => id());
    cache.resolve("experiment:c2:p:1:A_OPEN:1", () => id());
    expect(cache.size).toBe(3);
    cache.forgetPrefix("experiment:c1:");
    expect(cache.size).toBe(1);
    expect(cache.peek("experiment:c2:p:1:A_OPEN:1")).toBeDefined();
    cache.forget("experiment:c2:p:1:A_OPEN:1");
    expect(cache.size).toBe(0);
  });
});

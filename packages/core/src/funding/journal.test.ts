import { describe, it, expect } from "vitest";
import { validateDeskOperations } from "./journal.js";
import { emptyOperations, type ProtectedOrder } from "./types.js";

const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);

function order(owner: string, id: string, digest: string): ProtectedOrder {
  return {
    id, owner, chainId: 763373, productId: 2, digest,
    payload: "signed", quantityX18: "100", side: "BUY",
    priceX18: "1000", nonce: "10", expiration: 1000,
    createdAt: 1, state: "DISPATCHED", filledX18: "0",
  };
}

describe("validateDeskOperations (trimmed)", () => {
  it("accepts an empty document and a valid order", () => {
    const d = emptyOperations();
    d.orders.push(order(A, "a1", "0x" + "a".repeat(64)));
    expect(() => validateDeskOperations(d)).not.toThrow();
  });

  it("🚨 is the global order-id uniqueness BACKSTOP (the D1 enforcement)", () => {
    // Two orders sharing an id across different owners — the exact state the sharded
    // per-owner submit can no longer refuse. The journal must fail-closed on load.
    const d = emptyOperations();
    d.orders.push(order(A, "X", "0x" + "a".repeat(64)));
    d.orders.push(order(B, "X", "0x" + "b".repeat(64)));
    expect(() => validateDeskOperations(d)).toThrow("JOURNAL_DAMAGED");
  });

  it("rejects a non-schema-2 document", () => {
    const d = { ...emptyOperations(), schema: 1 } as unknown;
    expect(() => validateDeskOperations(d)).toThrow("JOURNAL_DAMAGED");
  });

  it("rejects a non-positive chain id (de-pinned but still positive)", () => {
    const d = emptyOperations();
    d.orders.push({ ...order(A, "a1", "0x" + "a".repeat(64)), chainId: 0 });
    expect(() => validateDeskOperations(d)).toThrow("JOURNAL_DAMAGED");
    // but a non-Ink positive chain id is fine (no Ink pinning)
    const ok = emptyOperations();
    ok.orders.push({ ...order(A, "a1", "0x" + "a".repeat(64)), chainId: 8453 });
    expect(() => validateDeskOperations(ok)).not.toThrow();
  });

  it("enforces the neverSent invariant (UNKNOWN != didn't place)", () => {
    const d = emptyOperations();
    // neverSent requires a REJECTED/filled-0/cleared row; a DISPATCHED one is damaged
    d.orders.push({ ...order(A, "a1", "0x" + "a".repeat(64)), neverSent: true });
    expect(() => validateDeskOperations(d)).toThrow("JOURNAL_DAMAGED");
  });

  it("rejects an order filled beyond its quantity", () => {
    const d = emptyOperations();
    d.orders.push({ ...order(A, "a1", "0x" + "a".repeat(64)), filledX18: "200" });
    expect(() => validateDeskOperations(d)).toThrow("JOURNAL_DAMAGED");
  });
});

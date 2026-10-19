import { describe, it, expect } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { buildPlaceOrderTypedData, buildCancelTypedData, buildWithdrawTypedData, buildStreamAuthTypedData } from "./execute.js";
import type { PlaceOrderInput, CancelInput, Decimal } from "@farm/adapter-api";

const ENDPOINT = "0x698D87105274292B5673367DEC81874Ce3633Ac2";

const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN_ID = 57073;
const acct = mnemonicToAccount(MNEMONIC);
const OWNER = acct.address;

const d = (s: string) => s as Decimal;

describe("Nado EIP-712 execute builders (adapter-level conformance)", () => {
  it("builds a signable place_order (BUY) that ecrecovers to the owner", async () => {
    const input: PlaceOrderInput = {
      market: "nado:perp:BTC-PERP", side: "buy", kind: "limit",
      price: d("63120"), size: d("0.1"), clientId: "c1",
    };
    const built = buildPlaceOrderTypedData(input, { chainId: CHAIN_ID, productId: 2, ownerAddress: OWNER });
    expect(built.amount).toBeGreaterThan(0n);              // buy → positive
    expect(built.priceX18).toBe(63120n * 10n ** 18n);      // adapter-owned X18 scaling
    const td = built.typedData as Parameters<typeof acct.signTypedData>[0];
    const sig = await acct.signTypedData(td);
    const rec = await recoverTypedDataAddress({ ...td, signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(rec.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("signs a SELL order with a negative amount", async () => {
    const input: PlaceOrderInput = {
      market: "nado:perp:BTC-PERP", side: "sell", kind: "limit",
      price: d("63180"), size: d("0.1"), clientId: "c2",
    };
    const built = buildPlaceOrderTypedData(input, { chainId: CHAIN_ID, productId: 2, ownerAddress: OWNER });
    expect(built.amount).toBeLessThan(0n);
    expect(built.amount).toBe(-(10n ** 17n));
  });

  it("sets the reduce-only appendix bit (2048) so a close IOC can't overshoot/flip", () => {
    const base: PlaceOrderInput = {
      market: "nado:perp:BTC-PERP", side: "sell", kind: "limit",
      price: d("63180"), size: d("0.1"), tif: "ioc", clientId: "close",
    };
    const normal = buildPlaceOrderTypedData(base, { chainId: CHAIN_ID, productId: 2, ownerAddress: OWNER });
    const reduce = buildPlaceOrderTypedData({ ...base, reduceOnly: true }, { chainId: CHAIN_ID, productId: 2, ownerAddress: OWNER });
    expect(normal.order.appendix).toBe("513");    // ioc, no reduce-only
    expect(reduce.order.appendix).toBe("2561");   // ioc (513) | reduce-only (2048)
  });

  it("builds a signable StreamAuthentication (order_update WS auth) that ecrecovers to the owner", async () => {
    const sender = "0x" + "ab".repeat(32); // a bytes32 subaccount hex
    const exp = String(Date.now() + 60_000); // unix MILLISECONDS, <=100s ahead
    const built = buildStreamAuthTypedData(sender, exp, { chainId: CHAIN_ID, endpoint: ENDPOINT });
    const td = built.typedData as Parameters<typeof acct.signTypedData>[0];
    expect(td.primaryType).toBe("StreamAuthentication");
    expect((td.domain as { verifyingContract?: string }).verifyingContract).toBe(ENDPOINT);
    const msg = td.message as { sender: string; expiration: bigint };
    expect(msg.sender).toBe(sender);
    expect(msg.expiration).toBe(BigInt(exp)); // signed as uint64 bigint
    expect(built.expiration).toBe(exp);       // the frame sends it as the ms string
    const sig = await acct.signTypedData(td);
    const rec = await recoverTypedDataAddress({ ...td, signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(rec.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("builds a signable cancel_orders that ecrecovers to the owner", async () => {
    const input: CancelInput = { venueIds: ["0x" + "11".repeat(32), "0x" + "22".repeat(32)] };
    const built = buildCancelTypedData(input, { chainId: CHAIN_ID, ownerAddress: OWNER }, [2, 4]);
    expect(built.productIds).toEqual([2, 4]);
    const td = built.typedData as Parameters<typeof acct.signTypedData>[0];
    const sig = await acct.signTypedData(td);
    const rec = await recoverTypedDataAddress({ ...td, signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(rec.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it("builds a signable withdraw_collateral that ecrecovers to the owner (6-dec amount, no x18)", async () => {
    const built = buildWithdrawTypedData("1000000", { // 1.0 USDT0 (6-dec), passed through verbatim
      ownerAddress: OWNER, chainId: CHAIN_ID, endpoint: ENDPOINT, productId: 0, nonce: "123456789",
    });
    const td = built.typedData as Parameters<typeof acct.signTypedData>[0];
    expect(td.primaryType).toBe("WithdrawCollateral");
    expect((td.domain as { verifyingContract?: string }).verifyingContract).toBe(ENDPOINT);
    const msg = td.message as { sender: string; productId: number; amount: bigint; nonce: bigint };
    expect(msg.productId).toBe(0);
    expect(msg.amount).toBe(1_000_000n); // native 6-dec units, NOT x18-scaled
    expect(msg.nonce).toBe(123_456_789n);
    expect(built.withdraw.amount).toBe("1000000"); // handed verbatim to the SDK payload builder
    const sig = await acct.signTypedData(td);
    const rec = await recoverTypedDataAddress({ ...td, signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(rec.toLowerCase()).toBe(OWNER.toLowerCase());
  });
});

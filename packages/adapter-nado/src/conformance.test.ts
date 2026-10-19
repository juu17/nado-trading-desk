import { describe, it, expect } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { runConformance } from "@farm/adapter-sdk";
import type { Eip712Case } from "@farm/adapter-sdk";
import { NadoAdapter } from "./adapter.js";
import { buildPlaceOrderTypedData, buildCancelTypedData } from "./execute.js";
import type { Eip712TypedData, Hex, ProtocolOperation, PlaceOrderInput, Decimal, ChainId } from "@farm/adapter-api";

const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN = 57073;
const acct = mnemonicToAccount(MNEMONIC);
const OWNER = acct.address;
const d = (s: string) => s as Decimal;

// Property-based EIP-712 cases: a spread of random orders + a cancel.
function cases(): Eip712Case[] {
  const out: Eip712Case[] = [];
  for (let i = 0; i < 24; i++) {
    const side = i % 2 ? "sell" : "buy";
    const price = d(String(60000 + Math.floor(Math.random() * 6000)));
    const size = d((0.001 + Math.random() * 2).toFixed(5));
    const built = buildPlaceOrderTypedData(
      { market: "nado:perp:BTC-PERP", side, kind: "limit", price, size, clientId: `c${i}` },
      { chainId: CHAIN, productId: 2, ownerAddress: OWNER },
    );
    out.push({ label: `place[${i}] ${side}`, typedData: built.typedData, chainId: CHAIN });
  }
  out.push({
    label: "cancel",
    typedData: buildCancelTypedData({ venueIds: ["0x" + "11".repeat(32)] }, { chainId: CHAIN, ownerAddress: OWNER }, [2]).typedData,
    chainId: CHAIN,
  });
  return out;
}

const sampleOps: ProtocolOperation[] = [
  { kind: "placeOrder", protocolId: "nado", chainId: CHAIN as ChainId, input: { market: "nado:perp:BTC-PERP", side: "buy", kind: "limit", size: d("0.1"), price: d("63000"), clientId: "c" } satisfies PlaceOrderInput },
  { kind: "cancel", protocolId: "nado", chainId: CHAIN as ChainId, input: { market: "nado:perp:BTC-PERP" } },
];

describe("NadoAdapter conformance (over-abstraction detector)", () => {
  it("passes the universal port contract + EIP-712 sign/recover across random orders", async () => {
    const adapter = new NadoAdapter({ productIds: { "nado:perp:BTC-PERP": 2 } });
    const res = await runConformance({
      adapter,
      owner: OWNER,
      sign: async (td: Eip712TypedData) => (await acct.signTypedData(td as Parameters<typeof acct.signTypedData>[0])) as Hex,
      recover: async (td: Eip712TypedData, sig: Hex) =>
        recoverTypedDataAddress({ ...(td as object), signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]),
      eip712Cases: cases(),
      sampleOps,
    });
    if (!res.passed) console.error("FAILED CHECKS:", res.checks.filter((c) => !c.ok));
    expect(res.passed).toBe(true);
    expect(res.checks.length).toBeGreaterThan(30); // manifest + supports(9) + caps(3) + ops + 25 eip712
  });
});

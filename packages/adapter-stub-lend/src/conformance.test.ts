import { describe, it, expect } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { runConformance } from "@farm/adapter-sdk";
import type { Eip712Case } from "@farm/adapter-sdk";
import { StubLendAdapter } from "./adapter.js";
import { buildPermitTypedData } from "./execute.js";
import type { Eip712TypedData, Hex, ProtocolOperation, ChainId, Amount, SupplyInput, BorrowInput } from "@farm/adapter-api";

const MNEMONIC = "test test test test test test test test test test test junk";
const CHAIN = 11155111;
const acct = mnemonicToAccount(MNEMONIC);
const OWNER = acct.address;
const TOKEN = "0x" + "a1".repeat(20);   // a stub ERC-20 (the permit domain's verifyingContract)
const SPENDER = "0x" + "b2".repeat(20); // a stub lending pool

// Property-based EIP-712 cases: a spread of ERC-2612 permits — a DIFFERENT domain/struct
// than Nado's order typed-data, proving the sign->recover core isn't fitted to Nado.
function cases(): Eip712Case[] {
  const out: Eip712Case[] = [];
  for (let i = 0; i < 12; i++) {
    const td = buildPermitTypedData({
      token: TOKEN, owner: OWNER, spender: SPENDER,
      value: BigInt(1_000_000 + i), nonce: BigInt(i), deadline: BigInt(2_000_000_000 + i), chainId: CHAIN, tokenName: "StubUSDC",
    });
    out.push({ label: `permit[${i}]`, typedData: td, chainId: CHAIN });
  }
  return out;
}

const amt = (s: string) => s as Amount;
const sampleOps: ProtocolOperation[] = [
  { kind: "supply", protocolId: "stub-lend", chainId: CHAIN as ChainId, input: { reserve: "r-usdc", asset: "USDC", amount: amt("100") } satisfies SupplyInput },
  { kind: "borrow", protocolId: "stub-lend", chainId: CHAIN as ChainId, input: { reserve: "r-usdc", asset: "USDC", amount: amt("50") } satisfies BorrowInput },
];

describe("StubLendAdapter conformance (over-abstraction detector)", () => {
  it("a deliberately-different LENDING adapter passes the SAME universal port contract + EIP-712 sign/recover", async () => {
    const adapter = new StubLendAdapter();
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
    expect(res.checks.length).toBeGreaterThan(20); // manifest(4) + supports(9) + caps(3) + normalizeError(1) + ops(2) + 12 permits = 31
  });

  it("is genuinely different from Nado: lending capability present, trading/swap absent; disjoint ops", () => {
    const adapter = new StubLendAdapter();
    expect(adapter.capability("lending")).toBeDefined();
    expect(adapter.capability("trading")).toBeUndefined();
    expect(adapter.capability("swap")).toBeUndefined();
    expect(adapter.supports("supply")).toBe(true);
    expect(adapter.supports("placeOrder")).toBe(false);
    expect(adapter.manifest.account.subaccounts).toBe(false);
  });
});

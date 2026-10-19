import { describe, it, expect } from "vitest";
import { Contract, Network } from "wative-core";
import type { AbiItem } from "wative-core";
import { WativeChainRegistry, defaultChainOverlay } from "./registry.js";
import { WativeChainPrimitives, classifySafety, formatUnits, parseUnits } from "./primitives.js";
import type { Address, ChainId } from "@farm/adapter-api";

const prims = new WativeChainPrimitives({
  registry: WativeChainRegistry.fromBuiltins(defaultChainOverlay()),
  networks: Network.all(),
});
const INK = Network.Ink.chainId as unknown as ChainId;
const evm = (v: string): Address => ({ family: "evm", value: v as `0x${string}` });

describe("chain primitives — pure/offline delegation", () => {
  it("formatUnits/parseUnits round-trip", () => {
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatUnits(0n, 18)).toBe("0");
    expect(parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnits("0", 6)).toBe(0n);
    expect(parseUnits(formatUnits(123_456_789n, 6), 6)).toBe(123_456_789n);
  });

  it("classifySafety flags standing auth / funds moves", () => {
    expect(classifySafety("approve").grantsStandingAuth).toBe(true);
    expect(classifySafety("approve").blastRadiusClass).toBe("approval");
    expect(classifySafety("transfer").movesFunds).toBe(true);
    expect(classifySafety("transfer").blastRadiusClass).toBe("funds-move");
    const place = classifySafety("placeOrder");
    expect(place.grantsStandingAuth).toBe(false);
    expect(place.movesFunds).toBe(false);
    expect(place.blastRadiusClass).toBe("trading");
  });

  it("revokeApprovalOp builds approve(spender,0) on wative's ERC20 artifact", () => {
    const op = prims.revokeApprovalOp(INK, evm("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), evm("0x1111111111111111111111111111111111111111"));
    expect(op.kind).toBe("chainCall");
    expect(op.input.method).toBe("approve");
    expect(op.input.args[1]).toBe(0n);
    // encode through wative's ERC20 ABI → canonical approve selector
    const data = new Contract("erc20", op.input.abi as ReadonlyArray<AbiItem>).encode("approve", op.input.args);
    expect(data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("costOf resolves the per-chain broadcast bucket", () => {
    const cost = prims.costOf({ kind: "chainCall", chainId: INK });
    expect(cost).toHaveLength(1);
    expect(cost[0]?.bucket).toBe(`rpc:broadcast:${String(INK)}`);
    expect(cost[0]?.scope).toBe("chain");
  });

  it("resolveChainAccount yields a protocol-less (chain-level) handle", async () => {
    const h = await prims.resolveChainAccount({ owner: evm("0x2222222222222222222222222222222222222222"), chainId: INK, walletId: "w0" });
    expect(h.protocolId).toBeUndefined();
    expect(h.chainId).toBe(INK);
    expect(h.walletId).toBe("w0");
  });
});

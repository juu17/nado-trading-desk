import { describe, it, expect } from "vitest";
import { Network } from "wative-core";
import {
  WativeChainRegistry,
  defaultChainOverlay,
  inkTestnetNetwork,
} from "./registry.js";
import type { ChainId } from "@farm/adapter-api";

describe("WativeChainRegistry (wraps wative Network, no hardcoded specs)", () => {
  const reg = WativeChainRegistry.fromBuiltins(defaultChainOverlay());

  it("projects Ink mainnet straight from the wative builtin", () => {
    const inkId = Network.Ink.chainId as unknown as ChainId;
    const spec = reg.require(inkId);
    // sourced from wative, not a hand-written literal:
    expect(spec.displayName).toBe(Network.Ink.name);
    expect(spec.family).toBe("evm");
    expect(spec.nativeAsset.symbol).toBe(Network.Ink.nativeCurrency.symbol);
    expect(spec.rpc.read.length).toBeGreaterThan(0); // from Network.endpointsFor
    // overlay-only facts wative does not carry:
    expect(spec.rateLimits).toHaveLength(2);
    expect(spec.broadcast.lookupBeforeRetry).toBe(true);
    expect(spec.blockExplorerUrl).toContain("inkonchain.com");
    expect(spec.testnet).toBeUndefined();
  });

  it("throws a normalized network AdapterError for an unknown chain", () => {
    const unknownId = 999999 as unknown as ChainId;
    expect(reg.get(unknownId)).toBeUndefined();
    expect(reg.has(unknownId)).toBe(false);
    try {
      reg.require(unknownId);
      throw new Error("expected require() to throw");
    } catch (e) {
      expect((e as { category?: string }).category).toBe("network");
      expect((e as { code?: string }).code).toBe("CHAIN_NOT_REGISTERED");
    }
  });

  it("hides Solana builtins from list() but keeps them in all()", () => {
    const solana = reg.all().find((s) => s.family === "svm");
    expect(solana?.hidden).toBe(true);
    expect(reg.list().some((s) => s.family === "svm")).toBe(false);
    expect(reg.all().some((s) => s.family === "svm")).toBe(true);
  });

  it("adds Ink testnet as a real wative Network (not a builtin)", () => {
    expect(Network.all().some((n) => n.chainId === (763373 as never))).toBe(false); // not a builtin
    const testnet = inkTestnetNetwork("http://localhost:8545");
    const reg2 = new WativeChainRegistry([...Network.all(), testnet], defaultChainOverlay());
    const spec = reg2.require(763373 as unknown as ChainId);
    expect(spec.testnet).toBe(true);
    expect(spec.rpc.read).toContain("http://localhost:8545");
  });
});

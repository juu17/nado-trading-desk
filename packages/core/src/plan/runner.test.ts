import { describe, it, expect, vi } from "vitest";
import { Network } from "wative-core";
import { WativeError } from "wative-core";
import { WativeChainRegistry, defaultChainOverlay } from "../chain/registry.js";
import { WativePlanRunner, SerialNonceLane } from "./runner.js";
import type { OnchainExecutor } from "./runner.js";
import type {
  SignerContext, WalletSigner, ChainId, Hex, PlanStep, ExecutionPlan, SpendCapPolicy, SafetyLabel, SpendEnforcer,
} from "@farm/adapter-api";

type SubmitFn = (sig: Hex | Uint8Array) => Promise<unknown>;

const registry = WativeChainRegistry.fromBuiltins(defaultChainOverlay());
const INK = Network.Ink.chainId as unknown as ChainId;
const INK_NUM = Number(Network.Ink.chainId);

const signer: WalletSigner = {
  address: { family: "evm", value: "0x2222222222222222222222222222222222222222" },
  signTypedData: async () => "0xSIG" as Hex,
  signDigest: async () => "0xDIGESTSIG" as Hex,
  signMessage: async () => "0xMSG" as Hex,
  signBytes: async () => new Uint8Array([1]),
};

function makeCtx(over: Partial<SignerContext> = {}): SignerContext {
  const runner = new WativePlanRunner(okExecutor());
  return {
    signer,
    account: { chainId: INK, owner: signer.address, raw: null },
    chain: registry.require(INK),
    walletId: "w0",
    onchainNonces: new SerialNonceLane(),
    protocolNonces: { timestamp: () => 1n, nextProtocolSeq: async () => 0 },
    runner,
    ...over,
  };
}

function okExecutor(): OnchainExecutor {
  return { send: async () => ({ hash: "0xHASH", success: true, raw: null }) };
}

const execStep = (submit: SubmitFn): PlanStep => ({
  type: "protocol-execute",
  typedData: { domain: {}, types: {}, primaryType: "Order", message: {} },
  chainId: INK_NUM,
  bucket: "nado:place",
  weight: 1,
  submit,
});

const onchainStep = (safety?: SafetyLabel): PlanStep => ({
  type: "onchain-tx",
  tx: { to: "0x1111111111111111111111111111111111111111", data: "0x", value: 0n, chainId: INK_NUM },
  bucket: `rpc:broadcast:${INK_NUM}`,
  weight: 1,
  safety,
});

const plan = (steps: PlanStep[]): ExecutionPlan => ({ steps, describe: "test plan" });

describe("WativePlanRunner", () => {
  it("signs a protocol-execute step and passes the signature to submit", async () => {
    const submit = vi.fn(async (sig: Hex | Uint8Array) => ({ echo: sig }));
    const runner = new WativePlanRunner(okExecutor());
    const res = await runner.run(plan([execStep(submit)]), makeCtx());
    expect(res.ok).toBe(true);
    expect(submit).toHaveBeenCalledWith("0xSIG");
    expect(res.stepResults[0]).toEqual({ echo: "0xSIG" });
  });

  it("stops and normalizes a submit failure to an AdapterError", async () => {
    const submit = async () => { throw new WativeError("RPC_REJECTED", "nope"); };
    const runner = new WativePlanRunner(okExecutor());
    const res = await runner.run(plan([execStep(submit)]), makeCtx());
    expect(res.ok).toBe(false);
    expect((res.stepResults.at(-1) as { category?: string }).category).toBe("rejected");
  });

  it("aborts when the confirm hook declines", async () => {
    const submit = vi.fn(async () => ({}));
    const runner = new WativePlanRunner(okExecutor());
    const step: PlanStep = { ...execStep(submit), preview: {
      summary: "place order", signedKind: "eip712", label: {
        destructive: false, grantsStandingAuth: false, movesFunds: false, requiresPrimaryKey: false, blastRadiusClass: "trading",
      }, warnings: [], decodedByCore: false, raw: null } };
    const res = await runner.run(plan([step]), makeCtx({ confirm: async () => false }));
    expect(res.ok).toBe(false);
    expect(res.stepResults).toHaveLength(0); // aborted before executing the step
    expect(submit).not.toHaveBeenCalled();
  });

  it("runs an onchain-tx via the executor and advances the serialized nonce lane", async () => {
    const lane = new SerialNonceLane();
    const sends: number[] = [];
    const exec: OnchainExecutor = { send: async () => { sends.push(1); return { hash: "0xHASH", success: true, raw: null }; } };
    const runner = new WativePlanRunner(exec);
    const res = await runner.run(plan([onchainStep()]), makeCtx({ onchainNonces: lane }));
    expect(res.ok).toBe(true);
    expect(res.txHashes).toEqual(["0xHASH"]);
    expect(sends).toHaveLength(1);
    expect(await lane.peek("w0", INK)).toBe(1); // committed → watermark advanced
  });

  it("refuses a step when the spend enforcer rejects it, without sending", async () => {
    let sent = 0;
    const exec: OnchainExecutor = { send: async () => { sent++; return { hash: "0x", success: true, raw: null }; } };
    const runner = new WativePlanRunner(exec);
    const enforcer: SpendEnforcer = { charge: () => ({ allowed: false, code: "PER_OP_CAP", reason: "too big" }) };
    const step: PlanStep = { ...onchainStep(), notionalUsd: 999 };
    const res = await runner.run(plan([step]), makeCtx({ enforcer }));
    expect(res.ok).toBe(false);
    expect((res.stepResults.at(-1) as { code?: string }).code).toBe("PER_OP_CAP");
    expect(sent).toBe(0);
  });

  it("refuses a step above the configured blast-radius cap without sending", async () => {
    let sent = 0;
    const exec: OnchainExecutor = { send: async () => { sent++; return { hash: "0x", success: true, raw: null }; } };
    const runner = new WativePlanRunner(exec);
    const caps: SpendCapPolicy = { enabled: true, maxBlastRadius: "trading" };
    const step = onchainStep({ destructive: false, grantsStandingAuth: false, movesFunds: true, requiresPrimaryKey: false, blastRadiusClass: "funds-move" });
    const res = await runner.run(plan([step]), makeCtx({ caps }));
    expect(res.ok).toBe(false);
    expect((res.stepResults.at(-1) as { code?: string }).code).toBe("BLAST_RADIUS_CAP");
    expect(sent).toBe(0);
  });
});

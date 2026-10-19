// =============================================================================
// @farm/core · plan runner — executes an ExecutionPlan. The correctness kernel
// (step ordering, stop-on-failure, permissive confirm/caps, error normalization)
// is core's; the actual on-chain send DELEGATES to wative: `buildTransaction`
// (nonce autofill) → `sendTransaction` → `TransactionTracker.whenConfirmed`.
//
// The wative send is isolated behind `OnchainExecutor` so the orchestration is
// unit-testable offline; `WativeOnchainExecutor` is the real, testnet-gated impl.
// =============================================================================
import type { EvmSigner } from "wative-core";
import type { EvmTxBuildParams, ChainId as WativeChainId } from "wative-core";
import type {
  PlanRunner, ExecutionPlan, PlanResult, PlanStep, SignerContext, SimulationResult,
  UnsignedTx, Hex, ChainId, WalletId, FeePolicy, BlastRadiusClass, SecurityWarning,
  OnChainNonceSource, NonceLease,
} from "@farm/adapter-api";
import { normalizeWativeError } from "../errors.js";

// ---------------------------------------------------------------------------
// On-chain executor seam — the ONE place that touches wative's tx lifecycle.
// ---------------------------------------------------------------------------
export interface OnchainSendResult { hash: string; success: boolean; raw: unknown }
export interface OnchainExecutor {
  send(tx: UnsignedTx, ctx: SignerContext): Promise<OnchainSendResult>;
}

function feeCeilingWei(fee?: FeePolicy): bigint | undefined {
  if (fee?.maxFeePerGasCeilingGwei === undefined) return undefined;
  return BigInt(Math.round(fee.maxFeePerGasCeilingGwei * 1e9));
}

/** The real on-chain executor: wative buildTransaction → sendTransaction → tracker. */
export class WativeOnchainExecutor implements OnchainExecutor {
  constructor(private readonly resolveEvmSigner: (walletId: WalletId, chainId: ChainId) => EvmSigner) {}

  async send(tx: UnsignedTx, ctx: SignerContext): Promise<OnchainSendResult> {
    const evm = this.resolveEvmSigner(ctx.walletId, tx.chainId as unknown as ChainId);
    const params: EvmTxBuildParams = {
      to: tx.to ?? null,
      value: tx.value ?? 0n,
      data: tx.data,
      chainId: tx.chainId as unknown as WativeChainId,
      gasLimit: tx.gasLimit,
      maxFeePerGasCeiling: feeCeilingWei(ctx.chain.fee),
      rpcUrl: ctx.chain.rpc.broadcast[0],
    };
    // wative owns nonce (watermark autofill), gas, signing, broadcast, tracking.
    const built = evm.buildTransaction(params);
    const tracker = evm.sendTransaction(built, {
      confirmations: ctx.chain.broadcast.confirmations,
    });
    const receipt = await tracker.whenConfirmed(ctx.chain.broadcast.confirmations);
    return { hash: receipt.hash, success: receipt.success, raw: receipt };
  }
}

// ---------------------------------------------------------------------------
// Serialized on-chain nonce lane — per (wallet, chain). Serializes concurrent
// on-chain sends so wative's buildTransaction watermark can't be raced; the nonce
// VALUE still comes from wative autofill (we don't pass an explicit nonce).
// ---------------------------------------------------------------------------
export class SerialNonceLane implements OnChainNonceSource {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly watermark = new Map<string, number>();
  constructor(private readonly peekFn?: (walletId: WalletId, chainId: ChainId) => Promise<number>) {}

  private key(walletId: WalletId, chainId: ChainId): string { return `${walletId}:${String(chainId)}`; }

  async lease(walletId: WalletId, chainId: ChainId): Promise<NonceLease> {
    const key = this.key(walletId, chainId);
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.tails.set(key, prior.then(() => gate));
    await prior; // wait our turn in the per-(wallet,chain) queue
    const nonce = this.watermark.get(key) ?? (this.peekFn ? await this.peekFn(walletId, chainId) : 0);
    let done = false;
    const finish = (): void => { if (!done) { done = true; release(); } };
    return {
      nonce,
      commit: () => { this.watermark.set(key, nonce + 1); finish(); },
      release: finish,
    };
  }

  async peek(walletId: WalletId, chainId: ChainId): Promise<number> {
    const key = this.key(walletId, chainId);
    const w = this.watermark.get(key);
    return w ?? (this.peekFn ? await this.peekFn(walletId, chainId) : 0);
  }

  reconcile(walletId: WalletId, chainId: ChainId, onChainNext: number): void {
    this.watermark.set(this.key(walletId, chainId), onChainNext);
  }
}

const BLAST_RANK: Record<BlastRadiusClass, number> = {
  none: 0, trading: 1, approval: 2, "funds-move": 3, "account-control": 4,
};

// ---------------------------------------------------------------------------
// The plan runner.
// ---------------------------------------------------------------------------
export class WativePlanRunner implements PlanRunner {
  constructor(private readonly onchain: OnchainExecutor) {}

  private capRefusal(step: PlanStep, ctx: SignerContext): SecurityWarning | null {
    // A stateful enforcer (per-op/wallet/cohort/global spend + blast radius) wins
    // when present; it CHARGES on attempt.
    if (ctx.enforcer) {
      const d = ctx.enforcer.charge({
        walletId: ctx.walletId,
        cohortId: ctx.account.subaccount?.label,
        usd: step.notionalUsd ?? 0,
        blastRadius: step.safety?.blastRadiusClass ?? "none",
      });
      return d.allowed ? null : { severity: "danger", code: d.code ?? "SPEND_CAP", message: d.reason ?? "spend cap exceeded" };
    }
    // fallback: static blast-radius ceiling from the policy
    const max = ctx.caps?.enabled ? ctx.caps.maxBlastRadius : undefined;
    if (!max || !step.safety) return null;
    if (BLAST_RANK[step.safety.blastRadiusClass] > BLAST_RANK[max]) {
      return { severity: "danger", code: "BLAST_RADIUS_CAP", message: `step blast radius '${step.safety.blastRadiusClass}' exceeds cap '${max}'` };
    }
    return null;
  }

  private async signExecute(step: Extract<PlanStep, { type: "protocol-execute" }>, ctx: SignerContext): Promise<Hex | Uint8Array> {
    if (step.typedData) {
      if (!ctx.signer.signTypedData) throw new Error("signer cannot signTypedData for a protocol-execute step");
      const chainId = step.chainId ?? Number(ctx.chain.chainId);
      return ctx.signer.signTypedData(step.typedData, chainId);
    }
    if (step.fallbackDigest) {
      if (!ctx.signer.signDigest) throw new Error("signer cannot signDigest for the fallback path");
      return ctx.signer.signDigest(step.fallbackDigest);
    }
    throw new Error("protocol-execute step has neither typedData nor fallbackDigest");
  }

  async run(plan: ExecutionPlan, ctx: SignerContext): Promise<PlanResult> {
    const stepResults: unknown[] = [];
    const txHashes: (Hex | string)[] = [];

    for (const step of plan.steps) {
      // permissive per-op confirm (A2): warn/confirm, never silently block
      if (ctx.confirm && step.preview) {
        const ok = await ctx.confirm(step.preview);
        if (!ok) return { ok: false, stepResults, txHashes, raw: { aborted: true, at: step } };
      }
      // optional spend caps: refuse only above a configured blast-radius ceiling
      const refusal = this.capRefusal(step, ctx);
      if (refusal) return { ok: false, stepResults: [...stepResults, refusal], txHashes, raw: refusal };

      if (step.type === "onchain-tx") {
        const lease = await ctx.onchainNonces.lease(ctx.walletId, step.tx.chainId as unknown as ChainId);
        try {
          const r = await this.onchain.send(step.tx, ctx);
          lease.commit();
          stepResults.push(r);
          txHashes.push(r.hash);
          if (!r.success) return { ok: false, stepResults, txHashes, raw: { reverted: step } };
        } catch (e) {
          lease.release();
          const ae = normalizeWativeError(e);
          return { ok: false, stepResults: [...stepResults, ae], txHashes, raw: ae };
        }
      } else {
        try {
          const sig = await this.signExecute(step, ctx);
          const res = await step.submit(sig);
          stepResults.push(res);
        } catch (e) {
          const ae = normalizeWativeError(e);
          return { ok: false, stepResults: [...stepResults, ae], txHashes, raw: ae };
        }
      }
    }
    return { ok: true, stepResults, txHashes, raw: null };
  }

  /** Light pre-flight: aggregate the steps' decoded-preview warnings. Deep on-chain
   *  simulation (ChainClient.simulate) is exercised on the live path. */
  async simulate(plan: ExecutionPlan, _ctx: SignerContext): Promise<SimulationResult> {
    const warnings: SecurityWarning[] = [];
    for (const step of plan.steps) if (step.preview) warnings.push(...step.preview.warnings);
    return { success: true, warnings, raw: { steps: plan.steps.length } };
  }
}

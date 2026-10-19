// =============================================================================
// @farm/core · chain primitives — the seam's `ChainPrimitives`, DELEGATED to
// wative's on-chain engine. This module is KEYLESS: it does RPC reads via
// `ChainClient`, encodes/decodes via `Contract`, screens destinations via
// `checkDestination`, and BUILDS `ExecutionPlan`s. The signing/sending of those
// plans is the PlanRunner's job (core/plan), which holds the wative `EvmSigner`.
//
// Nothing here re-implements RPC, calldata, ABI, or the destination guard — those
// are wative. Core adds only: the normalized seam views, the SafetyLabel overlay,
// and rate-cost resolution.
// =============================================================================
import { ChainClient, Contract, EvmTransaction, Network } from "wative-core";
import { ERC20 } from "wative-core/artifacts/evm";
import type { AbiItem, EvmAddress } from "wative-core";
import type {
  ChainPrimitives, ChainRegistry, ChainSpec, ChainId, Address, WalletId,
  Balance, AccountHandle, AdapterOp, RateCost, ChainCallInput, RawTxInput,
  ChainReadResult, ExecutionPlan, SignerContext, SignedPayloadPreview,
  ChainOperation, OpResultOf, ChainCallOp, TxReceiptView, SafetyLabel,
  DecodedArg, SecurityWarning, BlastRadiusClass, Decimal, Amount, Hex,
  UnsignedTx,
} from "@farm/adapter-api";
import { normalizeWativeError } from "../errors.js";

const ZERO_EVM = "0x0000000000000000000000000000000000000000" as EvmAddress;

export function formatUnits(raw: bigint, decimals: number): Decimal {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals) : "";
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}` as Decimal;
}

export function parseUnits(dec: string, decimals: number): bigint {
  const neg = dec.startsWith("-");
  const s = neg ? dec.slice(1) : dec;
  const [intPart = "0", fracIn = ""] = s.split(".");
  const frac = (fracIn + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(intPart + frac);
  return neg ? -v : v;
}

function stringifyVal(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
}

/** Core-added SafetyLabel overlay (wative has no op-intent classifier). */
export function classifySafety(method: string | undefined, value?: Amount): SafetyLabel {
  const m = (method ?? "").toLowerCase();
  const grantsStandingAuth = /^(approve|setapprovalforall|permit|increaseallowance)/.test(m);
  const movesFunds = /(transfer|deposit|withdraw|send)/.test(m) || (!!value && value !== "0");
  const destructive = /(cancel|revoke|burn)/.test(m);
  const blastRadiusClass: BlastRadiusClass = grantsStandingAuth ? "approval" : movesFunds ? "funds-move" : "trading";
  return { destructive, grantsStandingAuth, movesFunds, requiresPrimaryKey: false, blastRadiusClass };
}

export interface ChainPrimitivesOpts {
  registry: ChainRegistry;
  /** The SAME wative Networks the registry was built from (to construct ChainClient). */
  networks: readonly Network[];
}

export class WativeChainPrimitives implements ChainPrimitives {
  readonly chains: ChainRegistry;
  private readonly networkById = new Map<string, Network>();
  private readonly clients = new Map<string, ChainClient>();
  private readonly decimalsCache = new Map<string, number>();

  constructor(opts: ChainPrimitivesOpts) {
    this.chains = opts.registry;
    for (const n of opts.networks) this.networkById.set(String(n.chainId), n);
  }

  private addr(a: Address): string { return a.value; }
  private networkFor(chainId: ChainId): Network {
    const n = this.networkById.get(String(chainId));
    if (!n) throw normalizeWativeError(Object.assign(new Error(`no wative Network for chainId ${String(chainId)}`), { category: "network", retrySafe: false }));
    return n;
  }
  private clientFor(chainId: ChainId): ChainClient {
    const key = String(chainId);
    let c = this.clients.get(key);
    if (!c) { c = new ChainClient(this.networkFor(chainId)); this.clients.set(key, c); }
    return c;
  }
  private readUrl(spec: ChainSpec): string | undefined { return spec.rpc.read[0]; }
  private broadcastBucket(spec: ChainSpec): string {
    return spec.rateLimits.find((r) => r.bucket.startsWith("rpc:broadcast:"))?.bucket ?? `rpc:broadcast:${String(spec.chainId)}`;
  }

  costOf(op: AdapterOp): RateCost[] {
    const chainId = "chainId" in op ? op.chainId : undefined;
    if (chainId === undefined) return [];
    const spec = this.chains.get(chainId);
    if (!spec) return [];
    const want = op.kind === "readCall" ? `rpc:read:${String(chainId)}` : `rpc:broadcast:${String(chainId)}`;
    const b = spec.rateLimits.find((r) => r.bucket === want) ?? spec.rateLimits[0];
    return b ? [{ bucket: b.bucket, scope: b.scope, weight: 1 }] : [];
  }

  async resolveChainAccount(a: { owner: Address; chainId: ChainId; walletId?: WalletId }): Promise<AccountHandle> {
    return { chainId: a.chainId, owner: a.owner, walletId: a.walletId, raw: null };
  }

  async getNativeBalance(owner: Address, chainId: ChainId): Promise<Balance> {
    const spec = this.chains.require(chainId);
    try {
      const raw = await this.clientFor(chainId).readBalance(this.addr(owner), null, { rpcUrl: this.readUrl(spec) });
      const dec = formatUnits(raw, spec.nativeAsset.decimals);
      return { asset: "native", symbol: spec.nativeAsset.symbol, total: dec, available: dec, scope: "native", raw: { wei: raw.toString() } };
    } catch (e) { throw normalizeWativeError(e); }
  }

  async getErc20Balances(owner: Address, chainId: ChainId, tokens: readonly string[]): Promise<Balance[]> {
    const spec = this.chains.require(chainId);
    const client = this.clientFor(chainId);
    return Promise.all(tokens.map(async (t) => {
      try {
        const raw = await client.readBalance(this.addr(owner), t, { rpcUrl: this.readUrl(spec) });
        const decimals = await this.erc20Decimals(chainId, t);
        const dec = formatUnits(raw, decimals);
        return { asset: t, symbol: "", total: dec, available: dec, raw: { wei: raw.toString(), token: t } } satisfies Balance;
      } catch (e) { throw normalizeWativeError(e); }
    }));
  }

  /** eth_call VIEW via wative's EvmTransaction.simulate (keyless). Verified live at the testnet gate. */
  private async readView(chainId: ChainId, to: string, contract: Contract, method: string, args: readonly unknown[]): Promise<readonly unknown[]> {
    const spec = this.chains.require(chainId);
    const net = this.networkFor(chainId);
    const data = contract.encode(method, args);
    const tx = new EvmTransaction({ from: ZERO_EVM, to, value: 0n, chainId: net.chainId, data, rpcUrl: this.readUrl(spec) });
    const sim = await tx.simulate();
    if (!sim.success) {
      throw Object.assign(new Error(sim.error ?? `eth_call ${method} failed`), { category: "rejected", retrySafe: false, code: "RPC_REJECTED", raw: sim });
    }
    return contract.decode(method, sim.returnData ?? "0x");
  }

  private async erc20Decimals(chainId: ChainId, token: string): Promise<number> {
    const key = `${String(chainId)}:${token}`;
    const hit = this.decimalsCache.get(key);
    if (hit !== undefined) return hit;
    const decoded = await this.readView(chainId, token, ERC20, "decimals", []);
    const d = Number(decoded[0] ?? 18);
    this.decimalsCache.set(key, d);
    return d;
  }

  async readCall(i: ChainCallInput): Promise<ChainReadResult> {
    const contract = new Contract("adhoc", i.abi as ReadonlyArray<AbiItem>);
    const decoded = await this.readView(i.chainId, this.addr(i.to), contract, i.method, i.args);
    const outs = contract.abi.find((a) => a.type === "function" && a.name === i.method)?.outputs ?? [];
    const decodedArgs: DecodedArg[] = decoded.map((v, k) => ({ name: outs[k]?.name, type: outs[k]?.type ?? "unknown", value: stringifyVal(v) }));
    return { decoded: decodedArgs, raw: decoded };
  }

  async decode(i: ChainCallInput | RawTxInput): Promise<SignedPayloadPreview> {
    const spec = this.chains.require(i.chainId);
    const isCall = "method" in i && "abi" in i;
    let method: string;
    let decodedArgs: DecodedArg[];
    if (isCall) {
      const ci = i as ChainCallInput;
      method = ci.method;
      const contract = new Contract("adhoc", ci.abi as ReadonlyArray<AbiItem>);
      const ins = contract.abi.find((a) => a.type === "function" && a.name === ci.method)?.inputs ?? [];
      decodedArgs = ci.args.map((v, k) => ({ name: ins[k]?.name, type: ins[k]?.type ?? "unknown", value: stringifyVal(v) }));
    } else {
      const ri = i as RawTxInput;
      method = ri.data.slice(0, 10);
      decodedArgs = [{ type: "bytes", value: ri.data }];
    }
    const label = classifySafety(method, i.value);
    const warnings: SecurityWarning[] = [];
    if (label.grantsStandingAuth) warnings.push({ severity: "warn", code: "STANDING_AUTH", message: `${method} grants a standing allowance/approval` });
    if (i.to) {
      try {
        const report = await this.clientFor(i.chainId).checkDestination(this.addr(i.to));
        if (report.action !== "allow") {
          warnings.push({ severity: report.action === "refuse" ? "danger" : "warn", code: report.code ?? "DESTINATION", message: report.warnings.map((w) => w.detail).join("; ") || `destination ${report.action}` });
        }
      } catch { /* destination screen is best-effort */ }
    }
    return {
      summary: isCall ? `${method}(${decodedArgs.map((a) => a.value).join(", ")}) @ ${spec.displayName}` : `raw tx ${method} @ ${spec.displayName}`,
      signedKind: "raw-tx", chainId: i.chainId, to: i.to, method, decodedArgs, value: i.value,
      label, warnings, decodedByCore: true, raw: i,
    };
  }

  async prepareChainCall(_ctx: SignerContext, i: ChainCallInput): Promise<ExecutionPlan> {
    const spec = this.chains.require(i.chainId);
    const contract = new Contract("adhoc", i.abi as ReadonlyArray<AbiItem>);
    const data = contract.encode(i.method, i.args) as Hex;
    const tx: UnsignedTx = {
      to: this.addr(i.to) as Hex, data,
      value: i.value ? parseUnits(i.value, spec.nativeAsset.decimals) : undefined,
      chainId: Number(i.chainId), gasLimit: i.gasLimit,
    };
    const preview = await this.decode(i);
    return { describe: `chainCall ${i.method} @ ${spec.displayName}`, preview, steps: [{ type: "onchain-tx", tx, bucket: this.broadcastBucket(spec), weight: 1, preview, safety: preview.label }] };
  }

  async prepareRawTx(_ctx: SignerContext, i: RawTxInput): Promise<ExecutionPlan> {
    const spec = this.chains.require(i.chainId);
    const tx: UnsignedTx = {
      to: i.to ? (this.addr(i.to) as Hex) : undefined, data: i.data,
      value: i.value ? parseUnits(i.value, spec.nativeAsset.decimals) : undefined,
      chainId: Number(i.chainId), gasLimit: i.gasLimit,
    };
    const preview = await this.decode(i);
    return { describe: `rawTx @ ${spec.displayName}`, preview, steps: [{ type: "onchain-tx", tx, bucket: this.broadcastBucket(spec), weight: 1, preview, safety: preview.label }] };
  }

  async execute<O extends ChainOperation>(ctx: SignerContext, op: O): Promise<OpResultOf<O>> {
    const plan = op.kind === "chainCall" ? await this.prepareChainCall(ctx, op.input) : await this.prepareRawTx(ctx, op.input);
    const res = await ctx.runner.run(plan, ctx);
    const view: TxReceiptView = {
      chainId: op.chainId,
      hash: res.txHashes[0] ?? "",
      status: res.ok ? "success" : "reverted",
      raw: res, // the whole PlanResult (avoid reading the seam `.raw` escape-hatch in core)
    };
    return view as OpResultOf<O>;
  }

  normalizeError(e: unknown): ReturnType<typeof normalizeWativeError> { return normalizeWativeError(e); }

  /** A2 evacuate: revoke an ERC-20 allowance via wative's bundled ERC20 artifact. */
  revokeApprovalOp(chainId: ChainId, token: Address, spender: Address): ChainCallOp {
    return {
      kind: "chainCall", chainId,
      input: {
        chainId, to: token, abi: ERC20.abi, method: "approve",
        args: [this.addr(spender), 0n],
        clientId: `revoke:${String(chainId)}:${this.addr(token)}:${this.addr(spender)}`,
      },
    };
  }
}

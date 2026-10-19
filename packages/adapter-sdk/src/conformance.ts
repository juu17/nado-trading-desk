// =============================================================================
// @farm/adapter-sdk · conformance suite — the "over-abstraction detector". Any
// ProtocolAdapter must pass this to be wired into the console: it checks the
// UNIVERSAL port contract (manifest/supports/capability/error/label) plus the
// EIP-712 sign→recover conformance (every execute's typed-data recovers to the
// owner). Run it as a property test in CI so an adapter can't drift.
// =============================================================================
import type {
  ProtocolAdapter, ProtocolOperation, Eip712TypedData, Hex, SignerContext, OperationKind, CapabilityId,
} from "@farm/adapter-api";

export interface Eip712Case { label: string; typedData: Eip712TypedData; chainId: number }

export interface ConformanceInput {
  adapter: ProtocolAdapter;
  owner: string;
  /** Sign a typed-data with the key under test. */
  sign: (td: Eip712TypedData, chainId: number) => Promise<Hex>;
  /** Canonically recover the signer address (e.g. viem recoverTypedDataAddress). */
  recover: (td: Eip712TypedData, sig: Hex) => Promise<string>;
  eip712Cases: readonly Eip712Case[];
  sampleOps?: readonly ProtocolOperation[];
  previewCtx?: SignerContext; // supply to also exercise preview()
}

export interface ConformanceCheck { name: string; ok: boolean; detail?: string }
export interface ConformanceResult { checks: ConformanceCheck[]; passed: boolean }

const ALL_OPS: OperationKind[] = [
  "placeOrder", "cancel", "replace", "supply", "borrow", "repay", "withdrawSupply", "chainCall", "rawTx",
];
const CAP_IDS: CapabilityId[] = ["trading", "lending", "swap"];

export async function runConformance(input: ConformanceInput): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = [];
  const add = (name: string, ok: unknown, detail?: string): void => { checks.push({ name, ok: Boolean(ok), detail }); };
  const { adapter } = input;
  const m = adapter.manifest;

  // 1. manifest validity
  add("manifest.id", typeof m.id === "string" && m.id.length > 0);
  add("manifest.version>0", m.version > 0);
  add("manifest.chains", m.chains.length > 0);
  add("manifest.supportedOps", m.supportedOps.length > 0);

  // 2. supports() agrees with supportedOps for every op kind
  for (const k of ALL_OPS) {
    const declared = m.supportedOps.includes(k);
    add(`supports(${k})`, adapter.supports(k) === declared, `supports=${adapter.supports(k)} declared=${declared}`);
  }

  // 3. capability accessor matches the manifest's implemented set
  for (const id of CAP_IDS) {
    const impl = m.capabilities.implemented.includes(id);
    const got = adapter.capability(id) !== undefined;
    add(`capability(${id})`, impl === got, `implemented=${impl} present=${got}`);
  }

  // 4. normalizeError yields a well-formed AdapterError
  const ae = adapter.normalizeError(new Error("boom"));
  add("normalizeError.shape", typeof ae.category === "string" && typeof ae.retrySafe === "boolean");

  // 5. labelOperation (+ optional preview) for each sample op
  for (const op of input.sampleOps ?? []) {
    const label = adapter.labelOperation(op);
    add(`labelOperation(${op.kind})`, label && typeof label.blastRadiusClass === "string");
    if (input.previewCtx) {
      try {
        const p = await adapter.preview(input.previewCtx, op);
        add(`preview(${op.kind})`, Boolean(p.summary) && Boolean(p.label));
      } catch (e) { add(`preview(${op.kind})`, false, (e as Error).message); }
    }
  }

  // 6. EIP-712 sign + recover — the core conformance
  for (const c of input.eip712Cases) {
    try {
      const sig = await input.sign(c.typedData, c.chainId);
      const rec = await input.recover(c.typedData, sig);
      add(`eip712:${c.label}`, rec.toLowerCase() === input.owner.toLowerCase(), `recovered ${rec}`);
    } catch (e) { add(`eip712:${c.label}`, false, (e as Error).message); }
  }

  return { checks, passed: checks.every((c) => c.ok) };
}

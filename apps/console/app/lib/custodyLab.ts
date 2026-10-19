// =============================================================================
// In-browser custody lab (client-only, lazy-loaded). Proves the 1000-wallet vision's
// client-side custody path: generate a FRESH wallet entirely in the browser via
// wative-core's browser build (IndexedDB-backed Workspace), sign a Nado-shaped
// place_order EIP-712 IN THE BROWSER, and recover it — the key is created and used
// in the browser and never leaves it. This is separate from the funded server-side
// wallet (which stays server-side); it demonstrates the custody primitive only.
// Heavy deps (wative-core) load on demand so the main bundle stays lean.
// =============================================================================
import { activeChainId } from "./chainEnv"; // the SELECTED network (sign the lab self-test for the live chain)

export interface CustodyLabResult {
  address: `0x${string}`;
  signature: `0x${string}`;
  recovered: `0x${string}`;
  match: boolean;
  mnemonicWords: number;
}

// A representative Nado place_order EIP-712 (same message shape the adapter signs).
// For the lab the signature is recovered locally, not submitted, so a self-consistent
// typed-data is what matters — we mirror Nado's Order fields to stay faithful.
function sampleOrderTypedData(sender: `0x${string}`, chainId: number) {
  const subaccount = (`0x${sender.slice(2)}64656661756c740000000000`) as `0x${string}`; // owner + "default"
  return {
    domain: { name: "Nado", version: "0.0.1", chainId, verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}` },
    types: {
      Order: [
        { name: "sender", type: "bytes32" },
        { name: "priceX18", type: "int128" },
        { name: "amount", type: "int128" },
        { name: "expiration", type: "uint64" },
        { name: "nonce", type: "uint64" },
        { name: "appendix", type: "uint64" },
      ],
    },
    primaryType: "Order" as const,
    message: {
      sender: subaccount,
      priceX18: 50000n * 10n ** 18n,
      amount: 10n ** 15n,
      expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: 1n,
      appendix: 1537n,
    },
  };
}

interface BrowserEvmSigner { publicKey: string; signTypedData(td: unknown, chainId: number | bigint): { signature: string } }
interface BrowserWative {
  newMnemonic: (words?: number) => string;
  IdbProviderV3: { create(name: string, opts?: { acknowledgeEvictionRisk?: boolean }): Promise<unknown> };
  Workspace: { open(provider: unknown, password?: string, create?: boolean): Promise<{
    accounts: { create(displayName: string, password: string, secret: string): Promise<{
      wallets: BrowserEvmSigner extends never ? never : Array<{ evm: BrowserEvmSigner | null }>;
      deriveWallets(count: number): Promise<unknown>;
    }> };
  }> };
}

export async function runInBrowserCustody(): Promise<CustodyLabResult> {
  const wative = (await import("wative-core")) as unknown as BrowserWative;
  const { recoverTypedDataAddress } = await import("viem");

  const password = `lab-${Date.now()}-${Math.random().toString(36).slice(2)}Aa1!`; // ephemeral, in-memory
  // The lab wallet is a DISPOSABLE demo cache (not funded, keys not retained), so we
  // acknowledge the browser's storage-eviction risk rather than demanding persistence.
  const provider = await wative.IdbProviderV3.create(`nado-ika-custody-lab-${Date.now()}`, { acknowledgeEvictionRisk: true });
  const ws = await wative.Workspace.open(provider, password, true);
  const acc = await ws.accounts.create("lab", password, wative.newMnemonic(12));
  if (acc.wallets.length === 0) await acc.deriveWallets(1);
  const evm = acc.wallets[0]?.evm;
  if (!evm) throw new Error("no EVM signer on the in-browser wallet");

  const address = evm.publicKey as `0x${string}`;
  const chainId = activeChainId();
  const typedData = sampleOrderTypedData(address, chainId);
  const { signature } = evm.signTypedData(typedData, chainId);
  const recoverArg = { ...typedData, signature: signature as `0x${string}` } as Parameters<typeof recoverTypedDataAddress>[0];
  const recovered = await recoverTypedDataAddress(recoverArg);
  return {
    address, signature: signature as `0x${string}`, recovered: recovered as `0x${string}`,
    match: recovered.toLowerCase() === address.toLowerCase(),
    mnemonicWords: 12,
  };
}

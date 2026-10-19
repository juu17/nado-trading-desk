// =============================================================================
// Client-side IN-TAB signing proof. The live ORDER path now runs through the full
// adapter (see liveContext.ts); this module keeps only the sequencer-FREE verification
// used by the custody panel: sign a real Nado place_order EIP-712 IN-TAB and recover it,
// confirming the whole client path (wative browser custody + @nadohq SDK + adapter
// builder) bundles and signs in the tab — independent of the sequencer.
// =============================================================================
import { buildPlaceOrderTypedData } from "@farm/adapter-nado";
import type { PlaceOrderInput, Decimal } from "@farm/adapter-api";
import { signerForWalletId } from "./custody";
import { activeChainId } from "./chainEnv"; // the SELECTED network (sign the self-test for the live chain)

export interface InTabProduct { marketId: string; productId: number; tickSize: string; stepSize: string; minSize: string }

/** Sign a real Nado place_order EIP-712 IN-TAB and recover it, proving the full client
 *  signing path works without touching the sequencer. */
export async function verifyInTabSigning(walletId: string, product: InTabProduct): Promise<{ address: string; signature: string; recovered: string; match: boolean }> {
  const signer = signerForWalletId(walletId);
  const owner = signer.address.value;
  const input: PlaceOrderInput = { market: product.marketId, side: "buy", kind: "limit", size: product.minSize as Decimal, price: "70000" as Decimal, postOnly: true, clientId: "verify" };
  const chainId = activeChainId();
  const built = buildPlaceOrderTypedData(input, { chainId, productId: product.productId, ownerAddress: owner });
  const signature = await signer.signTypedData!(built.typedData, chainId);
  const { recoverTypedDataAddress } = await import("viem");
  const recoverArg = { ...built.typedData, signature: signature as `0x${string}` } as Parameters<typeof recoverTypedDataAddress>[0];
  const recovered = await recoverTypedDataAddress(recoverArg);
  return { address: owner, signature, recovered, match: recovered.toLowerCase() === owner.toLowerCase() };
}

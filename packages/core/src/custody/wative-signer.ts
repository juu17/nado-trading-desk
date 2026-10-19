import type { Address as WativeAddress } from "wative-core";
import type { WalletSigner, Address, Hex, Eip712TypedData } from "@farm/adapter-api";

/**
 * Adapts a wative-core EVM `Address` to the seam's chain-neutral `WalletSigner`.
 * Keys never leave custody; the adapter only ever sees this signer. wative's
 * signing is synchronous; we wrap it in the seam's async contract.
 *
 * `toViemAccount` is intentionally NOT implemented — wative 2.6.0 has no native
 * bridge, and the proven path (Phase 1a) is for the adapter to wrap this signer
 * in viem's `toAccount()`. So the seam's optional `toViemAccount` stays absent.
 */
export class WativeWalletSigner implements WalletSigner {
  readonly address: Address;

  constructor(private readonly evm: WativeAddress) {
    if (evm.vm !== "evm") throw new Error("WativeWalletSigner requires an EVM address");
    this.address = { family: "evm", value: evm.publicKey as Hex };
  }

  async signTypedData(td: Eip712TypedData, chainId: number): Promise<Hex> {
    // wative's strict EIP-712 validator — proven byte-equal to the Nado SDK (Phase 1a).
    return this.evm.signTypedData(td as never, chainId).signature as Hex;
  }

  async signDigest(digest: Hex): Promise<Hex> {
    return this.evm.signDigest(digest).signature as Hex;
  }

  async signMessage(msg: string | Uint8Array): Promise<Hex | Uint8Array> {
    if (typeof msg !== "string") {
      throw new Error("EVM signMessage expects a string; use signDigest for a 32-byte digest");
    }
    return this.evm.signMessage(msg) as Hex;
  }

  async signBytes(_bytes: Uint8Array): Promise<Uint8Array> {
    // Raw-bytes signing is the SVM/ed25519 path; EVM executes go through
    // signTypedData / signDigest.
    throw new Error("signBytes is the SVM/raw path; not supported on an EVM WativeWalletSigner");
  }
}

import { Workspace } from "wative-core";
import type { Account, OpenOptions } from "wative-core";
import type { WalletSigner } from "@farm/adapter-api";
import { WativeWalletSigner } from "./wative-signer.js";

/**
 * Thin, isomorphic wrapper over a wative-core Workspace. Persistence is injected
 * via `OpenOptions` — `IdbProviderV3` in the attended browser (D1), a filesystem
 * provider in Node tests — so core stays protocol- and host-agnostic.
 *
 * A "cohort" (D6) is one HD `Account`; `signerFor` yields the seam `WalletSigner`
 * for one derived wallet. The adapter never touches the Workspace or key material.
 */
export class Custody {
  private constructor(private readonly ws: Workspace) {}

  static async open(opts: OpenOptions): Promise<Custody> {
    return new Custody(await Workspace.open(opts));
  }

  /** Create an HD cohort from a BIP-39 mnemonic. */
  createCohort(name: string, password: string, mnemonic: string): Promise<Account> {
    return this.ws.accounts.create(name, password, mnemonic);
  }

  /**
   * The raw wative `EvmSigner` for one wallet — used INTERNALLY by core/chain +
   * core/plan for on-chain work (`Contract.call`, `buildTransaction`,
   * `sendTransaction`). Never handed to an adapter; adapters get the WalletSigner.
   */
  evmSignerFor(account: Account, walletIndex: number) {
    const wallet = account.wallets[walletIndex];
    if (!wallet) throw new Error(`no wallet at index ${walletIndex}`);
    const evm = wallet.evm; // idiomatic EvmSigner accessor (an Address subclass)
    if (!evm) throw new Error("wallet has no EVM signer");
    return evm;
  }

  /** The seam WalletSigner for one wallet (derivation slot) of a cohort. */
  signerFor(account: Account, walletIndex: number, _chainId: number): WalletSigner {
    return new WativeWalletSigner(this.evmSignerFor(account, walletIndex));
  }

  lock(): Promise<void> {
    return this.ws.lock();
  }
}

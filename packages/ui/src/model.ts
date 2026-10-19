// =============================================================================
// @farm/ui · view-model — the protocol-agnostic shapes the console shell renders.
// Pure types; no React, no Kumo. Derived from the seam, kept thin so any adapter's
// data projects into one card grid.
// =============================================================================
import type { Address } from "@farm/adapter-api";

export type AccountKind = "HD" | "PK";
export type WalletStatus = "active" | "idle" | "paused" | "error";
export type Readiness = "unfunded" | "funded" | "ready";

export interface AccountVM {
  id: string;
  name: string;
  kind: AccountKind;
  walletCount: number;
}

/** One wallet = one briefing card. */
export interface WalletVM {
  id: string;
  accountId: string;
  accountName: string;      // HD-account badge text
  accountKind: AccountKind;
  index: number;            // derivation slot within the account
  address: Address;
  cohorts: string[];        // cohort = tag (rides wative Wallet tags)
  nativeBalance: string;    // display decimal
  quoteBalance: string;     // display decimal (USD-ish quote)
  status: WalletStatus;
  readiness: Readiness;
  openOrders: number;
}

export interface Fleet {
  accounts: AccountVM[];
  wallets: WalletVM[];
  cohorts: string[];
}

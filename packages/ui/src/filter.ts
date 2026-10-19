// =============================================================================
// @farm/ui · filter logic — pure, so the sidebar's Account multi-checkbox filter
// and the cohort filter are unit-tested without the DOM.
// =============================================================================
import type { WalletVM, AccountVM, AccountKind } from "./model.js";

export interface AccountOption {
  id: string;
  name: string;
  kind: AccountKind;
  count: number;
}

export function accountOptions(accounts: readonly AccountVM[]): AccountOption[] {
  return accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, count: a.walletCount }));
}

/**
 * Include only wallets whose account is in `includedAccountIds`, intersected with
 * `includedCohorts` when any are given. An empty account set means "no accounts
 * selected" → no wallets (the sidebar starts with all accounts checked).
 */
export function filterWallets(
  wallets: readonly WalletVM[],
  includedAccountIds: readonly string[],
  includedCohorts: readonly string[] = [],
): WalletVM[] {
  const accts = new Set(includedAccountIds);
  const cohorts = new Set(includedCohorts);
  return wallets.filter((w) => {
    if (!accts.has(w.accountId)) return false;
    if (cohorts.size > 0 && !w.cohorts.some((c) => cohorts.has(c))) return false;
    return true;
  });
}

export function cohortsOf(wallets: readonly WalletVM[]): string[] {
  const set = new Set<string>();
  for (const w of wallets) for (const c of w.cohorts) set.add(c);
  return [...set].sort();
}

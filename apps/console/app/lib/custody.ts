// =============================================================================
// IN-BROWSER custody (client-only, lazy-loaded). The operator's tab holds a wative-core
// BROWSER Workspace (IdbProviderV3) — ONE vault, unlocked with a password typed in the tab,
// holding MANY accounts. wative has two account kinds: HD (a mnemonic → deriveWallets) and PK
// (raw private keys → importPrivateKey). Keys are generated OR imported in-tab and NEVER leave
// it — signing happens client-side; only signed payloads cross to the keyless relay.
//
// Wallet identity: every EVM wallet across all accounts is flattened, in account-then-index
// order, to a stable per-session handle `live:<globalIndex>` (so the live trading/funding path
// and TREASURY_WALLET_ID="live:0" are unchanged); each CohortWallet also carries its owning
// account (slug/name/kind) for grouping on the Accounts page.
// =============================================================================
import type { WalletSigner, Hex, Eip712TypedData, Address } from "@farm/adapter-api";
// Type-only (no runtime/bundle cost — the wative module itself stays lazy-loaded below), so the in-tab
// FUNDING path can call buildTransaction on the sealed signer type-safely instead of a blind cast.
import type { Address as WativeEvmAddress } from "wative-core";

export type AccountKind = "HD" | "PK";
export interface CohortWallet {
  walletId: string; index: number; address: `0x${string}`; subaccountHex: string;
  accountSlug: string; accountName: string; accountKind: AccountKind;
}
export interface AccountVM { slug: string; name: string; kind: AccountKind; walletCount: number }
export type VaultStatus = "absent" | "locked" | "unlocked";

// Keeps the project's FORMER name (Nado-ika) on purpose: this is the IndexedDB holding every operator's
// encrypted vault — renaming it would orphan existing vaults (the app would see "no vault"). Do not rename.
const DB_NAME = "nado-ika-custody"; // persistent per-browser; survives reloads
const FLEET_ACCT = "fleet";         // the default single-account name used by the legacy cohort flows

interface BrowserEvm { publicKey: string; vm: string; signTypedData(td: unknown, chainId: number | bigint): { signature: string }; signDigest(d: string): { signature: string } }
// The raw wative EVM Address (a superset of BrowserEvm) — carries the build→sign→send
// surface the in-tab FUNDING path drives directly. The key stays SEALED inside it; it
// only ever returns signed bytes (Contract.call → buildTransaction → sign). `buildTransaction`
// is picked off the real wative Address so refuelGasLive builds a native send without a blind cast.
export type InTabEvmAddress = BrowserEvm & { readonly vm: "evm"; readonly network: unknown } & Pick<WativeEvmAddress, "buildTransaction">;

interface BrowserWallet { evm: BrowserEvm | null }
interface BrowserAccount {
  readonly slug: string; displayName: string; readonly organizationType?: string;
  wallets: BrowserWallet[];
  tryUnlock(pw?: string): Promise<unknown>;
  deriveWallets(n: number): Promise<unknown>;
  importPrivateKey(key: string, vm?: string): Promise<unknown>;
  rename(displayName: string): Promise<unknown>;
  drop(): Promise<unknown>;
}
interface BrowserAccountCollection {
  create(name: string, pw: string, secret: string): Promise<BrowserAccount>;
  bySlug(slug: string): BrowserAccount | null;
  drop(account: BrowserAccount): Promise<unknown>;
  length: number;
  [i: number]: BrowserAccount;
}
interface BrowserWorkspace { accounts: BrowserAccountCollection & BrowserAccount[] }
interface BrowserWative {
  newMnemonic: (words?: number) => string;
  IdbProviderV3: { create(name: string, opts?: { acknowledgeEvictionRisk?: boolean }): Promise<unknown> };
  Workspace: { open(provider: unknown, password?: string, create?: boolean): Promise<BrowserWorkspace> };
}

let nado: BrowserWative | null = null;
async function wative(): Promise<BrowserWative> {
  if (!nado) nado = (await import("wative-core")) as unknown as BrowserWative;
  return nado;
}
async function sdk(): Promise<{ subaccountToHex: (p: { subaccountOwner: string; subaccountName: string }) => string }> {
  return (await import("@nadohq/client")) as unknown as { subaccountToHex: (p: { subaccountOwner: string; subaccountName: string }) => string };
}

// The unlocked in-tab vault session: the open Workspace + its accounts, plus the flattened wallet VM
// list and a walletId→signer map (keys in memory + IndexedDB; never serialized out).
interface SessionAccount { acc: BrowserAccount; slug: string; name: string; kind: AccountKind }
let session: {
  ws: BrowserWorkspace;
  accounts: SessionAccount[];
  wallets: CohortWallet[];
  evmByWalletId: Map<string, BrowserEvm>;
} | null = null;

async function provider(): Promise<unknown> {
  const w = await wative();
  // disposable-cache ack: the eviction risk is acceptable for the operator's own vault
  return w.IdbProviderV3.create(DB_NAME, { acknowledgeEvictionRisk: true });
}

function kindOf(acc: BrowserAccount): AccountKind {
  // wative exposes the account kind via organizationType; PK (imported-key) accounts can't derive.
  const t = String(acc.organizationType ?? "").toLowerCase();
  return /pk|import|key/.test(t) ? "PK" : "HD";
}

// Flatten every EVM wallet across all session accounts → live:<globalIndex>, rebuilding the VM list
// and the walletId→signer map. SVM-only wallets (a PK account can hold them) are skipped.
async function rebuildFlat(): Promise<CohortWallet[]> {
  if (!session) return [];
  const { subaccountToHex } = await sdk();
  const wallets: CohortWallet[] = [];
  const evmByWalletId = new Map<string, BrowserEvm>();
  let g = 0;
  for (const sa of session.accounts) {
    for (let j = 0; j < sa.acc.wallets.length; j++) {
      const evm = sa.acc.wallets[j]?.evm;
      if (!evm) continue;
      const walletId = `live:${g}`;
      const address = evm.publicKey as `0x${string}`;
      wallets.push({
        walletId, index: g, address,
        subaccountHex: subaccountToHex({ subaccountOwner: address, subaccountName: "default" }),
        accountSlug: sa.slug, accountName: sa.name, accountKind: sa.kind,
      });
      evmByWalletId.set(walletId, evm);
      g++;
    }
  }
  session.wallets = wallets;
  session.evmByWalletId = evmByWalletId;
  return wallets;
}

// Load (or reload) every account from an open workspace into the session, unlocking each with the
// workspace password (shared accounts auto-open; we don't use per-account passwords).
async function loadSession(ws: BrowserWorkspace, password: string): Promise<void> {
  const accounts: SessionAccount[] = [];
  for (let i = 0; i < ws.accounts.length; i++) {
    const acc = ws.accounts[i]!;
    await acc.tryUnlock(password);
    accounts.push({ acc, slug: acc.slug, name: acc.displayName, kind: kindOf(acc) });
  }
  session = { ws, accounts, wallets: [], evmByWalletId: new Map() };
  await rebuildFlat();
}

function isWorkspaceLocked(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === "WORKSPACE_LOCKED" || /workspace_locked/i.test(msg);
}

// Create an account (HD from a mnemonic, PK from a private key) in the live session, opening/creating
// the vault first if needed. wative seals the new secret with the WORKSPACE password, which a
// KEK-resumed session no longer holds (unlock no-ops on an unlocked KEK) → WORKSPACE_LOCKED; recover by
// re-opening (re-auth) with the password + retrying. Returns the new account's session entry.
async function addAccount(name: string, password: string, secret: string, kind: AccountKind): Promise<SessionAccount> {
  const w = await wative();
  if (!session) await loadSession(await w.Workspace.open(await provider(), password, true), password);
  let acc: BrowserAccount;
  try {
    acc = await session!.ws.accounts.create(name, password, secret);
  } catch (e) {
    if (!isWorkspaceLocked(e)) throw e;
    await loadSession(await w.Workspace.open(await provider(), password, false), password); // re-auth
    acc = await session!.ws.accounts.create(name, password, secret);
  }
  const sa: SessionAccount = { acc, slug: acc.slug, name: acc.displayName, kind };
  session!.accounts.push(sa);
  await rebuildFlat();
  return sa;
}

// ---- vault lifecycle (the Accounts-page / entry-gate surface) -----------------------
/** Is there a vault on this device, and is it open? absent → onboard, locked → unlock, unlocked → app. */
export async function vaultStatus(): Promise<VaultStatus> {
  if (session) return "unlocked";
  try {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === DB_NAME) ? "locked" : "absent";
  } catch { return "absent"; }
}

/** Create a fresh, EMPTY vault (onboarding) with a workspace password. */
export async function createVault(password: string): Promise<void> {
  const w = await wative();
  await loadSession(await w.Workspace.open(await provider(), password, true), password);
}

/** Open + unlock the existing vault, loading all accounts. Returns the account list. */
export async function unlockVault(password: string): Promise<AccountVM[]> {
  const w = await wative();
  await loadSession(await w.Workspace.open(await provider(), password, false), password);
  return listAccounts();
}

/** Create an HD account (fresh mnemonic when none is given) and derive `count` wallets (min 1). */
export async function createHdAccount(name: string, password: string, mnemonic: string | undefined, count = 1): Promise<AccountVM[]> {
  const w = await wative();
  const sa = await addAccount(name, password, (mnemonic ?? w.newMnemonic(12)).trim(), "HD");
  const need = Math.max(1, count) - sa.acc.wallets.length;
  if (need > 0) { await sa.acc.deriveWallets(need); await rebuildFlat(); }
  return listAccounts();
}

/** Create a PK account from one or more raw private keys (one key = one wallet). */
export async function createPkAccount(name: string, password: string, keys: string[]): Promise<AccountVM[]> {
  const cleaned = keys.map((k) => k.trim()).filter(Boolean);
  const [first, ...rest] = cleaned;
  if (!first) throw new Error("no private keys provided");
  const sa = await addAccount(name, password, first, "PK");
  for (const k of rest) await sa.acc.importPrivateKey(k, "evm");
  await rebuildFlat();
  return listAccounts();
}

/** Derive N more HD wallets into an existing account (the account is already unlocked). */
export async function deriveMore(slug: string, n: number): Promise<AccountVM[]> {
  const sa = session?.accounts.find((a) => a.slug === slug);
  if (!sa) throw new Error(`no account ${slug}`);
  if (sa.kind !== "HD") throw new Error("only HD accounts derive wallets");
  await sa.acc.deriveWallets(Math.max(1, n));
  await rebuildFlat();
  return listAccounts();
}

/** Import more private keys into an existing PK account. */
export async function importKeys(slug: string, keys: string[]): Promise<AccountVM[]> {
  const sa = session?.accounts.find((a) => a.slug === slug);
  if (!sa) throw new Error(`no account ${slug}`);
  if (sa.kind !== "PK") throw new Error("only PK accounts import keys");
  for (const k of keys.map((x) => x.trim()).filter(Boolean)) await sa.acc.importPrivateKey(k, "evm");
  await rebuildFlat();
  return listAccounts();
}

/** Rename an account's display name. The wallet VMs carry accountName, so rebuild the flat list. */
export async function renameAccount(slug: string, name: string): Promise<AccountVM[]> {
  const sa = session?.accounts.find((a) => a.slug === slug);
  if (!sa) throw new Error(`no account ${slug}`);
  const next = name.trim();
  if (!next) throw new Error("account name required");
  await sa.acc.rename(next);
  sa.name = next; // reflect the new name in the session VM + the flattened wallets
  await rebuildFlat();
  return listAccounts();
}

/** DESTRUCTIVE: permanently drop an account and ALL its in-tab wallets/keys from the vault. */
export async function dropAccount(slug: string): Promise<AccountVM[]> {
  if (!session) throw new Error("vault is locked");
  const i = session.accounts.findIndex((a) => a.slug === slug);
  if (i < 0) throw new Error(`no account ${slug}`);
  await session.ws.accounts.drop(session.accounts[i]!.acc);
  session.accounts.splice(i, 1);
  await rebuildFlat();
  return listAccounts();
}

/** The accounts in the open vault (for the Accounts page / account filter). */
export function listAccounts(): AccountVM[] {
  return (session?.accounts ?? []).map((a) => ({
    slug: a.slug, name: a.name, kind: a.kind,
    walletCount: a.acc.wallets.filter((w) => w.evm).length,
  }));
}

/** The EVM addresses of one account's wallets (for export) — the flat cohort filtered by slug. */
export function accountAddresses(slug: string): string[] {
  return cohortWallets().filter((w) => w.accountSlug === slug).map((w) => w.address);
}

// ---- legacy single-"fleet"-account cohort flows (home page / existing tests) --------
/** Generate a FRESH N-wallet HD cohort (one "fleet" account) entirely in the tab. */
export async function generateCohort(n: number, password: string): Promise<CohortWallet[]> {
  await createHdAccount(FLEET_ACCT, password, undefined, n);
  return cohortWallets();
}

/** Import an existing mnemonic as the "fleet" HD account and derive N wallets. */
export async function importCohort(mnemonic: string, n: number, password: string): Promise<CohortWallet[]> {
  await createHdAccount(FLEET_ACCT, password, mnemonic, n);
  return cohortWallets();
}

/** Import a "fleet" PK cohort from raw EVM private keys — one key per wallet. */
export async function importCohortByPrivateKeys(keys: string[], password: string): Promise<CohortWallet[]> {
  await createPkAccount(FLEET_ACCT, password, keys);
  return cohortWallets();
}

export function isUnlocked(): boolean { return session !== null; }
export function cohortWallets(): CohortWallet[] { return session?.wallets ?? []; }

/** A seam WalletSigner backed by the in-tab wative EVM signer for a walletId. The key never
 *  leaves the browser; this only ever returns a signature over supplied data. */
export function signerForWalletId(walletId: string): WalletSigner {
  if (!session) throw new Error("in-tab custody is locked");
  const evm = session.evmByWalletId.get(walletId);
  if (!evm) throw new Error(`no in-tab signer for ${walletId}`);
  const address: Address = { family: "evm", value: evm.publicKey as `0x${string}` };
  return {
    address,
    async signTypedData(td: Eip712TypedData, chainId: number): Promise<Hex> {
      return evm.signTypedData(td as never, chainId).signature as Hex;
    },
    async signDigest(digest: Hex): Promise<Hex> { return evm.signDigest(digest).signature as Hex; },
    async signMessage(): Promise<Hex> { throw new Error("signMessage not used on the in-tab EVM path"); },
    async signBytes(): Promise<Uint8Array> { throw new Error("signBytes is the SVM path"); },
  };
}

/** The raw in-tab wative EVM Address for a walletId — the sealed-key handle the FUNDING path hands
 *  to `Contract.call(...).sign()`. The private key never leaves wative; this only ever produces
 *  signed transaction bytes, broadcast by a keyless ChainClient. */
export function evmAddressForWalletId(walletId: string): InTabEvmAddress {
  if (!session) throw new Error("in-tab custody is locked");
  const evm = session.evmByWalletId.get(walletId);
  if (!evm) throw new Error(`no in-tab signer for ${walletId}`);
  return evm as unknown as InTabEvmAddress;
}

export function lockCohort(): void { session = null; }
/** Alias — lock the whole vault (clears the in-memory session; the encrypted vault stays on disk). */
export function lockVault(): void { session = null; }

/** DESTRUCTIVE: wipe the ENTIRE in-browser vault (every account + key) from THIS browser. This is
 *  the only escape when the vault password is lost — the keys are encrypted with it and there is no
 *  recovery. The caller reloads afterward so the gate returns to onboarding. (PK wallets can be
 *  re-imported from keys held elsewhere; HD wallets are gone unless the mnemonic was backed up.) */
export async function resetVault(): Promise<void> {
  session = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();   // best-effort; the reload re-checks and a retry still clears it
    req.onblocked = () => resolve(); // completes once connections close (none on the locked gate)
  });
}

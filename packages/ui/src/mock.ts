// =============================================================================
// @farm/ui · deterministic mock fleet — generates accounts + wallets for the
// offline console (no testnet). Seeded so renders + tests are reproducible.
// =============================================================================
import type { Address } from "@farm/adapter-api";
import type { AccountVM, WalletVM, WalletStatus, Readiness, Fleet } from "./model.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function hex(rng: () => number, len: number): string {
  const c = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += c[Math.floor(rng() * 16)];
  return out;
}
function pick<T>(rng: () => number, xs: readonly T[]): T { return xs[Math.floor(rng() * xs.length)] as T; }

export interface FleetOptions {
  hdAccounts?: number;
  walletsPerHd?: number;
  pkAccounts?: number;
  cohorts?: readonly string[];
  seed?: number;
}

const HD_NAMES = ["Desk Alpha", "Desk Bravo", "Desk Charlie", "Desk Delta", "Desk Echo", "Desk Foxtrot", "Desk Golf", "Desk Hotel"];
const STATUSES: readonly { v: WalletStatus; w: number }[] = [
  { v: "active", w: 5 }, { v: "idle", w: 3 }, { v: "paused", w: 1 }, { v: "error", w: 1 },
];
const READINESS: readonly { v: Readiness; w: number }[] = [
  { v: "ready", w: 5 }, { v: "funded", w: 3 }, { v: "unfunded", w: 2 },
];

function weighted<T>(rng: () => number, table: readonly { v: T; w: number }[]): T {
  const total = table.reduce((a, b) => a + b.w, 0);
  let r = rng() * total;
  for (const row of table) { if ((r -= row.w) <= 0) return row.v; }
  return table[0]!.v;
}

export function generateFleet(opts: FleetOptions = {}): Fleet {
  const hdAccounts = opts.hdAccounts ?? 6;
  const walletsPerHd = opts.walletsPerHd ?? 160;
  const pkAccounts = opts.pkAccounts ?? 12;
  const cohorts = opts.cohorts ?? ["alpha", "beta", "gamma", "maker", "taker"];
  const rng = lcg(opts.seed ?? 0x5eed);

  const accounts: AccountVM[] = [];
  const wallets: WalletVM[] = [];

  const pushWallet = (accountId: string, accountName: string, kind: "HD" | "PK", index: number): void => {
    const address: Address = { family: "evm", value: `0x${hex(rng, 40)}` as `0x${string}` };
    const tagCount = 1 + Math.floor(rng() * 2);
    const tags = new Set<string>();
    while (tags.size < tagCount) tags.add(pick(rng, cohorts));
    wallets.push({
      id: `${accountId}:${index}`,
      accountId, accountName, accountKind: kind, index, address,
      cohorts: [...tags],
      nativeBalance: (rng() * 5).toFixed(4),
      quoteBalance: (rng() * 10_000).toFixed(2),
      status: weighted(rng, STATUSES),
      readiness: weighted(rng, READINESS),
      openOrders: Math.floor(rng() * 6),
    });
  };

  for (let a = 0; a < hdAccounts; a++) {
    const id = `hd-${a}`;
    const name = HD_NAMES[a % HD_NAMES.length] as string;
    accounts.push({ id, name, kind: "HD", walletCount: walletsPerHd });
    for (let i = 0; i < walletsPerHd; i++) pushWallet(id, name, "HD", i);
  }
  for (let p = 0; p < pkAccounts; p++) {
    const id = `pk-${p}`;
    const name = `PK ${String(p + 1).padStart(2, "0")}`;
    accounts.push({ id, name, kind: "PK", walletCount: 1 });
    pushWallet(id, name, "PK", 0);
  }

  return { accounts, wallets, cohorts: [...cohorts] };
}

// =============================================================================
// Runtime chain selection + per-network config. BOTH networks are baked in — non-tech
// operators flip testnet↔mainnet with a UI toggle, NOT a rebuild. The selected chainId
// lives in a cookie (`nado-chain-id`) so the browser AND the Node API routes resolve the
// SAME network: the client reads it from document.cookie, the server from the request's
// Cookie header. Default = Ink testnet (so with nothing set, app + tests run on testnet).
//
// RPC + USDT0 are pre-set per network (no env). Spend caps are per-network defaults that
// stay env-overridable (NEXT_PUBLIC_NADO_MAX_*, build-time) — the cap-rejection test relies on it.
//
// This module is UNIVERSAL: no server-only import, no document access at module top level
// (only inside the client helpers), so a client module and a server route can both import it.
// =============================================================================
import { parseEther } from "viem";

export interface SpendCaps {
  orderNotionalUsdt0: number; depositUsdt0: number; refuelEth: number; cohortUsdt0: number; refuelWei: bigint;
}
export interface NetworkConfig {
  chainId: number; isTestnet: boolean; label: string; networkName: string; rpc: string; usdt0: string; caps: SpendCaps;
}

const TESTNET = 763373; // Ink testnet (Sepolia)
const MAINNET = 57073;  // Ink mainnet
export const COOKIE_NAME = "nado-chain-id";
const DEFAULT_CHAIN_ID = TESTNET;

// Per-network cap DEFAULTS, still overridable by NEXT_PUBLIC_NADO_MAX_* (build-time inlined) so the
// cap-rejection suite can force tiny caps. Breach behavior stays a LOUD REJECT (never a silent clamp).
function envNum(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function caps(d: { order: number; deposit: number; refuel: number; cohort: number }): SpendCaps {
  const refuelEth = envNum(process.env.NEXT_PUBLIC_NADO_MAX_REFUEL_ETH, d.refuel);
  return {
    orderNotionalUsdt0: envNum(process.env.NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0, d.order),
    depositUsdt0: envNum(process.env.NEXT_PUBLIC_NADO_MAX_DEPOSIT_USDT0, d.deposit),
    refuelEth,
    cohortUsdt0: envNum(process.env.NEXT_PUBLIC_NADO_MAX_COHORT_USDT0, d.cohort),
    refuelWei: parseEther(String(refuelEth)),
  };
}

export const NETWORKS: Record<number, NetworkConfig> = {
  [TESTNET]: {
    chainId: TESTNET, isTestnet: true, label: "Ink Sepolia", networkName: "testnet",
    rpc: "https://rpc-gel-sepolia.inkonchain.com",            // CORS-open
    usdt0: "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F",       // 6-dec faucet token
    caps: caps({ order: 1_000_000, deposit: 100_000, refuel: 1, cohort: 1_000_000 }), // loose for testnet
  },
  [MAINNET]: {
    chainId: MAINNET, isTestnet: false, label: "Ink", networkName: "mainnet",
    rpc: "https://rpc-gel.inkonchain.com",                     // CORS-open (verified 2026-10-18)
    usdt0: "0x0200C29006150606B650577BBE7B6248F58470c1",       // mainnet USDT0 (6-dec, verified 2026-10-18)
    caps: caps({ order: 150, deposit: 200, refuel: 0.005, cohort: 1_000 }),           // TIGHT for mainnet
  },
};

/** Resolve a NetworkConfig by chainId, or undefined if unsupported. */
export function networkForChainId(id: number): NetworkConfig | undefined { return NETWORKS[id]; }

/** SERVER: parse the selected chainId from a request's Cookie header, defaulting to testnet. */
export function chainIdFromCookieHeader(cookieHeader: string | null | undefined): number {
  const m = cookieHeader?.match(/(?:^|;\s*)nado-chain-id=(\d+)/);
  const id = m ? Number(m[1]) : DEFAULT_CHAIN_ID;
  return NETWORKS[id] ? id : DEFAULT_CHAIN_ID;
}
/** SERVER: the selected network for a request (from its Cookie header). */
export function networkForRequest(req: { headers: { get(name: string): string | null } }): NetworkConfig {
  return NETWORKS[chainIdFromCookieHeader(req.headers.get("cookie"))]!;
}

/** CLIENT: the selected chainId (from the cookie), default testnet. Resolved at CALL time. */
export function activeChainId(): number {
  if (typeof document === "undefined") return DEFAULT_CHAIN_ID;
  return chainIdFromCookieHeader(document.cookie);
}
/** CLIENT: the active network config (resolved at call time, so a live switch is picked up). */
export function activeNetwork(): NetworkConfig { return NETWORKS[activeChainId()]!; }

/** CLIENT: persist the selected chainId in the cookie. The caller re-fetches the live state after. */
export function setActiveChainId(id: number): void {
  if (!NETWORKS[id]) throw new Error(`unsupported chainId ${id}`);
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE_NAME}=${id}; path=/; max-age=31536000; samesite=lax`;
  }
}

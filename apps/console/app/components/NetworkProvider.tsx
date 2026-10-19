"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { activeChainId, setActiveChainId, networkForChainId } from "../lib/chainEnv";
import type { NetworkConfig } from "../lib/chainEnv";
import { refreshNetwork } from "../lib/liveContext";

/** App-wide SELECTED network (testnet/mainnet), backed by the `nado-chain-id` cookie so the client
 *  and the server API routes agree. setChain flips it live — no rebuild, no reload: it writes the
 *  cookie, refreshes the in-tab money path (liveContext), and re-renders consumers; the home page
 *  reacts to `chainId` by re-fetching the live state + reconnecting the WS (the vault stays unlocked). */
interface NetworkCtx { chainId: number; net: NetworkConfig; setChain: (id: number) => void }
const Ctx = createContext<NetworkCtx | null>(null);

export function useNetwork(): NetworkCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useNetwork must be used within <NetworkProvider>");
  return c;
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [chainId, setChainId] = useState<number>(() => activeChainId());
  // Mirror the selected network onto <html data-net> so the network-bound Kumo brand (--color-kumo-brand)
  // repaints the whole app instantly on a live switch. layout.tsx seeds it via SSR; this syncs it
  // once the provider mounts (post-unlock) and on every flip thereafter.
  useEffect(() => {
    const net = networkForChainId(chainId);
    if (net && typeof document !== "undefined") document.documentElement.dataset.net = net.networkName;
  }, [chainId]);
  const setChain = useCallback((id: number) => {
    setChainId((cur) => {
      if (id === cur || !networkForChainId(id)) return cur;
      setActiveChainId(id); // cookie — server resolves it per request; client resolves it live
      refreshNetwork();     // liveContext's in-tab money path tracks the new network on the next op
      return id;
    });
  }, []);
  return <Ctx.Provider value={{ chainId, net: networkForChainId(chainId)!, setChain }}>{children}</Ctx.Provider>;
}

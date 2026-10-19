"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LinkProvider } from "@cloudflare/kumo";
import { AppLink } from "./AppLink";
import { VaultGate } from "./VaultGate";
import { NetworkProvider } from "./NetworkProvider";
import { vaultStatus, lockVault } from "../lib/custody";
import type { VaultStatus } from "../lib/custody";

/** App-level entry gate (step 3, lifted to the shell in step 4): the WHOLE app — every route,
 *  home and /accounts alike — is hidden behind the vault status, so the password form shows once
 *  "when entering this web app". On mount we read vaultStatus() ONCE; "absent"/"locked" render the
 *  VaultGate, only "unlocked" renders the app. Children mount only after unlock, so each route's
 *  own mount effects (e.g. the home page's refreshLive) fire exactly when the vault opens.
 *  `useVault().relock` lets any screen lock the vault and re-gate without a full reload. */
type VaultCtx = { relock: () => void };
const Ctx = createContext<VaultCtx>({ relock: () => {} });
export function useVault(): VaultCtx { return useContext(Ctx); }

export function AppGate({ children }: { children: ReactNode }) {
  const [vault, setVault] = useState<VaultStatus | "loading">("loading");
  useEffect(() => { vaultStatus().then(setVault).catch(() => setVault("absent")); }, []);

  // LinkProvider wraps BOTH branches so every Kumo link uses Next client routing (AppLink).
  return (
    <LinkProvider component={AppLink}>
      {vault !== "unlocked" ? (
        <VaultGate status={vault} onReady={() => setVault("unlocked")} />
      ) : (
        <Ctx.Provider value={{ relock: () => { lockVault(); setVault("locked"); } }}>
          <NetworkProvider>{children}</NetworkProvider>
        </Ctx.Provider>
      )}
    </LinkProvider>
  );
}

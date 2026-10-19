import "./globals.css";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AppGate } from "./components/AppGate";
import { networkForRequest } from "./lib/chainEnv";

export const metadata = {
  title: "Nado Trading Desk",
  description: "Generic multi-protocol, multi-wallet automation framework — console shell.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve the selected network from the cookie SERVER-SIDE so the network-bound accent (via
  // <html data-net>) is correct on the very first paint and on the lock screen — NetworkProvider,
  // which keeps it in sync on a live switch, only mounts after the vault unlocks, so SSR seeds it.
  const net = networkForRequest({ headers: await headers() });
  return (
    <html lang="en" data-net={net.networkName}>
      {/* text-base = Kumo's 14px content size; without it every unsized element inherits the browser's 16px. */}
      <body className="bg-kumo-canvas text-base text-kumo-default">
        {/* `isolate` on the app root (NOT <body>) is Kumo's documented portal-stacking fix: portaled
            Dialog / LayerDialog / Select / DropdownMenu then paint above the app's own fixed layers
            (e.g. the z-40 wallet drawer) without z-index workarounds. */}
        <div className="isolate">
          {/* The whole app (every route) renders only behind the unlocked vault. */}
          <AppGate>{children}</AppGate>
        </div>
      </body>
    </html>
  );
}

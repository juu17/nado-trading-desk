"use client";

import { memo } from "react";
import type { CSSProperties } from "react";
import { Badge, LayerCard, cn } from "@cloudflare/kumo";
import type { BadgeVariant } from "@cloudflare/kumo";
import type { WalletVM, WalletStatus } from "@farm/ui";
import { AccountKindBadge } from "./AccountKindBadge";

const STATUS: Record<WalletStatus, [BadgeVariant, string]> = {
  active: ["success", "Active"],
  idle: ["secondary", "Idle"],
  paused: ["warning", "Paused"],
  error: ["error", "Error"],
};

const short = (v: string): string => `${v.slice(0, 6)}…${v.slice(-4)}`;
// content-visibility keeps offscreen cards cheap so ~1000 scroll smoothly.
const CARD_STYLE: CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "230px 180px" };

// memo + a STABLE onSelect (not a fresh per-card closure) so unchanged cards skip re-render:
// the grid is column-virtualized, so the waste was every MOUNTED stable (mock) card re-rendering
// on each live setLive tick (the sweep reconciles ~2/s). A card now re-renders only when its
// wallet VM, selected, or onSelect changes.
export const WalletCard = memo(function WalletCard({ wallet, selected, onSelect }: { wallet: WalletVM; selected: boolean; onSelect: (w: WalletVM) => void }) {
  const [statusVariant, statusLabel] = STATUS[wallet.status];
  // A Kumo LayerCard rendered AS the button (useRender + mergeProps keep the testid, handler and
  // content-visibility style). Kumo idioms: hover = bg-kumo-tint (instant), keyboard focus + selection
  // = a brand ring (the network accent), secondary text = text-kumo-subtle, content at Kumo's 14px.
  return (
    <LayerCard
      render={<button type="button" data-testid="wallet-card" onClick={() => onSelect(wallet)} style={CARD_STYLE} />}
      className={cn(
        "flex h-full w-full flex-col gap-2 p-3 text-left hover:bg-kumo-tint",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand",
        selected && "ring-2 ring-kumo-brand",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <AccountKindBadge kind={wallet.accountKind}>{wallet.accountName}</AccountKindBadge>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>
      <div className="font-mono text-sm text-kumo-subtle">#{wallet.index} · {short(wallet.address.value)}</div>
      <div className="mt-auto flex items-end justify-between">
        <div>
          <div className="font-semibold tabular-nums">{wallet.quoteBalance} <span className="font-normal text-kumo-subtle">USDT0</span></div>
          <div className="text-sm tabular-nums text-kumo-subtle">{wallet.nativeBalance} ETH</div>
        </div>
        <div className="text-right text-sm text-kumo-subtle">
          <div className="tabular-nums">{wallet.openOrders} orders</div>
          <div className="capitalize">{wallet.readiness}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {wallet.cohorts.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
      </div>
    </LayerCard>
  );
});

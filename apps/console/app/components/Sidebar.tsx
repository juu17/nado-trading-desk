"use client";

import { Button, Meter, Sidebar as KumoSidebar, Text } from "@cloudflare/kumo";
import type { AccountOption, WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { AccountFilter } from "./AccountFilter";
import { NetworkSwitch } from "./NetworkSwitch";
import { useNetwork } from "./NetworkProvider";
import { TradingStrategy } from "./TradingStrategy";

interface Props {
  workspaceName: string;
  totalWallets: number;
  shownWallets: number;
  accountOptions: AccountOption[];
  selectedAccounts: Set<string>;
  onAccountsChange: (next: Set<string>) => void;
  tags: string[];
  selectedTags: Set<string>;
  onToggleTag: (t: string) => void;
  selectedCohorts: Set<"maker" | "taker">;
  onToggleCohort: (c: "maker" | "taker") => void;
  liveEnabled?: boolean;
  liveWallets?: WalletVM[];               // the live fleet VMs — the Trading-strategy cohort split + engine
  markets?: Market[];                     // live markets for the strategy's market picker
  onWalletChanged?: () => void;           // repaint after the Cohort split writes cohort tags
}

/** Section label — Kumo's own sidebar group-label recipe (sentence case, never uppercased). */
const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm font-medium text-kumo-subtle">{children}</span>
);

/** Section splitter — a labelled hairline divider that groups the controls beneath it (one level above
 *  the per-field Label). */
const Splitter = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center border-t border-kumo-line pt-3 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
    {children}
  </div>
);

/** Frozen left rail = Kumo's Sidebar (collapsible="none" on the Provider in page.tsx renders a fixed
 *  <aside> that never collapses or turns into a mobile sheet): Kumo Header for the brand, Kumo Content
 *  as the scroll area for the workspace summary, network, account filter, tags and tool panels. */
export function Sidebar(props: Props) {
  const { net } = useNetwork();
  return (
    <KumoSidebar>
      <KumoSidebar.Header>
        <div className="flex min-w-0 flex-col">
          <Text variant="heading" as="span">Nado Trading Desk</Text>
          <Text variant="secondary" size="xs" as="span">Fleet console · {props.workspaceName}</Text>
        </div>
      </KumoSidebar.Header>

      <KumoSidebar.Content>
        <div className="flex flex-col gap-5">
          <Meter
            label="Wallets shown"
            value={props.shownWallets}
            max={Math.max(props.totalWallets, 1)}
            customValue={`${props.shownWallets} / ${props.totalWallets}`}
            showValue
          />

          <Splitter>Filter</Splitter>

          <NetworkSwitch />

          <div className="flex flex-col gap-2">
            <Label>Accounts</Label>
            <AccountFilter options={props.accountOptions} selected={props.selectedAccounts} onChange={props.onAccountsChange} />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-1">
              {props.tags.map((t) => {
                const on = props.selectedTags.has(t);
                return (
                  <Button key={t} size="xs" variant={on ? "primary" : "secondary"} aria-pressed={on} onClick={() => props.onToggleTag(t)}>
                    {t}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Cohort</Label>
            <div className="flex flex-wrap gap-1">
              {(["maker", "taker"] as const).map((c) => {
                const on = props.selectedCohorts.has(c);
                return (
                  <Button key={c} size="xs" variant={on ? "primary" : "secondary"} aria-pressed={on} className="capitalize" onClick={() => props.onToggleCohort(c)}>
                    {c}
                  </Button>
                );
              })}
            </div>
          </div>

          <Splitter>Trading strategy</Splitter>

          <TradingStrategy wallets={props.liveWallets ?? []} markets={props.markets ?? []} onWalletChanged={props.onWalletChanged} isLive={props.liveEnabled} />

          <Text variant="secondary" size="xs">
            {props.liveEnabled
              ? `Live ${net.networkName} enabled · live-cohort fires sign + submit to the real sequencer; mock wallets stay offline`
              : "Offline mock · no testnet · actions run the real adapter + plan runner"}
          </Text>
        </div>
      </KumoSidebar.Content>
    </KumoSidebar>
  );
}

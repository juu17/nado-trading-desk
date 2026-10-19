"use client";

import { Button, Meter, Sidebar as KumoSidebar, Text } from "@cloudflare/kumo";
import type { AccountOption, WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { AccountFilter } from "./AccountFilter";
import { BulkPanel } from "./BulkPanel";
import { CustodyPanel } from "./CustodyPanel";
import { FundingPanel } from "./FundingPanel";
import type { InTabProduct } from "../lib/liveClient";
import { NetworkSwitch } from "./NetworkSwitch";
import { useNetwork } from "./NetworkProvider";

interface Props {
  workspaceName: string;
  totalWallets: number;
  shownWallets: number;
  shown: WalletVM[];
  accountOptions: AccountOption[];
  selectedAccounts: Set<string>;
  onAccountsChange: (next: Set<string>) => void;
  cohorts: string[];
  selectedCohorts: Set<string>;
  onToggleCohort: (c: string) => void;
  liveMarkets?: Market[];
  liveEnabled?: boolean;
  liveDefaultProduct?: InTabProduct;
  liveCohortSize?: number;
  onLiveCohortChange?: () => void;
  liveWallets?: WalletVM[];                       // live VMs (with readiness) for the Fund-cohort panel
  onFunded?: (walletIds: string[]) => void;       // repaint after a bulk fund
}

/** Section label — Kumo's own sidebar group-label recipe (sentence case, never uppercased). */
const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm font-medium text-kumo-subtle">{children}</span>
);

/** Frozen left rail = Kumo's Sidebar (collapsible="none" on the Provider in page.tsx renders a fixed
 *  <aside> that never collapses or turns into a mobile sheet): Kumo Header for the brand, Kumo Content
 *  as the scroll area for the workspace summary, network, account filter, cohort tags and tool panels. */
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

          <NetworkSwitch />

          <div className="flex flex-col gap-2">
            <Label>Accounts</Label>
            <AccountFilter options={props.accountOptions} selected={props.selectedAccounts} onChange={props.onAccountsChange} />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Cohorts (tags)</Label>
            <div className="flex flex-wrap gap-1">
              {props.cohorts.map((c) => {
                const on = props.selectedCohorts.has(c);
                return (
                  <Button key={c} size="xs" variant={on ? "primary" : "secondary"} aria-pressed={on} onClick={() => props.onToggleCohort(c)}>
                    {c}
                  </Button>
                );
              })}
            </div>
          </div>

          <BulkPanel wallets={props.shown} liveMarkets={props.liveMarkets} />

          {props.liveEnabled && <CustodyPanel cohortSize={props.liveCohortSize} product={props.liveDefaultProduct} onCohortChange={props.onLiveCohortChange} isTestnet={net.isTestnet} />}

          {/* Fund cohort is a TESTNET-only bulk on-ramp (its mint step can't run on mainnet, where
              USDT0 is bridged) — hide it entirely on mainnet so it never burns real gas. */}
          {props.liveEnabled && net.isTestnet && props.liveWallets && props.liveWallets.length > 0 && <FundingPanel wallets={props.liveWallets} onFunded={props.onFunded} />}

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

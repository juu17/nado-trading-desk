"use client";

import { useState } from "react";
import { Banner, Button, ButtonGroup, LayerDialog } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNetwork } from "./NetworkProvider";
import { NETWORKS } from "../lib/chainEnv";

const TESTNET = 763373;
const MAINNET = 57073;

/** The 2-pole Testnet | Mainnet switch as Kumo's ButtonGroup of toggle Buttons. The active pole is
 *  variant="primary", which paints Kumo's brand — re-pointed per network in globals.css — so it always
 *  shows the current network's accent (Kumo's segmented Tabs would not: its active pill is neutral).
 *  Flipping to TESTNET is instant; MAINNET asks first in a Kumo LayerDialog.Alert whose confirm button
 *  carries data-net="mainnet", so it reads in the mainnet accent while the app is still on testnet.
 *  No env, no rebuild — the selection is a cookie the client + server both read; the switch is live. */
export function NetworkSwitch() {
  const { chainId, setChain } = useNetwork();
  const [confirm, setConfirm] = useState(false);

  const pick = (id: number) => {
    if (id === chainId) return;
    if (id === MAINNET) { setConfirm(true); return; } // guard before real funds
    setChain(id);                                     // testnet is instant
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">Network</span>
      <ButtonGroup aria-label="Network" className="w-full">
        {[TESTNET, MAINNET].map((id) => {
          const active = chainId === id;
          return (
            <Button
              key={id}
              size="sm"
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              className="flex-1 capitalize"
              onClick={() => pick(id)}
            >
              {NETWORKS[id]!.networkName}
            </Button>
          );
        })}
      </ButtonGroup>

      <LayerDialog.Alert open={confirm} onOpenChange={setConfirm}>
        <LayerDialog.Content size="sm">
          <LayerDialog.Title>Switch to Mainnet?</LayerDialog.Title>
          <LayerDialog.Description>
            Mainnet moves <strong className="font-medium text-kumo-default">real funds</strong> — real USDT0 and ETH on Ink.
          </LayerDialog.Description>
          <LayerDialog.Body>
            <Banner
              variant="alert"
              size="sm"
              icon={<WarningIcon weight="fill" />}
              description="Orders, deposits and withdrawals will be real and irreversible."
            />
          </LayerDialog.Body>
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary
              variant="primary"
              data-net="mainnet"
              onClick={() => { setConfirm(false); setChain(MAINNET); }}
            >
              Switch to Mainnet
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}

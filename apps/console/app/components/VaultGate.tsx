"use client";

import { useState } from "react";
import { Banner, Button, Input, LayerCard, LayerDialog, Loader, Text } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { createVault, unlockVault, resetVault } from "../lib/custody";
import type { VaultStatus } from "../lib/custody";

/** The app entry gate (Waffet-style, status-driven): render EXACTLY ONE of loading / onboarding
 *  (no vault → set a password) / unlock (locked vault → enter the password) — nothing else, no
 *  wallets, until the vault is open. Kumo: a centered LayerCard holding a real <form> (Enter submits;
 *  a disabled submit blocks implicit submission, so Enter can't fire half-filled onboarding), labelled
 *  password Inputs and a primary submit Button. Only the unlock variant shows the danger Banner whose
 *  action opens a Kumo LayerDialog.Alert to erase the vault (the only escape — no password recovery). */
export function VaultGate({ status, onReady }: { status: VaultStatus | "loading"; onReady: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const onboarding = status === "absent";

  const submit = async () => {
    setErr(null);
    if (pw.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (onboarding && pw !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      if (onboarding) await createVault(pw); else await unlockVault(pw);
      onReady();
    } catch (e) {
      // A locked-vault open failure is almost always a wrong password; onboarding surfaces the real error.
      setErr(onboarding ? (e as Error).message : "Wrong password.");
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center px-4">
      <LayerCard className="flex w-full max-w-sm flex-col gap-4 p-5">
        <Text variant="heading" as="h1">Nado Trading Desk{status === "loading" ? "" : onboarding ? " · create your vault" : " · unlock"}</Text>
        {status === "loading" ? (
          <div className="flex justify-center py-6"><Loader /></div>
        ) : (
          <>
            <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <Text variant="secondary">
                {onboarding
                  ? "Set a password to encrypt your in-browser wallet vault. It never leaves this browser, and there's no recovery if you lose it."
                  : "Enter your vault password to unlock your accounts and wallets."}
              </Text>
              <Input
                type="password"
                label="Vault password"
                placeholder="vault password"
                autoComplete={onboarding ? "new-password" : "current-password"}
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              {onboarding && (
                <Input
                  type="password"
                  label="Confirm vault password"
                  placeholder="confirm vault password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
              {err && <Text variant="error">{err}</Text>}
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !pw || (onboarding && !confirm)}>
                {onboarding ? "Create vault" : "Unlock"}
              </Button>
            </form>

            {!onboarding && (
              <Banner
                variant="error"
                size="sm"
                icon={<WarningIcon weight="fill" />}
                title="Forgot your password?"
                description="There's no recovery — you can erase this vault and start over."
                action={<Banner.Action onClick={() => setConfirmReset(true)}>Reset vault</Banner.Action>}
              />
            )}
          </>
        )}
      </LayerCard>

      <LayerDialog.Alert open={confirmReset} onOpenChange={setConfirmReset}>
        <LayerDialog.Content size="sm">
          <LayerDialog.Title>Erase this vault?</LayerDialog.Title>
          <LayerDialog.Body>
            <Text variant="secondary">
              This permanently erases the local vault and every wallet and key in it. PK wallets can be re-imported from keys you hold elsewhere; HD wallets are lost unless you saved the mnemonic.
            </Text>
          </LayerDialog.Body>
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={resetting}
              onClick={async () => { setResetting(true); await resetVault(); window.location.reload(); }}
            >
              Erase &amp; start over
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}

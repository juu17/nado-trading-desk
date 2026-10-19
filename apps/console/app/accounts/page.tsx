"use client";

import { useEffect, useState } from "react";
import { Badge, Banner, Breadcrumbs, Button, ButtonGroup, Empty, Grid, Input, InputArea, LayerCard, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, KeyIcon, LockIcon, PencilSimpleIcon, PlusIcon, TrashIcon, UsersThreeIcon, WalletIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  listAccounts, createHdAccount, createPkAccount, deriveMore, importKeys, renameAccount, dropAccount, accountAddresses,
} from "../lib/custody";
import type { AccountVM, AccountKind } from "../lib/custody";
import { QrKeyScanner } from "../components/QrKeyScanner";
import { useVault } from "../components/AppGate";

const splitKeys = (s: string): string[] => s.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);

/** The dedicated Accounts page, in Kumo's page pattern: a Breadcrumbs header bar (client-routed via
 *  LinkProvider, so the vault stays unlocked), a heading, ONE create form (no wizard) in a LayerCard,
 *  and one LayerCard per account (header strip = identity + actions; body = derive / import). It is NOT
 *  an account→wallet cascade — the home page filters accounts and shows their wallets. Behind the gate. */
export default function AccountsPage() {
  const { relock } = useVault();
  const [accounts, setAccounts] = useState<AccountVM[]>([]);
  // session is populated by the gate before this renders; refresh on mount (and after every op).
  useEffect(() => { setAccounts(listAccounts()); }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <Breadcrumbs size="sm">
          <Breadcrumbs.Link href="/" icon={<WalletIcon size={16} />}>Wallets</Breadcrumbs.Link>
          <Breadcrumbs.Separator />
          <Breadcrumbs.Current>Accounts</Breadcrumbs.Current>
        </Breadcrumbs>
        <Button icon={LockIcon} onClick={relock}>Lock vault</Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">Accounts</Text>
            <Text variant="secondary">{accounts.length} account(s) in this vault</Text>
          </div>

          <CreateAccountForm onCreated={setAccounts} />

          <div className="flex flex-col gap-3">
            <Text variant="heading" as="h2">Your accounts</Text>
            {accounts.length === 0 ? (
              <LayerCard className="p-0">
                <Empty
                  size="sm"
                  icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />}
                  title="No accounts yet"
                  description="Create an HD or PK account above."
                />
              </LayerCard>
            ) : (
              accounts.map((a) => <AccountBlock key={a.slug} account={a} onChange={setAccounts} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** ONE form, all fields visible (no wizard): pick HD or PK, then fill the kind's fields. */
function CreateAccountForm({ onCreated }: { onCreated: (accounts: AccountVM[]) => void }) {
  const [kind, setKind] = useState<AccountKind>("HD");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [count, setCount] = useState(1);
  const [privKeys, setPrivKeys] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const canSubmit = !busy && name.trim().length > 0 && password.length > 0
    && (kind === "HD" ? count >= 1 : splitKeys(privKeys).length > 0);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const accounts = kind === "HD"
        ? await createHdAccount(name.trim(), password, mnemonic.trim() || undefined, count)
        : await createPkAccount(name.trim(), password, splitKeys(privKeys));
      onCreated(accounts);
      setMsg(`✓ created ${kind} account “${name.trim()}”`);
      setName(""); setPassword(""); setMnemonic(""); setPrivKeys(""); setCount(1);
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <LayerCard>
      <LayerCard.Secondary>Create an account</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        {/* kind toggle — the app-wide single-select idiom (selected = network brand) */}
        <ButtonGroup aria-label="Account kind">
          {(["HD", "PK"] as const).map((k) => (
            <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "HD" ? "HD (derive wallets)" : "PK (import keys)"}
            </Button>
          ))}
        </ButtonGroup>

        <Grid variant="2up" gap="sm">
          <Input label="Account name" placeholder="e.g. market-makers" passwordManagerIgnore value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="password" label="Vault password" placeholder="vault password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Grid>

        {kind === "HD" ? (
          <div className="flex flex-col gap-3">
            <InputArea
              label="Mnemonic"
              description="Optional — leave blank to generate a fresh one in this tab."
              placeholder="word1 word2 … (leave blank to generate)"
              rows={2}
              spellCheck={false}
              autoComplete="off"
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
            />
            <Input
              type="number"
              min={1}
              label="Wallets to derive"
              className="w-40"
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <InputArea
              label="Private keys"
              description="One 0x EVM key per line — one wallet per key."
              placeholder="0x… — one private key per line"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={privKeys}
              onChange={(e) => setPrivKeys(e.target.value)}
            />
            <QrKeyScanner onKey={(k) => setPrivKeys((p) => (p.trim() ? `${p.trim()}\n` : "") + k)} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>Create account</Button>
          {msg && (msg.startsWith("✗")
            ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={msg} />
            : <span className="text-kumo-success">{msg}</span>)}
        </div>
        <Text variant="secondary" size="xs">
          Keys are generated/imported and sign in this browser tab (IndexedDB) and never reach the server. The vault password seals the new account.
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** One account: a LayerCard whose header strip holds identity + manage actions (export, rename, drop)
 *  and whose body holds the kind-specific management (derive more / import keys). */
function AccountBlock({ account, onChange }: { account: AccountVM; onChange: (accounts: AccountVM[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deriveN, setDeriveN] = useState(1);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(account.name);
  const [importing, setImporting] = useState(false);
  const [keys, setKeys] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const run = async (fn: () => Promise<AccountVM[]>, after?: () => void) => {
    setBusy(true); setMsg(null);
    try { onChange(await fn()); after?.(); }
    catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  // Download a .txt of THIS account's wallet addresses — one per line, no index, addresses only.
  const exportAddresses = () => {
    const text = accountAddresses(account.slug).join("\n");
    const blob = new Blob([text ? `${text}\n` : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${account.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || account.slug}-addresses.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <LayerCard data-testid="account-block">
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {renaming ? (
            <>
              {/* The ONLY textbox in the block while renaming (the e2e addresses it that way). */}
              <Input size="sm" aria-label="Account name" className="w-48" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button size="sm" variant="primary" loading={busy} disabled={busy || !newName.trim()} onClick={() => run(() => renameAccount(account.slug, newName), () => setRenaming(false))}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenaming(false); setNewName(account.name); }}>Cancel</Button>
            </>
          ) : (
            <>
              <Text bold as="span">{account.name}</Text>
              <Badge variant="secondary">{account.kind}</Badge>
              <Text variant="secondary" size="xs" as="span">{account.walletCount} wallet(s)</Text>
            </>
          )}
        </div>
        {!renaming && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={DownloadSimpleIcon} disabled={busy || account.walletCount === 0} onClick={exportAddresses}>Export addresses</Button>
            <Button size="sm" icon={PencilSimpleIcon} disabled={busy} onClick={() => setRenaming(true)}>Rename</Button>
            {confirmDrop ? (
              <>
                <Button size="sm" variant="destructive" loading={busy} onClick={() => run(() => dropAccount(account.slug))}>Confirm drop</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDrop(false)}>Cancel</Button>
              </>
            ) : (
              <Button size="sm" variant="secondary-destructive" icon={TrashIcon} disabled={busy} onClick={() => setConfirmDrop(true)}>Drop</Button>
            )}
          </div>
        )}
      </LayerCard.Secondary>

      <LayerCard.Primary className="flex flex-col gap-2">
        {account.kind === "HD" ? (
          <div className="flex items-center gap-2">
            <Input type="number" min={1} size="sm" aria-label="Number of wallets to add" className="w-20" value={deriveN} onChange={(e) => setDeriveN(Math.max(1, Number(e.target.value) || 1))} />
            <Button size="sm" icon={PlusIcon} loading={busy} onClick={() => run(() => deriveMore(account.slug, deriveN))}>Derive more wallets</Button>
          </div>
        ) : importing ? (
          <div className="flex flex-col gap-2">
            <InputArea size="sm" aria-label="Private keys to import" placeholder="0x… — one key per line" rows={2} spellCheck={false} autoComplete="off" value={keys} onChange={(e) => setKeys(e.target.value)} />
            <QrKeyScanner onKey={(k) => setKeys((p) => (p.trim() ? `${p.trim()}\n` : "") + k)} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={busy || splitKeys(keys).length === 0} onClick={() => run(() => importKeys(account.slug, splitKeys(keys)), () => { setImporting(false); setKeys(""); })}>Import</Button>
              <Button size="sm" variant="ghost" onClick={() => { setImporting(false); setKeys(""); }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div><Button size="sm" icon={KeyIcon} disabled={busy} onClick={() => setImporting(true)}>Import keys</Button></div>
        )}
        {msg && <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={msg} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}

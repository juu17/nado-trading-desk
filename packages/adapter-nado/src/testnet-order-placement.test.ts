// =============================================================================
// LIVE testnet order-placement verification — GATED on NADO_LIVE (skipped offline).
// Per the standing rule "all order-placement-relevant functions are verified OUTRIGHT on
// testnet" (not via browser mocks), this asserts the two paths a browser-mocked E2E can't:
//   1. PLACE + CANCEL: a real post-only maker is accepted by the testnet sequencer, rests
//      (shows in the subaccount's open orders), then cancels cleanly — leaving no open order
//      and no position (the maker is priced far below market, so it never fills).
//   2. WITHDRAW: a real `withdraw_collateral` is accepted by the testnet sequencer.
// These exercise the same sequencer operations the console functions produce
// (`execute_place_order` for bulk-place → adapter.trading.placeOrder, and
// `execute_withdraw_collateral` for withdrawLive). Uses the disposable ~/.nado-ika-testnet
// cohort (wallet A); the key stays in the encrypted workspace / process memory, never logged.
//
//   NADO_LIVE=1 pnpm exec vitest run packages/adapter-nado/src/testnet-order-placement.test.ts
// =============================================================================
import { describe, it, expect } from "vitest";
import { EngineClient } from "@nadohq/engine-client";
import {
  CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS,
  getOrderNonce, getOrderVerifyingAddress, packOrderAppendix,
} from "@nadohq/client";
import { createWalletClient, http, defineChain, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
const CHAIN_ID = Number(process.env.NADO_CHAIN_ID ?? 763373); // Ink testnet
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID]!;
const deploy = NADO_DEPLOYMENTS[ENV];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const PID = Number(process.env.AB_PRODUCT_ID ?? 2); // a 24/7 crypto perp (BTC-PERP default)
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;

const x18 = (v: unknown): bigint => { try { return BigInt(String(v ?? "0").split(".")[0] || "0"); } catch { return 0n; } };
const digestOf = (res: any): string | undefined =>
  res?.digest ?? res?.orderDigest ?? res?.data?.digest;

describe.skipIf(!LIVE)("LIVE testnet order placement (gated)", () => {
  it("places a real post-only maker, confirms it rests, then cancels it clean", async () => {
    await import("wative-core/node");
    const { Workspace } = await import("wative-core");
    const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
    const ws = await (Workspace as { open(o: unknown): Promise<any> }).open({ path: cred.workspacePath, password: cred.password });
    const acc = ws.accounts[0];
    await acc.tryUnlock(cred.password);
    let pk = acc.wallets[0].dumpPrivateKey("evm"); if (!pk.startsWith("0x")) pk = "0x" + pk;
    await ws.lock(); // key now only in process memory

    const chain = defineChain({ id: CHAIN_ID, name: "Ink", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const account = privateKeyToAccount(pk as `0x${string}`);
    const addr = account.address;
    const engine: any = new EngineClient({ url: engineUrl, walletClient: createWalletClient({ account, chain, transport: http(rpc) }) });

    // Price a post-only BUY maker FAR below the market (90% of mid) so it RESTS and never fills.
    const mp = await engine.getMarketPrice({ productId: PID });
    const bid = x18(mp.bid), ask = x18(mp.ask);
    expect(bid > 0n && ask > 0n, "market has a two-sided price").toBe(true);
    const market = (await engine.getAllMarkets()).find((m: any) => m.productId === PID)!;
    const tick = BigInt(market.priceIncrement || "1") || 1n;
    const mid = (bid + ask) / 2n;
    let priceX18 = (mid * 90n) / 100n; priceX18 = (priceX18 / tick) * tick || tick;
    const order = {
      subaccountOwner: addr, subaccountName: SUBACCT,
      price: priceX18.toString(), amount: BigInt(market.minSize).toString(),
      expiration: String(Math.floor(Date.now() / 1000) + 3600),
      appendix: packOrderAppendix({ orderExecutionType: "post_only" }).toString(),
    };
    const res = await engine.placeOrder({ productId: PID, order, nonce: getOrderNonce(), verifyingAddr: getOrderVerifyingAddress(PID), chainId: CHAIN_ID });
    const digest = digestOf(res);
    expect(res.status, "sequencer accepted the order").toBe("success");
    expect(digest, "the sequencer returned an order digest").toBeTruthy();

    const open = await engine.getSubaccountOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productId: PID });
    const digests = (open?.orders ?? []).map((o: any) => o.digest ?? o.orderDigest);
    expect(digests, "the placed order is resting in the subaccount's open orders").toContain(digest);

    const cancel = await engine.cancelOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productIds: [PID], digests: [digest!], verifyingAddr: deploy.endpoint, chainId: CHAIN_ID });
    expect(cancel.status, "sequencer accepted the cancel").toBe("success");

    // Cleanup assertion: the order is gone (poll — the cancel indexes asynchronously).
    let gone = false;
    for (let i = 0; i < 8 && !gone; i++) {
      const after = await engine.getSubaccountOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productId: PID }).catch(() => ({ orders: [] }));
      const stillOpen = (after?.orders ?? []).map((o: any) => o.digest ?? o.orderDigest);
      if (!stillOpen.includes(digest)) { gone = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(gone, "the cancelled order no longer rests (clean)").toBe(true);
  }, 120_000);

  it("submits a real withdraw_collateral the sequencer accepts", async () => {
    await import("wative-core/node");
    const { Workspace } = await import("wative-core");
    const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
    const ws = await (Workspace as { open(o: unknown): Promise<any> }).open({ path: cred.workspacePath, password: cred.password });
    const acc = ws.accounts[0];
    await acc.tryUnlock(cred.password);
    let pk = acc.wallets[0].dumpPrivateKey("evm"); if (!pk.startsWith("0x")) pk = "0x" + pk;
    await ws.lock();

    const chain = defineChain({ id: CHAIN_ID, name: "Ink", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const account = privateKeyToAccount(pk as `0x${string}`);
    const addr = account.address;
    const engine: any = new EngineClient({ url: engineUrl, walletClient: createWalletClient({ account, chain, transport: http(rpc) }) });

    const amount6 = parseUnits(process.env.WITHDRAW_USDT0 ?? "1", 6).toString(); // small, native 6-dec
    const nonce = await engine.getTxNonce({ subaccountOwner: addr, subaccountName: SUBACCT }).catch(() => undefined);
    const res = await engine.withdrawCollateral({
      subaccountOwner: addr, subaccountName: SUBACCT, productId: QUOTE_PRODUCT, amount: amount6,
      nonce, verifyingAddr: deploy.endpoint, chainId: CHAIN_ID,
    });
    expect((res as { status?: string }).status, "sequencer accepted the withdraw_collateral").toBe("success");
  }, 120_000);
});

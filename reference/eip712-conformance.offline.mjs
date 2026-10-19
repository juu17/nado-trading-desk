// Phase-1 OFFLINE EIP-712 conformance (no funds, no testnet submission).
// Q: does wative-core 2.6.0 `signTypedData` (strict) produce a signature that is
//    (a) BYTE-IDENTICAL to viem's signTypedData (the canonical signer the Nado SDK uses), and
//    (b) ecrecovers to the wallet address, for EVERY Nado execute's real typed-data shape?
// If strict signTypedData ever rejects a payload, fall back to signDigest(hashTypedData) and flag it.
import { Workspace } from "wative-core";
import "wative-core/node";
import { mnemonicToAccount, toAccount } from "viem/accounts";
import { recoverTypedDataAddress, hashTypedData } from "viem";
import * as nado from "@nadohq/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MNEMONIC = "test test test test test test test test test test test junk"; // viem's well-known test mnemonic
const CHAIN_ID = 57073; // Ink mainnet
const PW = "spike-pw-123456789";

const sub = (owner, name = "default") => nado.subaccountToHex({ subaccountOwner: owner, subaccountName: name }); // 0x-hex bytes32 (what the viem-based SDK signs)
const endpoint = "0x0000000000000000000000000000000000000000"; // valid; verifyingContract value is irrelevant to parity/recover

function buildCases(addr) {
  const sender = sub(addr);
  const nonce = BigInt(nado.getOrderNonce());
  const d = (vc) => nado.getNadoEIP712Domain(vc, CHAIN_ID);
  const td = (type, verifyingContract, message) => ({
    domain: d(verifyingContract),
    types: nado.getNadoEIP712Types(type),
    primaryType: nado.getNadoEIP712PrimaryType(type),
    message,
  });
  return [
    ["place_order (product 2, BUY)", td("place_order", nado.getOrderVerifyingAddress(2), {
      sender, priceX18: 63120n * 10n ** 18n, amount: 1n * 10n ** 17n, expiration: nonce, nonce, appendix: 0n,
    })],
    ["place_order (product 2, SELL / negative amount)", td("place_order", nado.getOrderVerifyingAddress(2), {
      sender, priceX18: 63180n * 10n ** 18n, amount: -(1n * 10n ** 17n), expiration: nonce, nonce: nonce + 1n, appendix: 0n,
    })],
    ["cancel_orders", td("cancel_orders", endpoint, {
      sender, productIds: [2, 4], digests: ["0x" + "11".repeat(32), "0x" + "22".repeat(32)], nonce,
    })],
    ["withdraw_collateral", td("withdraw_collateral", endpoint, {
      sender, productId: 0, amount: 5n * 10n ** 6n, nonce,
    })],
    ["link_signer", td("link_signer", endpoint, {
      sender, signer: sub("0x1111111111111111111111111111111111111111"), nonce,
    })],
  ];
}

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), "wative-spike-"));
  const ws = await Workspace.open({ path: dir, password: PW });
  const acc = await ws.accounts.create("spike", PW, MNEMONIC);
  const evm = acc.wallets[0].addresses.find((a) => a.vm === "evm");
  const wativeAddr = evm.publicKey;
  const viemAcct = mnemonicToAccount(MNEMONIC);
  const viemAddr = viemAcct.address;

  console.log("wative EVM addr:", wativeAddr);
  console.log("viem   EVM addr:", viemAddr);
  const sameAddr = wativeAddr.toLowerCase() === viemAddr.toLowerCase();
  console.log("same derivation (m/44'/60'/0'/0/0):", sameAddr ? "YES ✓" : "NO ✗");

  const rows = [];
  for (const [label, typedData] of buildCases(wativeAddr)) {
    const row = { label, strict: "", parity: "", recover: "", fallback: "" };

    // wative strict signTypedData
    let wativeSig, usedFallback = false;
    try {
      wativeSig = evm.signTypedData(typedData, CHAIN_ID).signature;
      row.strict = "accepted ✓";
    } catch (e) {
      row.strict = "REJECTED: " + e.code || e.message;
      // fallback: sign the EIP-712 digest directly
      try {
        const digest = hashTypedData(typedData);
        wativeSig = evm.signDigest(digest).signature;
        usedFallback = true;
        row.fallback = "signDigest ✓";
      } catch (e2) {
        row.fallback = "signDigest FAILED: " + (e2.code || e2.message);
      }
    }

    // viem canonical signature (what the Nado SDK produces under the hood)
    const viemSig = await viemAcct.signTypedData(typedData);

    if (wativeSig) {
      row.parity = wativeSig.toLowerCase() === viemSig.toLowerCase() ? "byte-equal ✓" : (usedFallback ? "n/a (fallback)" : "MISMATCH ✗");
      const rec = await recoverTypedDataAddress({ ...typedData, signature: wativeSig });
      row.recover = rec.toLowerCase() === wativeAddr.toLowerCase() ? "ok ✓" : "WRONG ✗ " + rec;
    }
    rows.push(row);
  }

  // Bridge to @nadohq/client: wative 2.6.0 has NO native toViemAccount, so wrap it in a
  // viem custom account (toAccount) that delegates signTypedData to wative. This is the
  // object the SDK's walletClient consumes. Prove it signs byte-equal to native wative.
  const nativeToViem = typeof evm.toViemAccount === "function";
  let bridge;
  try {
    const bridged = toAccount({
      address: wativeAddr,
      async signTypedData(td) { return evm.signTypedData(td, CHAIN_ID).signature; },
      async signMessage({ message }) { return evm.signMessage(typeof message === "string" ? message : message.raw); },
      async signTransaction() { throw new Error("executes don't need signTransaction"); },
    });
    const firstTd = buildCases(wativeAddr)[0][1];
    const bridgedSig = await bridged.signTypedData(firstTd);
    const nativeSig = evm.signTypedData(firstTd, CHAIN_ID).signature;
    bridge = (bridgedSig.toLowerCase() === nativeSig.toLowerCase() ? "byte-equal via viem toAccount ✓" : "MISMATCH ✗") +
      ` (wative native toViemAccount: ${nativeToViem ? "present" : "ABSENT — use viem toAccount wrapper"})`;
  } catch (e) { bridge = "bridge threw: " + (e.code || e.message); }
  console.log("\nSDK bridge (viem account) :", bridge);

  console.log("\n=== CONFORMANCE MATRIX ===");
  for (const r of rows) {
    console.log(`\n• ${r.label}`);
    console.log(`    strict signTypedData : ${r.strict}`);
    if (r.fallback) console.log(`    signDigest fallback  : ${r.fallback}`);
    console.log(`    sig parity vs viem   : ${r.parity}`);
    console.log(`    ecrecover            : ${r.recover}`);
  }

  const allStrict = rows.every((r) => r.strict.includes("accepted"));
  const allParity = rows.every((r) => r.parity.includes("byte-equal"));
  const allRecover = rows.every((r) => r.recover.includes("ok"));
  console.log("\n=== SUMMARY ===");
  console.log("same key derivation :", sameAddr ? "✓" : "✗");
  console.log("strict accepts all  :", allStrict ? "✓ (no signDigest fallback needed)" : "✗ (fallback needed for some)");
  console.log("byte-parity all     :", allParity ? "✓" : "✗");
  console.log("ecrecover all       :", allRecover ? "✓" : "✗");
  console.log("VERDICT:", sameAddr && allParity && allRecover ? "CONFORMANT (strict path works)" : "SEE MATRIX");

  await ws.lock();
  await rm(dir, { recursive: true, force: true });
};

run().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });

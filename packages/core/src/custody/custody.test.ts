import { describe, it, expect, afterAll } from "vitest";
import "wative-core/node"; // register the Node filesystem backend (test-only)
import { recoverTypedDataAddress } from "viem";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Custody } from "./custody.js";

const MNEMONIC = "test test test test test test test test test test test junk"; // viem's well-known test mnemonic
const PW = "custody-test-pw-ABCdef123456";
const CHAIN_ID = 57073; // Ink
const EXPECTED_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // account 0 of the test mnemonic

// sender = 20-byte owner ++ 12-byte name ("default"), the Nado bytes32 subaccount.
const SENDER = ("0x" + "f39fd6e51aad88f6f4ce6ab8827279cfffb92266" + "64656661756c740000000000") as `0x${string}`;

const ORDER_TYPED_DATA = {
  domain: {
    name: "Nado",
    version: "0.0.1",
    chainId: CHAIN_ID,
    verifyingContract: "0x0000000000000000000000000000000000000002",
  },
  types: {
    Order: [
      { name: "sender", type: "bytes32" },
      { name: "priceX18", type: "int128" },
      { name: "amount", type: "int128" },
      { name: "expiration", type: "uint64" },
      { name: "nonce", type: "uint64" },
      { name: "appendix", type: "uint128" },
    ],
  },
  primaryType: "Order",
  message: {
    sender: SENDER,
    priceX18: 63120n * 10n ** 18n,
    amount: 10n ** 17n,
    expiration: 1n,
    nonce: 1n,
    appendix: 0n,
  },
} as const;

describe("core/custody WalletSigner (wative-backed)", () => {
  let dir: string | undefined;
  let custody: Custody | undefined;

  afterAll(async () => {
    await custody?.lock();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("derives the standard EVM account and signs a Nado EIP-712 order that ecrecovers to it", async () => {
    dir = await mkdtemp(join(tmpdir(), "custody-"));
    custody = await Custody.open({ path: dir, password: PW });
    const cohort = await custody.createCohort("desk", PW, MNEMONIC);
    const signer = custody.signerFor(cohort, 0, CHAIN_ID);

    expect(signer.address.family).toBe("evm");
    expect(signer.address.value.toLowerCase()).toBe(EXPECTED_ADDR);

    const sig = await signer.signTypedData!(ORDER_TYPED_DATA, CHAIN_ID);
    expect(sig.startsWith("0x")).toBe(true);
    expect(sig).toHaveLength(132); // 65-byte signature

    const recovered = await recoverTypedDataAddress({
      ...ORDER_TYPED_DATA,
      signature: sig,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered.toLowerCase()).toBe(EXPECTED_ADDR);
  });
});

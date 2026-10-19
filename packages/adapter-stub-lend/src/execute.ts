// =============================================================================
// @farm/adapter-stub-lend · execute — the EIP-712 typed-data builder. This is a real,
// idiomatic ERC-2612 `Permit` (the off-chain gasless-approve a lender signs before an
// on-chain supply), a DIFFERENT domain + struct than Nado's order typed-data. It is a
// plain object literal — NO viem, NO @nadohq — so the conformance sign→recover leg is
// provably not Nado-shaped and the adapter depends only on the seam.
// =============================================================================
import type { Eip712TypedData } from "@farm/adapter-api";

export interface PermitParams {
  token: string;        // the ERC-20 (the permit domain's verifyingContract)
  owner: string;        // the token holder (and the signer)
  spender: string;      // the lending pool granted the allowance
  value: bigint;        // allowance (uint256)
  nonce: bigint;        // the token's permit nonce for owner
  deadline: bigint;     // permit expiry (unix seconds)
  chainId: number;
  tokenName?: string;   // the ERC-20 name in the domain (defaults to a stub)
}

/** Build an ERC-2612 Permit EIP-712 typed-data (viem-compatible: EIP712Domain is derived
 *  from `domain`, so `types` carries only the Permit struct). */
export function buildPermitTypedData(p: PermitParams): Eip712TypedData {
  return {
    domain: { name: p.tokenName ?? "StubToken", version: "1", chainId: p.chainId, verifyingContract: p.token },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

// =============================================================================
// @farm/core · funding/wallet-use-plan — the funded-cohort roster and its A/B
// pairing (ported from lucklab 1.5). A plan names the wallets that may trade and
// batches them 20-at-a-time into 10 A / 10 B pairs (the reused pre-funded cohort,
// decision #3). OrderLedger admits an order only from a wallet in the active plan.
//
// Ported trimmed: the circular `../experiment/guards.js` import and the
// `assertWalletPlanSwitchSafe` function it fed (plan-switching safety over the
// deferred treasury/hedge/collateral fields) are CUT — plan-switching is not on
// the benchmark path, and the cut removes the funding⇄experiment edge here.
// =============================================================================
import { owner, refuse, type DeskOperations } from './types.js';
export interface WalletUseMember { address:string; position:number; role:'A'|'B'; pairBatch:number; slot:number; }
/** 1.5: one source account (mnemonic) of a multi-account plan and how many of the plan's
 *  members, in order, came from it. */
export interface WalletUseSource { accountSlug:string; count:number; }
/** `accountSlug` is the (first) source account. 1.5: `sources`, when present, lists two or
 *  more accounts in the operator's order; the members are their wallets concatenated in that
 *  order and batched continuously by the same rule (a batch may hold wallets of two
 *  mnemonics). Plans without `sources` are single-account plans exactly as before. */
export interface WalletUsePlan { id:string; name:string; scheme:'ten-alternating-tail-split-v1'; accountSlug:string; sources?:WalletUseSource[]; createdAt:number; members:WalletUseMember[]; }
/** Wallet inventory and experiment plans (1.4.0): an account (a mnemonic) may hold and list
 *  at least WALLET_INVENTORY_MAX wallets, and one experiment plan may now use all of them
 *  (1.3.4 kept plans at 200; the operator runs 1700 at once, five batches per group). The
 *  plan's batches of 20 (10 A / 10 B) and the original 130 (HD 0–129) are unchanged. */
export const WALLET_INVENTORY_MAX=5000, WALLET_PLAN_MAX=WALLET_INVENTORY_MAX;
/** Highest HD index a restore or derivation may reach (first index + count). */
export const HD_INDEX_LIMIT=100_000;
export function parsePublicAddressList(value:string,max=WALLET_INVENTORY_MAX):string[]{
 if(typeof value!=='string'||value.length>max*48+1000)refuse('ADDRESS_LIST_INVALID');
 const rows=value.replace(/^﻿/,'').trim().split(/[\s,;]+/).filter(Boolean);if(rows[0]?.toLowerCase()==='wallet_address')rows.shift();
 if(rows.length<1||rows.length>max)refuse('ADDRESS_LIST_COUNT');const addresses=rows.map(owner);if(new Set(addresses).size!==addresses.length)refuse('ADDRESS_LIST_DUPLICATE');return addresses;
}
export function makeWalletUsePlan(id:string,name:string,accountSlug:string,addresses:string[],now=Date.now()):WalletUsePlan{
 if(!id||id.length>80||!name.trim()||name.length>100||!accountSlug||accountSlug.length>200)refuse('WALLET_PLAN_INVALID');
 const values=addresses.map(owner);if(!values.length||values.length>WALLET_PLAN_MAX||new Set(values).size!==values.length)refuse('WALLET_PLAN_ADDRESSES');
 const full=Math.floor(values.length/20)*20,tail=values.length-full;if(tail%2)refuse('WALLET_PLAN_ODD_TAIL');
 return {id,name:name.trim(),accountSlug,scheme:'ten-alternating-tail-split-v1',createdAt:now,members:values.map((address,i)=>{const rest=i-full,split=tail/2;return {address,position:i+1,pairBatch:Math.floor(i/20)+1,role:i<full?(i%20<10?'A':'B'):(rest<split?'A':'B'),slot:i<full?i%10+1:rest%split+1}})};
}
/** At most this many source accounts in one plan. */
export const WALLET_PLAN_SOURCES_MAX=50;
/** A plan from several accounts' wallets, in the given order (members concatenated, then
 *  batched continuously: every 20 → 10 A + 10 B, same tail split). Only the total must be
 *  even and at most WALLET_PLAN_MAX; no address may appear twice, no account twice. One
 *  source gives an ordinary single-account plan (no `sources`). */
export function makeMultiAccountWalletUsePlan(id:string,name:string,sources:{accountSlug:string;addresses:string[]}[],now=Date.now()):WalletUsePlan{
 if(!Array.isArray(sources)||!sources.length||sources.length>WALLET_PLAN_SOURCES_MAX||sources.some(x=>!x||typeof x.accountSlug!=='string'||!x.accountSlug||x.accountSlug.length>200||!Array.isArray(x.addresses)||!x.addresses.length)||new Set(sources.map(x=>x.accountSlug)).size!==sources.length)refuse('WALLET_PLAN_SOURCES');
 const all=sources.flatMap(x=>x.addresses.map(owner));if(all.length>WALLET_PLAN_MAX)refuse('WALLET_PLAN_ADDRESSES');if(new Set(all).size!==all.length)refuse('WALLET_PLAN_DUPLICATE');
 const plan=makeWalletUsePlan(id,name,sources[0]!.accountSlug,all,now);
 return sources.length===1?plan:{...plan,sources:sources.map(x=>({accountSlug:x.accountSlug,count:x.addresses.length}))};
}
/** The plan's source accounts in order (one for a single-account plan). */
export function walletPlanAccountSlugs(p:Pick<WalletUsePlan,'accountSlug'|'sources'>):string[]{return p.sources?p.sources.map(x=>x.accountSlug):[p.accountSlug];}
/** The source account of the member at 1-based `position`. */
export function walletPlanMemberAccount(p:Pick<WalletUsePlan,'accountSlug'|'sources'>,position:number):string|undefined{if(!p.sources)return p.accountSlug;let end=0;for(const x of p.sources){end+=x.count;if(position<=end)return x.accountSlug}return undefined;}
/** Where one source account ends and the next begins: the last member of `from` (position
 *  `lastPosition`, batch `lastBatch`) and the first of `to` (batch `firstBatch`). `shared`
 *  means that one pair batch holds wallets of both accounts. */
export interface WalletPlanJunction { from:string; to:string; lastPosition:number; lastBatch:number; firstBatch:number; shared:boolean; }
export function walletPlanJunctions(p:Pick<WalletUsePlan,'accountSlug'|'sources'|'members'>):WalletPlanJunction[]{
 const out:WalletPlanJunction[]=[];if(!p.sources)return out;let end=0;
 for(let i=0;i+1<p.sources.length;i++){end+=p.sources[i]!.count;const last=p.members[end-1],first=p.members[end];if(!last||!first)break;out.push({from:p.sources[i]!.accountSlug,to:p.sources[i+1]!.accountSlug,lastPosition:end,lastBatch:last.pairBatch,firstBatch:first.pairBatch,shared:last.pairBatch===first.pairBatch});}
 return out;
}
export function activeWalletUsePlan(s:Pick<DeskOperations,'walletUsePlans'|'activeWalletUsePlanId'>){if(!s.activeWalletUsePlanId)return undefined;const p=s.walletUsePlans?.find(p=>p.id===s.activeWalletUsePlanId);if(!p)refuse('ACTIVE_WALLET_PLAN_MISSING');return p;}
export function assertWalletPlanOwner(s:Pick<DeskOperations,'walletUsePlans'|'activeWalletUsePlanId'>,address:string){const p=activeWalletUsePlan(s);if(p&&!p.members.some(m=>m.address===owner(address)))refuse('WALLET_PLAN_INACTIVE');}
export function assertWalletPlanPair(s:Pick<DeskOperations,"walletUsePlans"|"activeWalletUsePlanId">,a:string,b:string){const p=activeWalletUsePlan(s);if(!p)return;const left=p.members.find(m=>m.address===owner(a)),right=p.members.find(m=>m.address===owner(b));if(!left||!right||left.role!=="A"||right.role!=="B"||left.pairBatch!==right.pairBatch)refuse("WALLET_PLAN_PAIR_MISMATCH");}
export function validateWalletUsePlans(s:DeskOperations){
 if(s.walletUsePlans!==undefined){if(!Array.isArray(s.walletUsePlans)||s.walletUsePlans.length>200)refuse('JOURNAL_DAMAGED');const ids=new Set<string>();for(const p of s.walletUsePlans){if(!p||ids.has(p.id)||p.scheme!=='ten-alternating-tail-split-v1'||!Number.isSafeInteger(p.createdAt)||!Array.isArray(p.members))refuse('JOURNAL_DAMAGED');const expected=makeWalletUsePlan(p.id,p.name,p.accountSlug,p.members.map(m=>m.address),p.createdAt);if(p.sources!==undefined)validateSources(p);if(p.members.some((m,i)=>(["address","position","role","pairBatch","slot"] as const).some(k=>m[k]!==expected.members[i]![k])))refuse('JOURNAL_DAMAGED');ids.add(p.id)}}
 if(s.activeWalletUsePlanId!==undefined&&(typeof s.activeWalletUsePlanId!=='string'||!s.walletUsePlans?.some(p=>p.id===s.activeWalletUsePlanId)))refuse('JOURNAL_DAMAGED');
}
function validateSources(p:WalletUsePlan){const x=p.sources;if(!Array.isArray(x)||x.length<2||x.length>WALLET_PLAN_SOURCES_MAX||x.some(v=>!v||typeof v.accountSlug!=='string'||!v.accountSlug||v.accountSlug.length>200||!Number.isSafeInteger(v.count)||v.count<1)||new Set(x.map(v=>v.accountSlug)).size!==x.length||x[0]!.accountSlug!==p.accountSlug||x.reduce((n,v)=>n+v.count,0)!==p.members.length)refuse('JOURNAL_DAMAGED');}

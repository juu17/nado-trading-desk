import type { FundingChainId, ProtectedOrder } from "../funding/types.js";

/** Only positive local journal evidence can establish this; a timeout cannot. */
export class ExperimentUnsentOrderError extends Error {
  readonly notSubmitted = true;
  constructor(code: string) { super(code); this.name = "ExperimentUnsentOrderError"; }
}

export type ExperimentMode = "SIMULATION" | "LIVE";
export type ExperimentSide = "BUY" | "SELL";
export type ExperimentOrderRole = "A_OPEN" | "B_OPEN" | "A_CLOSE" | "B_CLOSE";
export type ExperimentState = "CREATED" | "RUNNING" | "EXITING" | "PAUSED" | "STOPPED" | "ROLLING" | "COMPLETED";
export interface ExperimentPairInput { id: string; a: string; b: string;
  /** This pair's market (1.4.0): absent = the task's `productId` (every task before 1.4.0). */
  productId?: number }
export interface ExperimentGroupInput { id: string; pairs: ExperimentPairInput[] }
export type ExperimentRehearsalPreset = "PAIR_2_V1" | "PAIR_3_V1";
export interface ExperimentCampaignInput {
  id: string;
  name?: string;
  chainId: FundingChainId;
  mode: ExperimentMode;
  walletUsePlanId?: string;
  /** The task's market; a pair with its own `productId` trades that one instead. */
  productId: number;
  /** Fixed opening notional; with `sizing` it is the plan-approved single-order cap. */
  orderNotionalX18: string;
  targetNotionalPerWalletX18: string;
  /** Absent = threshold off. Costs are still recorded; zero is never "off". */
  maxLossPerWalletX18?: string;
  maxFeePerWalletX18?: string;
  /** Per-pair round turnover from the capital each side actually received. */
  sizing?: ExperimentSizing;
  /** Frozen money route; absent for legacy campaigns, which keep same-role rollover only. */
  route?: ExperimentRouteApproval;
  /** 1.4.0 parallel readiness, confirmed once by the operator and bound to this route:
   *  a first deposit or top-up whose Nado credit is proven (funding depositReady) no
   *  longer holds start/resume while its original transfer awaits final confirmation,
   *  which is audited in the background. Absent: the original rule (wait for final). */
  fundingReadiness?: ExperimentFundingReadiness;
  slippageBps: number;
  makerTimeoutMs?: number;
  /** Self-cross only (real-funds guardrail): a SHORT cross timeout (≈ 2× expected round-trip).
   *  If A's post-only open maker is still resting (not crossed by B) this many ms after it was
   *  placed, the round bails reduce-only (A_CLOSE withdraws A's maker, both legs close to flat)
   *  rather than leave A exposed to external takers. Absent = off (bounded only by the slot's
   *  follow deadline, as before). Tighter than makerTimeoutMs, which governs maker re-post. */
  makerCrossTimeoutMs?: number;
  /** Round slot length for this task: 180000 (3 minutes, the default for tasks made since
   *  1.3.4) or 300000; absent: 5 minutes (tasks made before). See timing.ts. */
  slotMs?: number;
  /** "B": a normal round closes with B's maker order first (re-quoted at the best price)
   *  and A then closes by taker, mirroring the open (A maker, B taker). Absent = legacy:
   *  A closes first (maker, then taker), then B by taker. */
  closeMaker?: "B";
  /** Phase-A self-match open (capacity benchmark, locked decision #2 — A↔B cross IS the fill
   *  mechanism). Absent/false = the intern's ORGANIC open: A's maker rests until EXTERNAL flow
   *  fills it, then B hedges (the lifted default; what a no-flow testnet would starve). true =
   *  once A's maker is acked RESTING, B's taker deliberately CROSSES it (B's size ≤ A's acked
   *  resting size), so A and B fill each other with no reliance on outside liquidity. Pair with
   *  closeMaker:"B" so the close mirrors (B rests a reduce maker, A's taker crosses it). */
  selfCross?: boolean;
  /** Pairs that fell behind the group's leaders may run larger rounds to catch up: up to
   *  this percentage of the normal round (100-200; absent or 100 = off). */
  catchUpPercent?: number;
  maxConcurrency?: number;
  autoRoll?: boolean;
  /** "PAIR" (new tasks only, with a route): each pair hands its money to the same pair of the
   *  next group as soon as it is done, which starts once both its sides are credited. Absent:
   *  the whole group moves together (every older task). See PAIR_ROLLING_CN.md. */
  scheduling?: "PAIR";
  /** Low-cost opening (1.3.2+): a round's opening waits for a calm moment (see
   *  ExperimentCostGate). Absent = opens on schedule, as before. Closes never wait. */
  costGate?: ExperimentCostGate;
  /** A test run before the real task, on the same engine and money route; its results are
   *  kept apart from the real statistics. "REHEARSAL": the first pair of two groups (4
   *  wallets). "SCALED_TEST": every wallet of the plan with small amounts (a full run in
   *  miniature). */
  purpose?: "REHEARSAL" | "SCALED_TEST";
  /** Explicit new-task selection only. Absent: all older task semantics and SHA stay unchanged. */
  rehearsalPreset?: ExperimentRehearsalPreset;
  groups: ExperimentGroupInput[];
}
/**
 * Round turnover (open + close) = multiplier x min(K_A, K_B), where K is each wallet's
 * flat baseline equity in this group. The last round covers the larger remaining gap: with
 * `tailBufferX18` it is the exact gap plus that small buffer (automatic sizing); without it
 * (older plans) the gap is rounded up to `tailStepX18`. Either way it is capped by that
 * turnover, and an opening below the market minimum is lifted to it at order time.
 * Opening notional is half the round turnover.
 */
export interface ExperimentSizing {
  kind: "CAPITAL_MULTIPLE";
  multiplier: number;
  tailStepX18: string;
  tailBufferX18?: string;
}
/**
 * Low-cost opening. The price part of a round's cost is mostly how far the market moves in
 * the second or two between A's maker fill and B's taker follow (the spread on BTC/ETH is
 * one tick). A round therefore opens only while the market is calm: the last minute's mean
 * move per ~2 s is at most `maxDriftBps` (if set) and, with `relative`, at most the median
 * of the last 30 minutes; and the spread is at most `maxSpreadTicks`. After `maxWaitMs` of
 * waiting it opens anyway, so the target is still reached.
 */
export interface ExperimentCostGate {
  maxSpreadTicks: number;
  relative: boolean;
  maxDriftBps?: number;
  maxWaitMs: number;
}
/** Read-only market facts for the cost gate and the cost estimate (bps = 1/10000). */
export interface ExperimentMarketCost {
  observedAt: number;
  /** Mid-price samples behind `driftBps` and how long they span. */
  samples: number;
  spanMs: number;
  spreadTicks: number;
  spreadBps: number;
  tickBps: number;
  /** Mean absolute mid move per ~2 s over the last minute. */
  driftBps: number;
  /** Median of the per-minute drift over the last 30 minutes (absent until 10 minutes). */
  medianDriftBps?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
}
/**
 * What the task's rounds cost, accumulated as rounds complete (kept when rounds are
 * archived). A pair holds opposite, equal positions in one market, so the price moves
 * cancel between A and B: for a fully hedged round, the pair's combined result before fees
 * is exactly the price part of its cost (spread, slippage and the move while B follows).
 * Rounds not fully hedged (an early exit) count for turnover and fees only; their price
 * result carries market exposure and is kept apart.
 */
export interface ExperimentCostTotals {
  rounds: number;
  turnoverX18: string;
  makerFeeX18: string;
  takerFeeX18: string;
  hedgedRounds: number;
  hedgedTurnoverX18: string;
  /** Hedged rounds: what the opening (A_OPEN + B_OPEN) and closing (A_CLOSE + B_CLOSE)
   *  cost in price, positive = cost. */
  openLegX18: string;
  closeLegX18: string;
  /** Rounds not fully hedged: their combined price result (positive = loss). */
  unhedgedPriceX18: string;
  /** Rounds whose opening waited for a calm market, and how long in total. */
  gatedRounds?: number;
  gateWaitMs?: number;
  /** Rounds where B followed, and the total time from A's fill being seen to B's follow
   *  order being signed and ready to send (see ExperimentRound.sourceFilledAt). */
  followRounds?: number;
  followMs?: number;
  /** Rounds closed by B's maker, and the total time from B's maker close being seen filled
   *  to A's closing order being signed (see ExperimentRound.closeSourceFilledAt). */
  closeFollowRounds?: number;
  closeFollowMs?: number;
}
export interface ExperimentFundingReadiness { version: 1; policy: "PLATFORM_CREDIT"; routeSha256: string; confirmedAt: number }
/** Operator-confirmed route: every wallet's single exit edge, bound by its canonical hash. */
export interface ExperimentRouteApproval {
  fundingAccount: string;
  /** 1.5 hub funding: the funding account is the first group's first A wallet (A1), whose
   *  Nado account the operator fills by hand. It pays the first group's margins through
   *  their DDAs, rolls exactly what B1 rolls, and every return goes to its DDA. Absent: an
   *  independent funding account F (every task before 1.5). */
  hub?: "FIRST_A";
  /** Preparation parameters, bound by the same digest (x18 USDT0, wei). */
  initialMarginX18: string;
  gasTargetWei: string;
  openingDepositX18: string;
  sha256: string;
  confirmedAt: number;
}
export interface ExperimentOrderRequest {
  /** Stable before prepare. Always starts with experiment:. */
  id: string;
  role: ExperimentOrderRole;
  owner: string;
  side: ExperimentSide;
  postOnly: boolean;
  reduceOnly: boolean;
  quantityX18?: string;
  notionalX18?: string;
  /** Wider (still capped) slippage for a repeated taker attempt; absent = the campaign's. */
  slippageBps?: number;
  /** Catch-up opening: may be trimmed to the margin the account has, but not below this. */
  minNotionalX18?: string;
  /** Self-cross taker HARD IOC limit (x18): B crosses at EXACTLY this price (A's resting price),
   *  so it can cross only A and never sweep past A into external liquidity. Absent = the ordinary
   *  slippage-bounded taker. The connector uses it verbatim (no slippage, no re-snap past it). */
  limitPriceX18?: string;
}
export interface PreparedExperimentOrder {
  id: string;
  mode: ExperimentMode;
  chainId: FundingChainId;
  owner: string;
  productId: number;
  digest: string;
  /** JSON signed request; internal evidence, never renderer-facing. */
  payload: string;
  quantityX18: string;
  priceX18: string;
  nonce: string;
  expiration: number;
  side: ExperimentSide;
  reduceOnly: boolean;
  postOnly: boolean;
  /** A_OPEN: minimum executable B hedge quantity at prepare time. Missing/0 means one raw unit. */
  minimumHedgeQuantityX18?: string;
}
export interface ExperimentOrderFact {
  digest: string;
  identityMatches: boolean;
  known: boolean;
  terminal: boolean;
  filledX18: string;
  /** Runtime-verified positive execution notional; raw fee-inclusive quote is never accumulated directly. */
  quoteFilledX18: string | null;
  /** Cumulative positive fees paid; rebates must not be made positive costs. */
  feePaidX18: string | null;
  observedAt: number;
  /** Set only when the exchange showed this exact order still resting unfilled. */
  resting?: true;
}
export interface ExperimentWalletSnapshot {
  owner: string;
  /** Signed base position. */
  positionX18: string;
  openDigests: string[];
  /** Actual account equity. Null blocks new risk; core persists a flat baseline. */
  equityX18: string | null;
  netPnlX18?: string | null;
  lossX18?: string | null;
}
export interface ExperimentPairSnapshot {
  complete: boolean;
  observedAt: number;
  a: ExperimentWalletSnapshot;
  b: ExperimentWalletSnapshot;
}
export interface ExperimentOrder extends PreparedExperimentOrder {
  role: ExperimentOrderRole;
  state: "PREPARED" | "DISPATCHED" | "UNKNOWN" | "TERMINAL" | "ABORTED_UNSENT";
  epoch: number;
  createdAt: number;
  factKnown: boolean;
  filledX18: string;
  quoteFilledX18: string;
  feePaidX18: string;
  cancelState?: "DISPATCHED" | "UNKNOWN" | "CONFIRMED";
  cancelEvidencePayload?: string;
  errorCode?: string;
}
export interface ExperimentRound {
  id: string;
  number: number;
  openAt: number;
  side: ExperimentSide;
  holdMs: number;
  /** The round's slot length (see timing.ts). Absent: 5 minutes (rounds before 1.3.4). */
  slotMs?: number;
  state: "WAITING_OPEN" | "A_OPEN" | "CANCEL_A_OPEN" | "B_OPEN" | "HOLDING" | "B_CLOSE_MAKER" | "CANCEL_B_CLOSE_MAKER" | "A_CLOSE" | "CANCEL_A_CLOSE" | "B_CLOSE" | "VERIFYING_FLAT" | "COMPLETED";
  orders: ExperimentOrder[];
  pairedAt?: number;
  holdUntil?: number;
  completedAt?: number;
  /** SOURCE_BELOW_MINIMUM_EXIT: A filled too little to follow. FOLLOWER_INCOMPLETE_EXIT: B could
   *  not match A's fill within its attempts, so both real positions were closed early.
   *  REPRICE_EXHAUSTED_EXIT: A's post-only maker was refused as never-placed (post-only would
   *  cross, off-tick, out of band, late/expired) REPRICE_ATTEMPTS times in this round, so the
   *  round is set aside flat (nothing was placed) and the next one opens. */
  earlyExitReason?: "SOURCE_BELOW_MINIMUM_EXIT" | "FOLLOWER_INCOMPLETE_EXIT" | "FOLLOW_TIMEOUT_EXIT" | "PAUSE_FLATTEN_EXIT" | "REPRICE_EXHAUSTED_EXIT";
  /** Sizing mode: planned open + close turnover of this round, fixed when the round is drawn. */
  plannedTurnoverX18?: string;
  /** Catch-up round: the turnover it would have had without the boost (the opening may be
   *  trimmed back toward it if the account's margin cannot carry the boost). */
  unboostedTurnoverX18?: string;
  /** Realized per-wallet result of a round that ended flat: sells minus buys at confirmed
   *  execution notional, minus positive fees (funding payments are not included). */
  result?: { aPnlX18: string; bPnlX18: string };
  /** Low-cost opening: since when this round waited for a calm market, and why it waits now
   *  (cleared when it opens). */
  costWaitSince?: number;
  costWaitCode?: string;
  /** Time this round's openings spent waiting for a calm market (summed over openings;
   *  time while the task was paused is not counted). */
  costWaitMs?: number;
  /** When the engine first saw A's opening filled (the fact's read time): from here to B's
   *  follow order is the time the pair is one-sided, which drives the opening's price cost. */
  sourceFilledAt?: number;
  /** When the engine first saw B's maker close filled: from here to A's closing order is
   *  the time the pair is one-sided on the way out. */
  closeSourceFilledAt?: number;
  /** Written only after a complete account snapshot proves both legs flat. */
  flatProof?: { observedAt: number; aPositionX18: "0"; bPositionX18: "0"; aOpenOrderCount: 0; bOpenOrderCount: 0 };
}
export interface ExperimentArchivedWalletTotals { quoteFilledX18: string; feePaidX18: string }
export interface ExperimentArchiveReference {
  id: string;
  sha256: string;
  fromRound: number;
  toRound: number;
  count: number;
  orderCount: number;
  protectedOrderCount: number;
  byteLength: number;
  walletTotals: Record<string, ExperimentArchivedWalletTotals>;
}
export interface ExperimentPair extends ExperimentPairInput {
  state: "WAITING" | "ACTIVE" | "PAUSED" | "COMPLETED";
  rounds: ExperimentRound[];
  lastFlatAt?: number;
  errorCode?: string;
  /** Automatic resume of a PAUSED pair: when it retries, and how many times it paused in a row. */
  retryAt?: number;
  retryCount?: number;
  /** 1.4.0 unattended rule: a pair that kept failing the same way (EXPERIMENT_SET_ASIDE_AFTER
   *  automatic retries of a non-network error) is set aside so its group can go on: it trades
   *  no more, its wallets keep their money (not moved by the rollover; final collection or
   *  the operator handles them), and the original error is kept here for review. */
  setAsideAt?: number;
  setAsideCode?: string;
  /** 1.4.0: first stage before setting aside: since then this pair only closes what it holds
   *  (close-only); once flat it ends early (EXPERIMENT_PAIR_CLOSED_EARLY) and its money moves
   *  on with the group as usual. closeOnlyCode keeps the error that started it. */
  closeOnlyAt?: number;
  closeOnlyCode?: string;
  /** 1.4.0 catch-up pass: this pair was set aside earlier and was given another go at the end
   *  of the task (rounds up to twice the usual size, within the confirmed single-order cap). */
  catchUp?: true;
  /** Pair rolling (A): this pair's money was handed on (to the next pair or back to F) and
   *  credited there. It is done for good (archived like a finished group). */
  handedOffAt?: number;
  /** Since when every other unfinished pair of its group was done and this one was still
   *  failing the same non-network way (the group waits only on it; see PAIR_LONELY_MS). */
  lonelySince?: number;
  /** Legacy absence means zero. Hot round numbering continues after this offset. */
  archivedRoundCount?: number;
  archives?: ExperimentArchiveReference[];
}
export interface ExperimentGroup { id: string; pairs: ExperimentPair[]; completedAt?: number }
export interface ExperimentWalletStats {
  quoteFilledX18: string; feePaidX18: string; lossX18: string;
  /** Sum of round results and their counts (rounds with a known result only). */
  realizedPnlX18?: string; roundsWon?: number; roundsLost?: number; roundsCounted?: number;
  baselineEquityX18?: string; equityX18?: string; netPnlX18?: string;
  /** Hub (1.5): what the hub had been credited by returns (6 dp) when its baseline was taken;
   *  returns credited later are money moved in, not trading result. */
  baselineHubInflowRaw?: string;
  archivedQuoteFilledX18?: string; archivedFeePaidX18?: string;
}
export interface ExperimentRollover {
  id: string;
  fromGroupId: string;
  /** Next group, or FUNDING_ROUTE_TARGET for the final return of the last group. */
  toGroupId: string;
  state: "PREPARED" | "DISPATCHED" | "UNKNOWN" | "CREDITED";
  epoch: number;
  createdAt: number;
  reference?: string;
  errorCode?: string;
  /** Pair rolling: this step moves only this pair's two wallets to the same pair of the next group. */
  pairId?: string;
  /** Pair rolling: this step returns the group's pairs routed back to F (all of them at once). */
  returnsOnly?: true;
  /** Pair rolling, returns step: exactly the pairs it moves, fixed when it was created (a later
   *  rejoin or catch-up never changes what a claimed step moves or who counts as handed off). */
  pairIds?: string[];
}
export const FUNDING_ROUTE_TARGET = "funding";
export interface ExperimentRolloverFact {
  id: string;
  identityMatches: boolean;
  state: "PENDING" | "UNKNOWN" | "CREDITED";
  reference?: string;
  /** PENDING only: why nothing could be sent yet (e.g. PNL_SETTLING), for the operator. */
  waitingCode?: string;
  /** Query only: nothing of this step exists yet (not created, nothing sent). */
  notStarted?: boolean;
}
export interface ExperimentCampaign extends Omit<ExperimentCampaignInput, "groups"> {
  /** First and latest time the engine started (or continued) this task (1.3.4; absent before). */
  firstStartedAt?: number;
  lastStartedAt?: number;
  state: ExperimentState;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  activeGroup: number;
  groups: ExperimentGroup[];
  wallets: Record<string, ExperimentWalletStats>;
  rollovers: ExperimentRollover[];
  exitRequested: boolean;
  /** Pause-and-flatten in progress: close everything, start nothing, then stop resumably. */
  flattenRequested?: boolean;
  /** How many times the task continued after a pause, a crash or a network loss. */
  resumeCount?: number;
  /** Stopped by a recovery (lock, crash, restart), not by the operator: it continues by itself
   *  once recovered, also after a second interruption during that recovery (GPT 20-pair R01).
   *  An operator Stop and every start clear it. */
  resumeAfterRecovery?: true;
  /** 1.4.0: when the end-of-task catch-up pass for pairs set aside earlier began (once). */
  catchUpPassAt?: number;
  /** 1.4.0 (audit F05): the automatic final collection of this task. Written when the task
   *  completed under this version's driver (older completed tasks never have it, so they are
   *  never collected by themselves); `doneAt` once collection found nothing left, `stoppedAt`
   *  when the operator pressed Stop while it was pending. Resumed after an unlock or restart
   *  while neither is set. */
  autoCollection?: { requestedAt: number; doneAt?: number; stoppedAt?: number };
  /** Final collection (1.3.1+): ids of the collateral and treasury batches and funding
   *  plans this task's collection created. A later press continues exactly these; other
   *  open requests on its wallets are reported for review, never taken over. */
  collectionRequests?: string[];
  /** Cost of the completed rounds (1.3.2+; see ExperimentCostTotals). */
  costs?: ExperimentCostTotals;
  errorCode?: string;
  /** Group-step (finish, rollover, return) retry while the task keeps its running state. */
  retryAt?: number;
  retryCount?: number;
  /** Operator "delete" (1.5): when the task was hidden from the task page's lists. Display
   *  only: every record stays (rounds, exports, statistics), wallets keep the rules of the
   *  task's state, and the task can be shown again (the field is then removed). */
  hiddenAt?: number;
}
/** All evidence must be scoped to campaign.mode and chain. No network in core. */
export interface ExperimentConnector {
  preflight(campaign: ExperimentCampaign, pair: ExperimentPair): Promise<ExperimentPairSnapshot>;
  prepare(campaign: ExperimentCampaign, pair: ExperimentPair, request: ExperimentOrderRequest): Promise<PreparedExperimentOrder>;
  dispatch(campaign: ExperimentCampaign, prepared: PreparedExperimentOrder, allowed: () => boolean): Promise<string>;
  /** A taker (non-post-only, immediate-or-cancel) order the exchange took never rests: once
   *  its fill has settled it is reported terminal, also when it filled only in part. */
  lookup(campaign: ExperimentCampaign, order: ExperimentOrder): Promise<ExperimentOrderFact>;
  /** Whether a resting maker order is no longer at the best price (someone quotes better,
   *  or the book moved away), so it should be cancelled and re-posted. Read-only; an
   *  unreadable book answers false (the order simply keeps resting). */
  makerStale?(campaign: ExperimentCampaign, order: ExperimentOrder): Promise<boolean>;
  /** Read-only market facts for the low-cost opening gate (of the pair's market, 1.4.0);
   *  throws when unreadable. */
  marketCost?(campaign: ExperimentCampaign, productId: number): Promise<ExperimentMarketCost>;
  /** Read-only: both wallets of the pair hold no position and no resting order in the
   *  campaign's product (used before a task is ended). Without it, preflight is used. */
  isFlat?(campaign: ExperimentCampaign, pair: ExperimentPair): Promise<boolean>;
  /** Called once after cancel intent is persisted. Must return exact order facts. */
  cancel(campaign: ExperimentCampaign, order: ExperimentOrder, allowed: () => boolean): Promise<ExperimentOrderFact>;
  /** Whether preflight positions are the exchange's own, read live (a fill shows there
   *  before any lookup). Lets a resting maker be looked up only when its wallet moved. */
  livePositions?(campaign: ExperimentCampaign): boolean;
  /** Whether this task's fills are pushed right now (a fill wakes its pair at once, see
   *  ExperimentCoordinator.nudge). A resting maker's wallet is then only read now and then
   *  as a fallback instead of on every pass. */
  fillHints?(campaign: ExperimentCampaign): boolean;
  /** Hint only: this pair is hedging (one side filled, the other not yet, or closing), so
   *  its reads may go ahead of routine ones. Never changes what is read or sent. */
  urgent?(campaign: ExperimentCampaign, pair: ExperimentPair, on: boolean): void;
  /** Own stable id must also be honored by the runtime's persisted funding layer. */
  rollover(campaign: ExperimentCampaign, step: ExperimentRollover, allowed: () => boolean): Promise<ExperimentRolloverFact>;
  lookupRollover(campaign: ExperimentCampaign, step: ExperimentRollover): Promise<ExperimentRolloverFact>;
  /** On exit (no new money movement): release this step's rows that provably never left
   *  (never signed, or refused) - their money stays in the sending wallets for the final
   *  collection - and report the step from what was really sent. Never sends anything. */
  abandonUnsentRollover?(campaign: ExperimentCampaign, step: ExperimentRollover): Promise<ExperimentRolloverFact>;
}
/** A trace of what the engine did, for the diagnostic log (no secrets, no payloads). */
export interface ExperimentEvent { event: string; level: "info" | "warn" | "error"; campaignId: string; pairId?: string; round?: number; data?: Record<string, string | number | boolean | undefined> }
export interface ExperimentCoordinatorOptions {
  now?: () => number; random?: () => number; onEvent?: (e: ExperimentEvent) => void;
  /** Fast steps (1.3.2): a step that leads straight to the next continues in the same pass,
   *  e.g. A's fill seen → its rest cancelled → B's follow sent, without waiting for the next
   *  timer pass. Off: one step per pass, as before. */
  chain?: boolean;
}

export interface ExperimentCompactionBody {
  schemaVersion: 1;
  campaignId: string;
  mode: ExperimentMode;
  chainId: FundingChainId;
  productId: number;
  groupId: string;
  pairId: string;
  a: string;
  b: string;
  previousArchivedRoundCount: number;
  fromRound: number;
  toRound: number;
  count: number;
  rounds: ExperimentRound[];
  protectedOrders: ProtectedOrder[];
}
export interface ExperimentCompactionChunk extends ExperimentCompactionBody {
  /** Stable logical scope/range plus plaintext SHA prefix. Never a storage path. */
  id: string;
  sha256: string;
  /** Encrypt exactly these UTF-8 bytes. Contains private evidence; never renderer-facing. */
  canonicalPayload: string;
}
export interface ExperimentArchiveReceipt { id: string; sha256: string }
export interface ExperimentCompactionOptions {
  /** Active default 23. Completed campaigns always drain all eligible rounds. */
  threshold?: number;
  /** Active default 3. Explicit 0/0 selects completed campaigns only. */
  keepRecent?: number;
  /** Plaintext bound per immutable archive; default 512 KiB. */
  maxChunkBytes?: number;
}

// Guards the KEPT reservation invariant (correctness invariant #6: one wallet ↔ one
// unfinished task) after the Phase-A funding-settled cut. The intern's guards.test.ts
// "experiment atomic funding attribution admission" suite tested the CUT funding-settled
// cluster (deferred — Phase C) and is not ported. These two cases are its "one unfinished
// task per wallet" block, which exercises the surviving assertExperimentWalletsAvailable
// refuses (EXPERIMENT_WALLETS_IN_UNFINISHED_TASK) end to end through create/start/closeOut
// — the invariant the capacity-invariants audit flagged as structurally present but untested.
import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type OperationsStore } from "../funding/types.js";
import { ExperimentCoordinator } from "./coordinator.js";
import type { ExperimentCampaign, ExperimentConnector } from "./types.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const A = address(1), B = address(2), NEXT_A = address(3), NEXT_B = address(4);
function config() {
  return { id: "cashflow", chainId: 763373, mode: "LIVE" as const, productId: 2, orderNotionalX18: "100", targetNotionalPerWalletX18: "1000",
    maxLossPerWalletX18: "100", maxFeePerWalletX18: "100", slippageBps: 10, groups: [{ id: "g1", pairs: [{ id: "p1", a: A, b: B }] }] };
}
class Store implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T) { const copy = structuredClone(this.state), result = fn(copy); this.state = copy; return result; }
}
const noIo = async (): Promise<never> => { throw Error("UNEXPECTED_IO"); };
const connector: ExperimentConnector = { preflight: noIo, prepare: noIo, dispatch: noIo, lookup: noIo, cancel: noIo, rollover: noIo, lookupRollover: noIo };

describe("one unfinished task per wallet (reservation invariant, post funding-cut)", () => {
  it("refuses a second live task on a wallet an unfinished (e.g. stopped rehearsal) task still holds, until that one is ended", async () => {
    // Ending a task needs a fresh read proving its wallets flat (here: they are).
    const store = new Store(), engine = new ExperimentCoordinator(store, { ...connector, isFlat: async () => true }, { now: () => 1 });
    await engine.create({ ...config(), id: "rehearsal", purpose: "REHEARSAL" });
    store.state.experiments![0]!.state = "STOPPED";
    await expect(engine.create({ ...config(), id: "real" })).rejects.toThrow("EXPERIMENT_WALLETS_IN_UNFINISHED_TASK");
    // Other networks, simulations and disjoint wallets are unaffected.
    await engine.create({ ...config(), id: "sim", mode: "SIMULATION" });
    await engine.create({ ...config(), id: "other", groups: [{ id: "g1", pairs: [{ id: "p1", a: NEXT_A, b: NEXT_B }] }] });
    await engine.closeOut("rehearsal");
    await engine.create({ ...config(), id: "real" });
    expect(store.state.experiments!.map(c => c.id)).toEqual(["rehearsal", "sim", "other", "real"]);
  });
  it("two overlapping tasks from an older version: the other one can still be ended, or exited to close its positions", async () => {
    const store = new Store(), engine = new ExperimentCoordinator(store, connector, { now: () => 1 });
    await engine.create({ ...config(), id: "rehearsal", purpose: "REHEARSAL" });
    const old = structuredClone(store.state.experiments![0]!); old.id = "real"; delete old.purpose;
    store.state.experiments!.push(old);
    for (const c of store.state.experiments!) c.state = "STOPPED";
    await expect(engine.start("rehearsal")).rejects.toThrow("EXPERIMENT_WALLETS_IN_UNFINISHED_TASK");
    await engine.requestExit("rehearsal");
    await engine.start("rehearsal"); // exit only closes its own positions and finishes
    expect(store.state.experiments!.find(c => c.id === "rehearsal")!.state).toBe("EXITING");
  });
});

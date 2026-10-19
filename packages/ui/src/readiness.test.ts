import { describe, it, expect } from "vitest";
import { computeReadiness } from "./readiness.js";

const FLOOR = 0.00003; // ~ one approve+deposit on Ink

describe("computeReadiness", () => {
  it("unfunded when there is no credited quote collateral (regardless of gas)", () => {
    expect(computeReadiness({ quote: 0, native: 0, gasFloor: FLOOR })).toBe("unfunded");
    expect(computeReadiness({ quote: 0, native: 10, gasFloor: FLOOR })).toBe("unfunded"); // gas alone != funded
  });

  it("funded when collateral is credited but gas is below the floor (can trade, can't fund on-chain)", () => {
    expect(computeReadiness({ quote: 100, native: 0, gasFloor: FLOOR })).toBe("funded");
    expect(computeReadiness({ quote: 100, native: FLOOR / 2, gasFloor: FLOOR })).toBe("funded");
  });

  it("ready when collateral is credited AND gas is at/above the floor", () => {
    expect(computeReadiness({ quote: 100, native: FLOOR, gasFloor: FLOOR })).toBe("ready"); // boundary is inclusive
    expect(computeReadiness({ quote: 0.000001, native: 1, gasFloor: FLOOR })).toBe("ready"); // any positive collateral
  });
});

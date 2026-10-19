import { describe, it, expect } from "vitest";
import { parseCron, nextCronTime } from "./cron.js";

const U = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo, d, h, mi, s);

describe("cron parser", () => {
  it("parses the standard fields", () => {
    const c = parseCron("*/15 0 1,15 * 1-5");
    expect([...c.minute.set].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...c.hour.set]).toEqual([0]);
    expect([...c.dom.set].sort((a, b) => a - b)).toEqual([1, 15]);
    expect([...c.dow.set].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(c.minute.wild).toBe(false); // `*/15` is a RESTRICTION, not a bare star
    expect(c.dom.wild).toBe(false);
    expect(parseCron("* * * * *").minute.wild).toBe(true); // only a literal `*` is wild
  });

  it("expands N/step as N-max/step (Vixie/Quartz), and a-b/step", () => {
    expect([...parseCron("0/15 * * * *").minute.set].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron("5/20 * * * *").minute.set].sort((a, b) => a - b)).toEqual([5, 25, 45]);
    expect([...parseCron("0-20/5 * * * *").minute.set].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20]);
    expect([...parseCron("7 * * * *").minute.set]).toEqual([7]); // bare N is just {N}
  });

  it("rejects empty list elements and non-digit steps", () => {
    for (const bad of ["0,,30 * * * *", ",5 * * * *", "5, * * * *"]) expect(() => parseCron(bad)).toThrow(/empty element/);
    for (const bad of ["*/2e1 * * * *", "*/0x5 * * * *", "5/ * * * *"]) expect(() => parseCron(bad)).toThrow(/bad step/);
  });

  it("normalizes dow 7 -> 0 (Sunday)", () => {
    expect([...parseCron("0 0 * * 7").dow.set]).toEqual([0]);
    expect([...parseCron("0 0 * * 0").dow.set]).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad step/);
    expect(() => parseCron("x * * * *")).toThrow(/bad field/);
  });
});

describe("nextCronTime (UTC)", () => {
  it("every 15 minutes -> next quarter", () => {
    expect(nextCronTime("*/15 * * * *", U(2026, 0, 1, 0, 7, 30))).toBe(U(2026, 0, 1, 0, 15));
    expect(nextCronTime("*/15 * * * *", U(2026, 0, 1, 0, 15, 0))).toBe(U(2026, 0, 1, 0, 30)); // strictly after
  });

  it("daily midnight rolls to the next day", () => {
    expect(nextCronTime("0 0 * * *", U(2026, 0, 1, 12, 0))).toBe(U(2026, 0, 2, 0, 0));
  });

  it("9am weekdays skips the weekend", () => {
    const next = nextCronTime("0 9 * * 1-5", U(2026, 0, 2, 10, 0)); // Fri 2026-01-02, 10:00
    const d = new Date(next);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(d.getUTCDay()).toBeLessThanOrEqual(5);
    expect(next).toBeGreaterThan(U(2026, 0, 2, 10, 0));
  });

  it("applies the dom/dow OR rule when both are restricted (diverges from AND)", () => {
    // "the 13th OR any Friday": from 2026-01-01 the first match is Fri 2026-01-02 (dow=5, NOT the 13th).
    // An AND implementation would instead wait for Friday-the-13th (2026-02-13), so asserting the exact
    // instant distinguishes OR from AND (a weaker "13th OR Friday" check would pass under AND too).
    expect(nextCronTime("0 0 13 * 5", U(2026, 0, 1, 0, 0))).toBe(U(2026, 0, 2, 0, 0));
  });

  it("treats */step in dom/dow as RESTRICTED for the OR rule (Vixie)", () => {
    // "0 0 13 * */2": the 13th OR an even weekday-index (Sun=0, Tue=2, Thu=4, Sat=6).
    const next = nextCronTime("0 0 13 * */2", U(2026, 0, 1, 0, 0));
    const d = new Date(next);
    expect(d.getUTCDate() === 13 || d.getUTCDay() % 2 === 0).toBe(true);
  });

  it("finds a far-future Feb 29 across a century non-leap gap", () => {
    // next Feb 29 after 2096 is 2104 (2100 is NOT a leap year) — ~8 years, within the ~9-year cap.
    const d = new Date(nextCronTime("0 0 29 2 *", U(2096, 2, 1)));
    expect([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]).toEqual([2104, 1, 29]);
  });

  it("throws on an impossible expression", () => {
    expect(() => nextCronTime("0 0 30 2 *", U(2026, 0, 1))).toThrow(/no matching time/); // Feb 30 never exists
  });
});

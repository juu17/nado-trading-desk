// =============================================================================
// @farm/core · automation/cron — a minimal, dependency-free 5-field cron parser +
// next-fire-time computation, so `runTemplate` can drive a `{ mode: "cron" }` schedule
// without a third-party cron dependency (core stays dep-free + deterministic).
//
// Fields (standard 5-field): minute hour day-of-month month day-of-week.
//   minute 0-59 · hour 0-23 · dom 1-31 · month 1-12 · dow 0-6 (0 or 7 = Sunday)
// Each field supports: `*`, `*/step`, `a`, `a-b`, `a-b/step`, and comma lists of those.
// Matching is on **UTC** so a schedule fires at the same instant on every machine. When
// BOTH day-of-month and day-of-week are restricted (neither is `*`), a day matches if
// EITHER matches — the standard cron OR rule; otherwise both constraints must hold.
// =============================================================================

interface CronField { set: Set<number>; wild: boolean }
export interface Cron { minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField }

function parseField(spec: string, min: number, max: number): CronField {
  const wild = spec === "*"; // literal `*` only — `*/n` is a RESTRICTION (for the dom/dow OR rule, Vixie)
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    if (part === "") throw new Error(`cron: empty element in "${spec}"`); // reject "0,,30" / "5," / ",5"
    const slash = part.indexOf("/");
    const rangePart = slash >= 0 ? part.slice(0, slash) : part;
    const stepStr = slash >= 0 ? part.slice(slash + 1) : "";
    if (slash >= 0 && !/^\d+$/.test(stepStr)) throw new Error(`cron: bad step in "${part}"`); // digits only (no 2e1 / 0x5)
    const step = stepStr === "" ? 1 : Number(stepStr);
    if (step < 1) throw new Error(`cron: bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
      if (!m) throw new Error(`cron: bad field "${part}"`);
      lo = Number(m[1]);
      // `N/step` (a single value WITH a step, no explicit range) means `N-max/step` (Vixie/Quartz/AWS),
      // so `0/15` → {0,15,30,45}, not {0}. A bare `N` (no step) is just {N}.
      hi = m[2] !== undefined ? Number(m[2]) : (slash >= 0 ? max : lo);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron: "${part}" out of range [${min}-${max}]`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (set.size === 0) throw new Error(`cron: empty field "${spec}"`);
  return { set, wild };
}

/** Parse a 5-field cron expression into matchable sets (throws on a malformed expr). */
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron: expected 5 fields, got ${f.length} in "${expr}"`);
  const dow = parseField(f[4]!, 0, 7);
  if (dow.set.has(7)) { dow.set.add(0); dow.set.delete(7); } // 7 => 0 (Sunday)
  return {
    minute: parseField(f[0]!, 0, 59),
    hour: parseField(f[1]!, 0, 23),
    dom: parseField(f[2]!, 1, 31),
    month: parseField(f[3]!, 1, 12),
    dow,
  };
}

const MINUTE_MS = 60_000;
// ~9 years — covers the 8-year Feb-29 gap across a century non-leap year (e.g. 2096 → 2104, since
// 2100 is not a leap year) so a valid `0 0 29 2 *` is never mistaken for impossible.
const MAX_MINUTES = 366 * 24 * 60 * 9;

/** The next UTC instant (epoch ms) strictly after `after` that matches `expr`. */
export function nextCronTime(expr: string, after: number): number {
  const c = parseCron(expr);
  const bothDay = !c.dom.wild && !c.dow.wild;
  // Advance to the start of the next whole minute after `after`.
  let t = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(t);
    const dom = d.getUTCDate();
    const dow = d.getUTCDay(); // 0-6, Sunday = 0
    const dayOk = bothDay ? (c.dom.set.has(dom) || c.dow.set.has(dow)) : (c.dom.set.has(dom) && c.dow.set.has(dow));
    if (c.minute.set.has(d.getUTCMinutes()) && c.hour.set.has(d.getUTCHours()) && c.month.set.has(d.getUTCMonth() + 1) && dayOk) {
      return t;
    }
    t += MINUTE_MS;
  }
  throw new Error(`cron: "${expr}" has no matching time within ~9 years`);
}

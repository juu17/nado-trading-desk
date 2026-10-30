// Guards the dispatch classification (A-3 / seams contract #3). The capacity number is only
// trustworthy if a sub-saturation transient is dropped (run continues) rather than halting,
// and if an ambiguous outcome is NEVER silently treated as "didn't place". Re-derived here.
import { describe, expect, it } from "vitest";
import { classifyDispatch } from "./classify.js";

describe("classifyDispatch — halt vs drop-one vs placed", () => {
  it("treats a deduped retry (2013) as PLACED, not a failure (no-double-place firing)", () => {
    expect(classifyDispatch({ nadoCode: 2013 })).toEqual({ kind: "deduped", code: "DIGEST_ALREADY_EXISTS" });
  });

  it("classifies a proven never-sent as not-sent (ABORTED_UNSENT, no halt)", () => {
    expect(classifyDispatch({ transportAborted: true }).kind).toBe("not-sent");
    // The known Cloudflare WAF compression 403 blocks the request before the sequencer.
    expect(classifyDispatch({ wafCompressionBlock: true })).toEqual({ kind: "not-sent", code: "WAF_COMPRESSION_BLOCK" });
    expect(classifyDispatch({ httpStatus: 403, message: "Invalid compression headers" }).kind).toBe("not-sent");
  });

  it("treats rate limiting (1000/1015/HTTP 429) as not-sent (exchange shed it)", () => {
    expect(classifyDispatch({ nadoCode: 1000 })).toEqual({ kind: "not-sent", code: "RATE_LIMITED" });
    expect(classifyDispatch({ nadoCode: 1015 }).code).toBe("RATE_LIMITED");
    expect(classifyDispatch({ httpStatus: 429 }).kind).toBe("not-sent");
  });

  it("classifies market-state/admissibility codes as refused (one order, re-price)", () => {
    for (const code of [2011, 2004, 2007, 2006, 2036, 2092, 2003, 2094, 2119, 2023, 2067]) {
      expect(classifyDispatch({ nadoCode: code })).toEqual({ kind: "refused", code: String(code) });
    }
  });

  it("classifies a malformed/mis-signed request as rejected-fatal (stop all)", () => {
    expect(classifyDispatch({ nadoCode: 2095 })).toEqual({ kind: "rejected-fatal", code: "2095" });
  });

  it("defaults an ambiguous or unrecognised outcome to UNKNOWN, never not-sent", () => {
    // A post-send timeout (no code, not a pre-send abort) is "maybe placed, query first".
    expect(classifyDispatch({ message: "socket hang up after send" })).toEqual({ kind: "unknown", code: "ORDER_RESULT_UNKNOWN" });
    // A 5xx after the request left: ambiguous.
    expect(classifyDispatch({ httpStatus: 502 }).kind).toBe("unknown");
    // An UNRECOGNISED sequencer code is ambiguous — must NOT be silently dropped as not-sent.
    expect(classifyDispatch({ nadoCode: 9999 }).kind).toBe("unknown");
  });

  it("prioritises deduped over everything (a 2013 even with an odd http status is still placed)", () => {
    expect(classifyDispatch({ nadoCode: 2013, httpStatus: 502 }).kind).toBe("deduped");
  });
});

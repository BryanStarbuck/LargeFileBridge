// Regression cover for the fault classifier and the refusal record (ai_description.mdx §3.5, §2.3).
//
// The case that motivated this file: Gemini refuses an image by returning an EMPTY candidate carrying only
// a `finishReason` — no error, no block verdict, HTTP 200.
//
// A structured refusal is PERMANENT (reversed 2026-07-20 — this file used to pin the opposite). Generation
// is sampled, and one measurement (one slide, 10 identical calls: 6 described, 4 `RECITATION`) argued for a
// re-roll — but in production refusing files burned all 4 attempts plus backoff and were rejected anyway,
// hundreds of wasted provider calls per batch. So a refusal now fails on attempt 1, routes straight to the
// `.ai_description_rejected` record, and never feeds the transient-retry ceiling. Overwrite (§2.3) is the
// deliberate way to re-roll a file the sampling may yet describe.
import { describe, it, expect } from "vitest";
import { classifyProviderFault, attachRejection, rejectionOf, isRefusalFinishReason, withProviderRetry, type ProviderRejection } from "./adapters.js";

const rejection = (over: Partial<ProviderRejection> = {}): ProviderRejection => ({
  provider: "gemini",
  model: "gemini-flash-latest",
  finishReason: "RECITATION",
  finishMessage: "The generated content was filtered because it may contain material that resembles existing copyrighted works.",
  blockReason: null,
  raw: { candidates: [{ finishReason: "RECITATION" }] },
  ...over,
});

const refusal = (over: Partial<ProviderRejection> = {}) =>
  attachRejection(new Error(`Gemini returned no description (finishReason: ${over.finishReason ?? "RECITATION"})`), rejection(over));

describe("classifyProviderFault — a structured refusal is PERMANENT, never retried", () => {
  it.each(["RECITATION", "PROHIBITED_CONTENT", "SAFETY", "BLOCKLIST", "SPII"])(
    "rejects finishReason %s on attempt 1 (content refusal — retrying wastes calls)",
    (finishReason) => {
      expect(classifyProviderFault(refusal({ finishReason }))).toBe("permanent");
    },
  );

  // The prose names the reason for humans; classification must not key off it. Without the attached
  // evidence, "Gemini returned no description (finishReason: RECITATION)" matches the empty-200 rule
  // ("returned no description") and stays transient — only the OBJECT makes it a refusal.
  it("classifies on the attached object, not on words in the message", () => {
    const e = new Error("Gemini returned no description (finishReason: RECITATION)");
    expect(classifyProviderFault(e)).toBe("transient"); // no evidence attached → empty-200 rule applies
    expect(classifyProviderFault(refusal({ finishReason: "RECITATION" }))).toBe("permanent"); // evidence wins
  });

  it("treats a blocked INPUT as permanent too", () => {
    const e = attachRejection(new Error("Gemini blocked the request: OTHER"), rejection({ blockReason: "OTHER", finishReason: null }));
    expect(classifyProviderFault(e)).toBe("permanent");
  });
});

describe("isRefusalFinishReason — which empty responses EARN a .ai_description_rejected", () => {
  it.each(["RECITATION", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"])("records %s", (r) => {
    expect(isRefusalFinishReason(r)).toBe(true);
  });

  // A blank answer is the provider having a bad moment (§3.5) — it retries and usually succeeds. Recording
  // it as a refusal would assert a verdict the provider never reached, and permanently stop re-offering it.
  it.each(["STOP", "MAX_TOKENS", "MALFORMED_RESPONSE", null, undefined])("does NOT record %s", (r) => {
    expect(isRefusalFinishReason(r)).toBe(false);
  });
});

describe("the rejection evidence rides the error", () => {
  it("round-trips every detail the provider sent", () => {
    const r = rejectionOf(refusal());
    expect(r?.finishReason).toBe("RECITATION");
    expect(r?.finishMessage).toMatch(/copyrighted works/);
    expect(r?.raw).toEqual({ candidates: [{ finishReason: "RECITATION" }] });
  });

  // A timeout or a dead account must never write a rejection record — nothing was refused.
  it("is absent on an ordinary fault", () => {
    expect(rejectionOf(new Error("provider call timed out after 123s"))).toBeNull();
  });
});

describe("classifyProviderFault — the faults the refusal rule must not swallow", () => {
  it("still calls a pooled-socket timeout transient", () => {
    // §3.6's stall surfaces as this exact string; it is infrastructure, not a verdict about the file.
    expect(classifyProviderFault(new Error("provider call timed out after 123s"))).toBe("transient");
  });

  it("still calls depleted credits account_dead", () => {
    expect(classifyProviderFault(new Error("429 RESOURCE_EXHAUSTED: prepayment credits are depleted"))).toBe("account_dead");
  });

  it("still calls a revoked key account_dead", () => {
    expect(classifyProviderFault(new Error("403 PERMISSION_DENIED: API key not valid"))).toBe("account_dead");
  });

  it("still calls an ordinary rate limit transient", () => {
    expect(classifyProviderFault(new Error("429 quota exceeded"))).toBe("transient");
  });

  it("keeps a blank empty-200 transient (the empty-200 rule)", () => {
    expect(classifyProviderFault(new Error("Gemini returned no description (finishReason: STOP)"))).toBe("transient");
  });
});

// A refusal must escape the retry loop on ATTEMPT 1 with its evidence intact — the wasted-call bug was
// exactly this loop walking a deterministic refusal through attempts 1→4 (plus backoff) before the caller
// could write the `.ai_description_rejected`. Genuine transients (here: a blank empty-200) still retry;
// `retryAfterMs: 1` pins the backoff clock so the transient case never sleeps for real under vitest.
describe("withProviderRetry — a refusal exits on attempt 1; transients still retry", () => {
  it("does NOT retry a refusal — one attempt, rejection intact", async () => {
    let attempts = 0;
    const always = () => {
      attempts++;
      return Promise.reject(refusal({ finishReason: "RECITATION" }));
    };
    await expect(withProviderRetry("test", always)).rejects.toThrow(/RECITATION/);
    expect(attempts).toBe(1); // a content refusal is a verdict — asking again wastes a billed call
    await expect(withProviderRetry("test2", always).catch((e) => rejectionOf(e)?.finishMessage)).resolves.toMatch(/copyrighted/);
  });

  it("still retries a blank empty-200 to success — the bad-moment case must not be spent", async () => {
    let n = 0;
    const blip = (): Promise<{ text: string; model: string }> => {
      if (++n < 3) {
        const e = new Error("Gemini returned no description (finishReason: STOP)") as Error & { retryAfterMs?: number };
        e.retryAfterMs = 1;
        return Promise.reject(e);
      }
      return Promise.resolve({ text: "a description", model: "m" });
    };
    await expect(withProviderRetry("test3", blip)).resolves.toEqual({ text: "a description", model: "m" });
  });
});

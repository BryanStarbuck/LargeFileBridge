// Regression cover for the fault classifier and the refusal record (ai_description.mdx §3.5, §2.3).
//
// The case that motivated this file: Gemini refuses an image by returning an EMPTY candidate carrying only
// a `finishReason` — no error, no block verdict, HTTP 200.
//
// The counter-intuitive half, and the reason these tests exist: a refusing `finishReason` is NOT permanent.
// Generation is SAMPLED, so the output-side filter is a coin toss. MEASURED on one slide, 10 identical
// calls: 6 described (7.6k-10.2k chars), 4 `RECITATION`. Classifying it permanent would strand a file that
// describes ~60% of the time and write it a rejection record it never earned. Only `promptFeedback.blockReason`
// — the INPUT refused before generation — is a real verdict on the file.
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

describe("classifyProviderFault — a sampled refusal is TRANSIENT, not a verdict", () => {
  it.each(["RECITATION", "PROHIBITED_CONTENT", "SAFETY", "BLOCKLIST", "SPII"])(
    "retries finishReason %s (output-side filter, measured 4/10 flaky)",
    (finishReason) => {
      expect(classifyProviderFault(refusal({ finishReason }))).toBe("transient");
    },
  );

  // The prose names the reason for humans; classification must not key off it. "…(finishReason:
  // PROHIBITED_CONTENT)" contains "PROHIBITED" and would trip the safety regex by pure wording.
  it("classifies on the attached object, not on words in the message", () => {
    const e = new Error("Gemini returned no description (finishReason: PROHIBITED_CONTENT)");
    expect(classifyProviderFault(e)).toBe("permanent"); // no evidence attached → prose is all we have
    expect(classifyProviderFault(refusal({ finishReason: "PROHIBITED_CONTENT" }))).toBe("transient"); // evidence wins
  });

  it("treats a blocked INPUT as permanent — that one IS deterministic", () => {
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

// The seam that makes §2.3 work at all: a refusal now RETRIES (it is sampled), so the evidence has to
// survive all 4 attempts and still be on the error that finally escapes — otherwise the record that the
// provider refused could never be written for the ~2.6% of files that genuinely exhaust their retries.
describe("withProviderRetry — the refusal evidence survives the retries", () => {
  it("retries a refusal, then rethrows it with the rejection intact", async () => {
    let attempts = 0;
    const always = () => {
      attempts++;
      return Promise.reject(refusal({ finishReason: "RECITATION" }));
    };
    await expect(withProviderRetry("test", always)).rejects.toThrow(/RECITATION/);
    expect(attempts).toBe(4); // sampled → worth 4 rolls of the dice, not 1
    await expect(withProviderRetry("test2", always).catch((e) => rejectionOf(e)?.finishMessage)).resolves.toMatch(/copyrighted/);
  });

  it("succeeds on a later attempt — the 6-in-10 case that must not be recorded as a refusal", async () => {
    let n = 0;
    const flaky = () => (++n < 3 ? Promise.reject(refusal()) : Promise.resolve({ text: "a description", model: "m" }));
    await expect(withProviderRetry("test3", flaky)).resolves.toEqual({ text: "a description", model: "m" });
  });
});

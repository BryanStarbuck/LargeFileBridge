// The single deliberate RECITATION re-ask (ai_description.mdx §3.5).
//
// `finishReason: RECITATION` means Gemini generated an answer and then SUPPRESSED IT because the text looked
// like recited training data. It is a verdict about the RESPONSE WORDS, not about the file — so the generic
// retry loop (identical request, 4 times) could never do anything but reproduce it, which is exactly what
// error.err showed it doing. The right recovery is ONE re-ask that changes what we asked for; every OTHER
// refusal (SAFETY, BLOCKLIST, PROHIBITED_CONTENT, …) is a verdict about the file and is never re-asked.
//
// Nothing here touches the network: `fetch` is stubbed, so the whole flow — payload build, response
// interpretation, re-ask decision, refusal record — is exercised without a single live provider call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ADAPTERS, RECITATION_REASK_SUFFIX, isRecitationFinishReason, rejectionOf, withProviderRetry } from "./adapters.js";

const gemini = ADAPTERS.find((a) => a.id === "gemini")!;

/** A Gemini 200 that carries a real description. */
const described = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: "m", responseId: "r" });
/** A Gemini 200 that carries an EMPTY candidate + a refusing finishReason — how a refusal actually arrives. */
const refused = (finishReason: string) => ({
  candidates: [{ finishReason, finishMessage: `blocked: ${finishReason}` }],
  modelVersion: "m",
  responseId: "r",
});

let tmpDir: string;
let mediaPath: string;
let bodies: Array<Record<string, unknown>>;

/** Queue up the responses the stubbed provider will return, in order, and record every request body. */
function stubProvider(responses: unknown[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const r = responses[Math.min(i++, responses.length - 1)];
      return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

const callCount = () => bodies.length;
const promptOf = (b: Record<string, unknown>): string =>
  ((b.contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[0].text ?? "");
const tempOf = (b: Record<string, unknown>): unknown => (b.generationConfig as Record<string, unknown> | undefined)?.temperature;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-reask-"));
  mediaPath = path.join(tmpDir, "slide.png");
  fs.writeFileSync(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  process.env.GEMINI_API_KEY = "test-key-not-real";
});
afterAll(() => {
  delete process.env.GEMINI_API_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  bodies = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const call = () => gemini.describe({ absPath: mediaPath, kind: "image", mimeType: "image/png", prompt: "Describe this image." });

describe("isRecitationFinishReason — only RECITATION is re-askable", () => {
  it.each(["RECITATION", "recitation"])("says yes to %s", (r) => expect(isRecitationFinishReason(r)).toBe(true));
  it.each(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "STOP", null, undefined])("says no to %s", (r) =>
    expect(isRecitationFinishReason(r)).toBe(false),
  );
});

describe("the Gemini adapter's RECITATION re-ask", () => {
  it("re-asks ONCE with varied wording and returns the description", async () => {
    stubProvider([refused("RECITATION"), described("A slide with three bullet points.")]);
    await expect(call()).resolves.toMatchObject({ text: "A slide with three bullet points." });
    expect(callCount()).toBe(2); // exactly one extra call — never the old 4-attempt loop
    // The re-ask must be a DIFFERENT ask: the original request is untouched, the second carries the
    // original-phrasing instruction and a raised temperature so the sampler cannot repeat its own path.
    expect(promptOf(bodies[0])).toBe("Describe this image.");
    expect(promptOf(bodies[1])).toBe("Describe this image." + RECITATION_REASK_SUFFIX);
    expect(tempOf(bodies[0])).toBeUndefined();
    expect(tempOf(bodies[1])).toBe(1.0);
  });

  it("gives up after ONE re-ask and hands back the refusal evidence", async () => {
    stubProvider([refused("RECITATION"), refused("RECITATION")]);
    const err = await call().catch((e: unknown) => e);
    expect(callCount()).toBe(2); // one ask + one re-ask, then stop — the deterministic case never loops
    expect((err as Error).message).toMatch(/RECITATION/);
    expect(rejectionOf(err)?.finishReason).toBe("RECITATION"); // earns its .ai_description_rejected record
  });

  it("does NOT re-ask any other refusal — those are verdicts about the FILE", async () => {
    for (const reason of ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]) {
      bodies = [];
      stubProvider([refused(reason), described("should never be reached")]);
      const err = await call().catch((e: unknown) => e);
      expect(callCount()).toBe(1);
      expect(rejectionOf(err)?.finishReason).toBe(reason);
      vi.unstubAllGlobals();
    }
  });

  it("does NOT re-ask a blank empty-200 — that one is a blip the retry policy owns", async () => {
    stubProvider([refused("STOP"), described("should never be reached")]);
    const err = await call().catch((e: unknown) => e);
    expect(callCount()).toBe(1);
    expect(rejectionOf(err)).toBeNull(); // no refusal evidence → stays transient, no rejection record
  });

  it("never re-asks a blocked INPUT — no wording can move a verdict on the upload", async () => {
    stubProvider([{ promptFeedback: { blockReason: "OTHER" } }, described("should never be reached")]);
    const err = await call().catch((e: unknown) => e);
    expect(callCount()).toBe(1);
    expect(rejectionOf(err)?.blockReason).toBe("OTHER");
  });
});

describe("the retry loop around it", () => {
  // The whole point of the re-ask living INSIDE the adapter: a refusal still classifies permanent, so
  // withProviderRetry spends exactly one attempt on it. Total provider cost of a doomed RECITATION file is
  // 2 calls, not the 4-plus-backoff the log showed.
  it("spends ONE attempt on a twice-refused file (2 provider calls total)", async () => {
    stubProvider([refused("RECITATION"), refused("RECITATION")]);
    await expect(withProviderRetry("recitation file", call)).rejects.toThrow(/RECITATION/);
    expect(callCount()).toBe(2);
  });
});

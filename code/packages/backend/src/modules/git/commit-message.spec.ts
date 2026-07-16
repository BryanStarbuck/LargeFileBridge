// HONEST COMMIT MESSAGES (storage_personal.mdx §17.4.2 / AC-26).
//
// Every LFB commit used to be titled "LFB: backbone device state". Proven live on 2026-07-16: a HEAD commit
// of `13 files changed` = 12 `.ai_description` files (2,385 lines of the user's work) + one devices/*.yaml,
// all labelled "device state". 1,900+ such commits made the history unreadable and unauditable.
import { describe, it, expect } from "vitest";
import { composeCommitMessage } from "./git.service.js";

const empty = { staged: [] as string[], created: [] as string[], renamed: [] as Array<{ from: string; to: string }>, deleted: [] as string[] };

describe("composeCommitMessage — the subject states what the commit actually carries", () => {
  it("names the user's work, and leads with it rather than the device noise", () => {
    const msg = composeCommitMessage({
      ...empty,
      created: [
        "_Mirror/Politics/a.mp4.ai_description",
        "_Mirror/Politics/b.mp4.ai_description",
        "_Mirror/Politics/c.mp4.ai_description",
      ],
      staged: ["devices/bryan-mac-pro.yaml"],
    });
    // The real defect: this exact shape used to read "LFB: backbone device state".
    expect(msg).toBe("LFB: 3 AI descriptions, device state");
    expect(msg.indexOf("AI descriptions")).toBeLessThan(msg.indexOf("device state"));
  });

  it("keeps the blanket title ONLY when device state is genuinely all that changed", () => {
    expect(composeCommitMessage({ ...empty, staged: ["devices/bryan-mac-pro.yaml"] })).toBe("LFB: device state");
  });

  it("falls back to the legacy subject when nothing is staged", () => {
    expect(composeCommitMessage(empty)).toBe("LFB: backbone device state");
  });

  it("counts each artifact kind separately, most numerous first", () => {
    const msg = composeCommitMessage({
      ...empty,
      created: ["a.mp4.transcription", "b.mp4.ai_description", "c.mp4.ai_description", "d.png.ocr"],
    });
    expect(msg).toBe("LFB: 2 AI descriptions, 1 transcripts, 1 OCR texts");
  });

  it("distinguishes a refusal record from a description (§2.3 — an answer, not a description)", () => {
    expect(composeCommitMessage({ ...empty, created: ["a.mp4.ai_description_rejected"] })).toBe("LFB: 1 AI refusals");
  });

  it("names the singleton ledgers without a count", () => {
    const msg = composeCommitMessage({ ...empty, staged: ["manifest.yaml", "decisions.yaml"] });
    expect(msg).toContain("manifest");
    expect(msg).toContain("1 decisions");
  });

  it("counts renames by their destination and includes deletions", () => {
    const msg = composeCommitMessage({
      ...empty,
      renamed: [{ from: "devices/old-name.yaml", to: "devices/new-name.yaml" }],
      deleted: ["devices/old-name.yaml"],
    });
    expect(msg).toBe("LFB: device state");
  });

  it("never double-counts a path that appears in two status buckets", () => {
    const msg = composeCommitMessage({ ...empty, staged: ["x.mp4.ai_description"], created: ["x.mp4.ai_description"] });
    expect(msg).toBe("LFB: 1 AI descriptions");
  });
});

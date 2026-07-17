import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiStub } = vi.hoisted(() => ({
  apiStub: {
    ocrPlan: vi.fn(async () => ({
      files: [
        { path: "/a/shot.png", sizeBytes: 1234 },
        { path: "/a/deck.mp4", sizeBytes: 999999, frames: 8 },
      ],
      considered: 2, alreadyDone: 0,
    })),
    ocrEngines: vi.fn(async () => ({ anyAvailable: true })),
    ocrEnqueue: vi.fn(async () => ({})),
    describePlan: vi.fn(async () => ({ files: [{ path: "/a/shot.png", sizeBytes: 1 }], considered: 1, alreadyDone: 0 })),
  },
}));
vi.mock("../api/client.js", () => ({ api: apiStub }));
vi.mock("@/api/client", () => ({ api: apiStub }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), promise: vi.fn(), message: vi.fn() }) }));

import { openOcrBatch, openDescribeBatch, onBatchPopupRequested, type BatchPopupState } from "./batchPopup.js";

describe("batch popup bus", () => {
  let seen: BatchPopupState[] = [];
  beforeEach(() => { seen = []; onBatchPopupRequested((s) => { seen.push(s); }); });

  it("openOcrBatch pushes loading THEN popup", async () => {
    await openOcrBatch({ root: "/a" });
    console.log("OCR states:", seen.map((s) => s?.kind ?? "null"));
    const popup = seen.find((s) => s?.kind === "popup");
    console.log("OCR popup headline:", popup && "def" in popup ? popup.def.headline : "NONE");
    expect(seen[0]?.kind).toBe("loading");
    expect(popup).toBeTruthy();
  });

  it("openDescribeBatch pushes loading THEN popup", async () => {
    await openDescribeBatch({ root: "/a" });
    console.log("DESCRIBE states:", seen.map((s) => s?.kind ?? "null"));
    expect(seen.find((s) => s?.kind === "popup")).toBeTruthy();
  });
});

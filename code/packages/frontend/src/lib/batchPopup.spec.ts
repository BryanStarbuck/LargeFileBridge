// The batch-popup BUS (dialogs.mdx §5.3/§5.4). These lock the property every producing entry point depends
// on: a click is NEVER a no-op. The reported "Create OCR text does nothing" had the /plan request reaching
// the backend (it logged the preview) while no spinner and no popup ever appeared — the signature of the bus
// dropping the state because no host was registered at that instant.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiStub } = vi.hoisted(() => ({
  apiStub: {
    ocrPlan: vi.fn(async () => ({
      files: [
        { path: "/a/shot.png", sizeBytes: 1234 },
        { path: "/a/deck.mp4", sizeBytes: 999999, frames: 8 },
      ],
      considered: 2,
      alreadyDone: 0,
    })),
    ocrEngines: vi.fn(async () => ({ anyAvailable: true })),
    ocrEnqueue: vi.fn(async () => ({})),
  },
}));
vi.mock("../api/client.js", () => ({ api: apiStub }));
vi.mock("@/api/client", () => ({ api: apiStub }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), promise: vi.fn(), message: vi.fn(), success: vi.fn() }),
}));
vi.mock("./clientLog.js", () => ({ clientLog: { error: vi.fn() } }));

import { openOcrBatch, onBatchPopupRequested, type BatchPopupState } from "./batchPopup.js";

describe("batch popup bus (dialogs.mdx §5.4)", () => {
  let seen: BatchPopupState[];
  beforeEach(() => {
    seen = [];
  });

  it("shows the spinner FIRST, then the popup, when a host is mounted", async () => {
    const off = onBatchPopupRequested((s) => seen.push(s));
    await openOcrBatch({ root: "/a" });
    expect(seen[0]?.kind).toBe("loading"); // §5.4 — synchronous, before the walk is awaited
    const popup = seen.find((s) => s?.kind === "popup");
    expect(popup).toBeTruthy();
    off();
  });

  it("buffers the popup when NO host is mounted and delivers it on registration", async () => {
    // No host registered at click time — the old bus did `listener?.(…)` and silently dropped BOTH the
    // spinner and the popup, leaving a click that fired a /plan request and showed the user nothing.
    await openOcrBatch({ root: "/a" });
    onBatchPopupRequested((s) => seen.push(s));
    const popup = seen.find((s) => s?.kind === "popup");
    expect(popup).toBeTruthy();
    expect(popup && "def" in popup && popup.def.id).toBe("batch-ocr");
  });

  it("shows the video row's frame-count hint where the row actually renders it (ocr.mdx §9.2)", async () => {
    const off = onBatchPopupRequested((s) => seen.push(s));
    await openOcrBatch({ root: "/a" });
    const popup = seen.find((s) => s?.kind === "popup");
    const targets = popup && "def" in popup ? popup.def.popup!.targets! : [];
    const video = targets.find((t) => t.id === "/a/deck.mp4")!;
    // `sublabel` is a legacy fallback the row ignores whenever pathText is set — the hint must ride sizeText.
    expect(video.sizeText).toContain("8 frames");
    expect(video.sublabel).toBeUndefined();
    off();
  });
});

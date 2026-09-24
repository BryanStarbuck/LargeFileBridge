// The shared preview-row helper (warnings.mdx §4.5.2 rev 2026-09-24). Locks the two halves every popup host
// used to hand-roll — and the batch-confirm popup forgot: a previewable row, and a grant for its bytes.
import { describe, it, expect, vi } from "vitest";

const { apiStub, logStub } = vi.hoisted(() => ({
  apiStub: { mediaGrant: vi.fn(async (p: string) => ({ url: `/api/media/raw?path=${encodeURIComponent(p)}` })) },
  logStub: { error: vi.fn() },
}));
vi.mock("../api/client.js", () => ({ api: apiStub }));
vi.mock("./clientLog.js", () => ({ clientLog: logStub }));

import { grantPreviewResolver, previewForPath } from "./popupPreview.js";

describe("previewForPath", () => {
  it("previews images, videos, audio and PDFs lazily, with an Open ↗ viewer link", () => {
    expect(previewForPath("/r/a.mp4")).toMatchObject({ kind: "video", url: "" });
    expect(previewForPath("/r/a.JPG")?.kind).toBe("image");
    expect(previewForPath("/r/a.wav")?.kind).toBe("audio");
    expect(previewForPath("/r/deck.pdf")?.kind).toBe("pdf");
    expect(previewForPath("/r/a.mp4")?.openHref).toMatch(/^\/video\?path=/);
    expect(decodeURIComponent(previewForPath("/r/deck.pdf")!.openHref!)).toContain("/r/deck.pdf");
  });

  it("gives other file types no preview", () => {
    expect(previewForPath("/r/notes.txt")).toBeUndefined();
    expect(previewForPath("/r/archive.zip")).toBeUndefined();
  });
});

describe("grantPreviewResolver", () => {
  const target = { id: "rel/a.mp4", label: "rel/a.mp4" };

  it("grants the absolute path the host maps the target to", async () => {
    const resolve = grantPreviewResolver((t) => `/repo/${t.id}`, "spec");
    await expect(resolve(target)).resolves.toContain(encodeURIComponent("/repo/rel/a.mp4"));
    expect(apiStub.mediaGrant).toHaveBeenCalledWith("/repo/rel/a.mp4");
  });

  it("logs and returns null when the grant fails, so the pane never spins forever", async () => {
    apiStub.mediaGrant.mockRejectedValueOnce(new Error("outside browse roots"));
    const resolve = grantPreviewResolver((t) => t.id, "spec.tag");
    await expect(resolve(target)).resolves.toBeNull();
    expect(logStub.error).toHaveBeenCalledWith("spec.tag", expect.any(Error));
  });
});

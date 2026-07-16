// THE WRITE IS THE TRIGGER (storage_personal.mdx §18.5.3 / AC-29, AC-30).
//
// These tests pin the behavior that repeals the STOWAWAY DEFECT: before this module, no code path had
// committing the user's finished work as its purpose, so transcripts/AI descriptions reached the server only
// as stowaways on the device worker's `git add -A` — sitting uncommitted for 10-30 minutes (observed live:
// 23 files, 15 minutes stale), or forever if any of the six §18.5.2 forever-cases applied.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = { id: string; type: string; root: string };
const syncStorageText = vi.fn<(id: string) => Promise<{ ran: boolean; committed?: boolean; pushed?: boolean }>>(
  async () => ({ ran: true, committed: true, pushed: true }),
);
const listStorageIds = vi.fn<() => string[]>(() => []);
const getStorageRow = vi.fn<(id: string) => Row | null>(() => null);

vi.mock("./pin.service.js", () => ({ syncStorageText }));
vi.mock("../storage/storage.service.js", () => ({
  listStorageIds: () => listStorageIds(),
  getStorageRow: (id: string) => getStorageRow(id),
}));
vi.mock("../fs/badges.js", () => ({ expandHome: (p: string) => p }));

const ROWS: Record<string, Row> = {
  personal: { id: "personal", type: "personal", root: "/Users/x/BGit/Bryan_git/personal_large_files_bridge" },
  acme: { id: "acme", type: "company", root: "/Users/x/BGit/Bryan_git/acme_large_files_bridge" },
  local: { id: "local", type: "local", root: "/Users/x" },
};

async function importFresh(): Promise<typeof import("./sync-trigger.service.js")> {
  vi.resetModules();
  return import("./sync-trigger.service.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  syncStorageText.mockClear();
  listStorageIds.mockReturnValue(Object.keys(ROWS));
  getStorageRow.mockImplementation((id) => ROWS[id] ?? null);
});
afterEach(() => vi.useRealTimers());

describe("noteArtifactWritten — producing an artifact schedules its own sync (§18.5.3.1)", () => {
  it("syncs the owning storage after the debounce, not on the artifact write itself", async () => {
    const { noteArtifactWritten } = await importFresh();
    noteArtifactWritten(`${ROWS.personal.root}/_Mirror/a.mp4.ai_description`, "AI descriptions");

    // The write must NOT synchronously run git — the batch is still producing.
    expect(syncStorageText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncStorageText).toHaveBeenCalledOnce();
    expect(syncStorageText).toHaveBeenCalledWith("personal");
  });

  it("coalesces a burst into ONE pass — 300 descriptions must not mean 300 passes (§18.4)", async () => {
    const { noteArtifactWritten } = await importFresh();
    for (let i = 0; i < 300; i++) {
      noteArtifactWritten(`${ROWS.personal.root}/_Mirror/f${i}.mp4.ai_description`, "AI descriptions");
      await vi.advanceTimersByTimeAsync(50); // a steady batch, faster than the debounce
    }
    expect(syncStorageText).not.toHaveBeenCalled(); // still producing — debounce keeps deferring

    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncStorageText).toHaveBeenCalledOnce();
  });

  it("never defers past the 120s max delay, so a long batch still checkpoints (§18.4)", async () => {
    const { noteArtifactWritten } = await importFresh();
    // A batch writing continuously for well past the max delay: the debounce alone would starve forever.
    for (let i = 0; i < 200; i++) {
      noteArtifactWritten(`${ROWS.personal.root}/_Mirror/f${i}.mp4.ai_description`, "AI descriptions");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(syncStorageText).toHaveBeenCalled(); // fired at the 120s ceiling despite never going quiet
  });

  it("routes each artifact to the storage that owns it (longest root prefix)", async () => {
    const { noteArtifactWritten } = await importFresh();
    noteArtifactWritten(`${ROWS.acme.root}/videos/x.mp4.transcription`, "transcripts");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncStorageText).toHaveBeenCalledWith("acme");
  });

  it("is a NO-OP outside a dedicated file repo — LFB is a guest in a working repo (§16.1)", async () => {
    const { noteArtifactWritten } = await importFresh();
    noteArtifactWritten("/Users/x/BGit/some_working_repo/videos/x.mp4.ai_description", "AI descriptions");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncStorageText).not.toHaveBeenCalled();
  });

  it("does not let /a/b claim /a/bcd — prefix match is on a path boundary", async () => {
    const { noteArtifactWritten } = await importFresh();
    noteArtifactWritten(`${ROWS.personal.root}_OTHER/x.mp4.ai_description`, "AI descriptions");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncStorageText).not.toHaveBeenCalled();
  });

  it("never throws into the artifact writer's success path when the sync fails", async () => {
    syncStorageText.mockRejectedValueOnce(new Error("git exploded"));
    const { noteArtifactWritten } = await importFresh();
    expect(() => noteArtifactWritten(`${ROWS.personal.root}/a.mp4.ocr`, "OCR texts")).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(20_000)).resolves.not.toThrow();
  });

  it("flushArtifactSync fires pending work immediately (the batch-completion hook)", async () => {
    const { noteArtifactWritten, flushArtifactSync } = await importFresh();
    noteArtifactWritten(`${ROWS.personal.root}/a.mp4.ai_description`, "AI descriptions");
    flushArtifactSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncStorageText).toHaveBeenCalledOnce();
  });
});

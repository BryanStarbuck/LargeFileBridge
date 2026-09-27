// The sync fence's behaviour that does NOT need a database — which is most of what can go wrong with it.
//
// `vitest.config.ts` clamps `LFB_DB_MODE=off` for the whole suite (deliberately: an unredirected spec would
// otherwise read and write the user's real `largefilebridge`), so every test here runs on the posture that
// is true of every machine today. That is the point rather than a limitation: R2 says the app must work
// with no Postgres, and the fence sits in front of `mirrorToSyncRepo`, which is on the SCAN write path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionEvent } from "@lfb/shared";
import { serializeLedger } from "./ledger-merge.js";
import {
  digestOnDisk,
  fenceWarnDue,
  ledgerTextWithoutProvenance,
  recordSdlIngestForRepo,
  resetFenceWarnMemo,
  sameIgnoringProvenance,
  renderWritesArmed,
  resetDiskDigestMemo,
  sidecarFileFor,
  sidecarFiles,
  sidecarKeyFor,
  syncFenceBeforeMirror,
  unitDocTargets,
} from "./doc-render.service.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-doc-render-"));
  resetDiskDigestMemo();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSidecar(rel: string, doc: unknown): string {
  const file = path.join(tmp, "files", `${rel}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(doc, { sortMapEntries: true }), "utf8");
  return file;
}

describe("the sidecar key comes from the DOCUMENT, never from the filename", () => {
  // THE REGRESSION THIS EXISTS FOR, found by the first full gate run and worth stating in full.
  //
  // macOS is case-insensitive. `sidecarPath()` mirrors the media's relative path under `files/`, and
  // `sidecar-heal.ts` makes a new write reuse whatever spelling of a directory already exists — so a
  // sidecar whose `path:` is `internal/feed/Feed_Ranking/x.jpg` legitimately lives at
  // `files/internal/feed/feed_ranking/x.jpg.yaml`. Both spellings also exist as separate `lfb.file` rows,
  // because they are two different files in two different repos.
  //
  // Deriving the key from the filename therefore looked up a DIFFERENT file's row, and the gate reported
  // 4,427 sidecars as "every event lost" when nothing was lost at all. `sidecar-backfill.ts` has always
  // keyed on `doc.file.path`; this test is what keeps the reader of those rows agreeing with their writer.
  it("prefers the recorded file.path over the path it is stored at", () => {
    const file = writeSidecar("internal/feed/feed_ranking/x.jpg", {
      file: { path: "internal/feed/Feed_Ranking/x.jpg", name: "x.jpg" },
    });
    expect(sidecarKeyFor(file, tmp)).toBe("internal/feed/Feed_Ranking/x.jpg");
  });

  it("heals a Windows peer's backslash spelling, matching the generated rel_posix column", () => {
    const file = writeSidecar("legacy", { file: { path: "_mix\\rotten\\27k_data.csv", name: "27k_data.csv" } });
    expect(sidecarKeyFor(file, tmp)).toBe("_mix/rotten/27k_data.csv");
  });

  it("falls back to the stored path when the document records none", () => {
    const file = writeSidecar("a/b/c.mp4", { file: { path: "" } });
    expect(sidecarKeyFor(file, tmp)).toBe("a/b/c.mp4");
  });

  it("returns null for a document that does not parse — a reject, never a gate diff", () => {
    const file = path.join(tmp, "files", "broken.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "file:\n  path: [unterminated\n", "utf8");
    expect(sidecarKeyFor(file, tmp)).toBeNull();
  });

  it("finds every sidecar under files/, and nothing else", () => {
    writeSidecar("one.mp4", { file: { path: "one.mp4" } });
    writeSidecar("deep/two.mp4", { file: { path: "deep/two.mp4" } });
    fs.writeFileSync(path.join(tmp, "files", "notes.txt"), "not a sidecar", "utf8");
    fs.writeFileSync(path.join(tmp, "decisions.yaml"), "events: []", "utf8");
    expect(sidecarFiles(tmp).map((f) => path.relative(tmp, f)).sort()).toEqual([
      path.join("files", "deep", "two.mp4.yaml"),
      path.join("files", "one.mp4.yaml"),
    ]);
  });

  it("sidecarFileFor round-trips a POSIX key into the mirrored hierarchy", () => {
    expect(sidecarFileFor(tmp, "a/b/c.mp4")).toBe(path.join(tmp, "files", "a", "b", "c.mp4.yaml"));
    // A `\`-spelled key becomes a real hierarchy, never a flat file literally named `a\b.mp4.yaml` — the
    // spelling that cannot be checked out on Windows at all (file-sidecar.service.ts sidecarPath).
    expect(sidecarFileFor(tmp, "a\\b.mp4")).toBe(path.join(tmp, "files", "a", "b.mp4.yaml"));
  });
});

describe("the on-disk digest is memoized on (ino, size, mtimeNs)", () => {
  it("re-hashes only when the file actually moves", () => {
    const file = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(file, "one", "utf8");
    const first = digestOnDisk(file);
    expect(first).not.toBeNull();
    expect(digestOnDisk(file)).toBe(first); // same OBJECT — the memo, not a re-hash

    // A rewrite at a different size moves the identity, so the digest must change.
    fs.writeFileSync(file, "two two", "utf8");
    const second = digestOnDisk(file);
    expect(second).not.toBe(first);
    expect(second?.bytes).toBe(7);
  });

  it("answers null for an absent file and forgets it", () => {
    const file = path.join(tmp, "gone.yaml");
    fs.writeFileSync(file, "x", "utf8");
    expect(digestOnDisk(file)).not.toBeNull();
    fs.rmSync(file);
    expect(digestOnDisk(file)).toBeNull();
  });
});

describe("the fence is inert with no database (R2)", () => {
  it("syncFenceBeforeMirror does nothing and says why", async () => {
    const out = await syncFenceBeforeMirror(path.join(tmp, "repo"));
    expect(out).toEqual({ recorded: 0, written: 0, diffs: 0, unchanged: 0, skipped: "no-database" });
  });

  it("recordSdlIngestForRepo does nothing and says why", async () => {
    const out = await recordSdlIngestForRepo(path.join(tmp, "repo"), path.join(tmp, "sdl"), path.join(tmp, "sub"));
    expect(out).toEqual({ recorded: 0, eventsIn: 0, claimsIn: 0, skipped: "no-database" });
  });

  it("the Postgres-fed write is disarmed unless the env var is set", () => {
    expect(renderWritesArmed()).toBe(false);
  });
});

describe("the pre-mirror fence covers the whole-unit documents ONLY", () => {
  // THE COST RULE, as a test. `storage.mirror` runs ~101 times a minute on this machine and one repo here
  // holds 20,062 of the 29,138 sidecars. Adding the sidecar plane to the pre-mirror pass would re-introduce
  // the per-entry walk this slice exists to shorten — so the sidecars' doc_render rows are seeded by the
  // gate (once per migration), never by the mirror. If someone adds a fifth target here, it had better not
  // be per-file.
  it("names exactly manifest, decisions, decisions_policy and repo_storage", () => {
    const targets = unitDocTargets(7, tmp);
    expect(targets.map((t) => t.doc).sort()).toEqual(["decisions", "decisions_policy", "manifest", "repo_storage"]);
    expect(targets.every((t) => t.unitId === 7)).toBe(true);
    expect(targets.every((t) => path.dirname(t.file) === tmp)).toBe(true);
  });

  it("files the manifest under stage 'tracking' — the copy that TRAVELS", () => {
    // `pin/r/<folder>/manifest.yaml` (stage 'unit') and `repos/<key>/manifest.yaml` (stage 'tracking') are
    // two stages of a pipeline, and the tracking write is gated behind `publish_manifest`
    // (pin.service.ts). The pre-mirror fence looks at Local Storage, which is the tracking copy.
    const manifest = unitDocTargets(7, tmp).find((t) => t.doc === "manifest");
    expect(manifest?.docKey).toBe("tracking");
    expect(manifest?.file).toBe(path.join(tmp, "manifest.yaml"));
  });
});

describe("the fence WARN says a situation once, not once per mirror pass", () => {
  beforeEach(() => resetFenceWarnMemo());

  it("warns the first time, stays quiet while nothing changes, and says a changed SET at INFO", () => {
    const t0 = Date.parse("2026-09-27T12:00:00.000Z");
    expect(fenceWarnDue("/r/charlie-kirk", ["decisions", "manifest"], t0)).toBe("warn");
    // ~100 mirror passes a minute: 197 identical lines in two days before this memo.
    for (let i = 1; i <= 100; i++) expect(fenceWarnDue("/r/charlie-kirk", ["manifest", "decisions"], t0 + i * 600)).toBeNull();
    // The set flips every time a peer's pass moves a document ahead of the render — news, but not a fault.
    expect(fenceWarnDue("/r/charlie-kirk", ["decisions"], t0 + 70_000)).toBe("info");
    expect(fenceWarnDue("/r/charlie-kirk", ["decisions", "manifest"], t0 + 80_000)).toBe("info");
    expect(fenceWarnDue("/r/other", ["decisions"], t0 + 70_000)).toBe("warn"); // repos are independent
  });

  it("repeats as a WARN at most hourly per repo, so a standing disagreement is not forgotten", () => {
    const t0 = Date.parse("2026-09-27T12:00:00.000Z");
    expect(fenceWarnDue("/r/a", ["decisions"], t0)).toBe("warn");
    expect(fenceWarnDue("/r/a", ["decisions"], t0 + 59 * 60_000)).toBeNull();
    expect(fenceWarnDue("/r/a", ["decisions"], t0 + 61 * 60_000)).toBe("warn");
  });
});

describe("the render comparison sets writer provenance aside — and nothing else", () => {
  const ev = (at: string, over: Partial<DecisionEvent> = {}): DecisionEvent => ({
    sid: "r:1",
    path: "videos/a.mp4",
    fingerprint: null,
    asked: true,
    ipfs: true,
    gitignore: false,
    decided_by: "bryan",
    decided_at: at,
    ...over,
  });
  const rows = [ev("2026-09-27T10:00:00.000Z"), ev("2026-09-27T11:00:00.000Z", { path: "videos/b.mp4" })];
  // What a render from `decision_event` produces: no stamp columns exist, so no stamps.
  const rendered = serializeLedger(rows);
  const stamp = (e: DecisionEvent): DecisionEvent => ({ ...e, writer_build: 7, writer_device: "tower" }) as DecisionEvent;

  it("treats a stamped ledger on disk as matching the stamp-less render", () => {
    const file = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(file, serializeLedger(rows.map(stamp)));
    expect(fs.readFileSync(file, "utf8")).not.toBe(rendered); // the byte gate alone would call this a diff
    expect(sameIgnoringProvenance({ doc: "decisions", file }, rendered)).toBe(true);
  });

  it("still reports a real difference in a stamped ledger", () => {
    const file = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(file, serializeLedger([...rows, ev("2026-09-27T12:00:00.000Z", { ipfs: false })].map(stamp)));
    expect(sameIgnoringProvenance({ doc: "decisions", file }, rendered)).toBe(false);
  });

  it("applies to the decision ledger only, and only when there are stamps to set aside", () => {
    const file = path.join(tmp, "manifest.yaml");
    fs.writeFileSync(file, "writer_build: 7\n");
    expect(sameIgnoringProvenance({ doc: "manifest", file }, "anything")).toBe(false);
    expect(ledgerTextWithoutProvenance(rendered)).toBeNull();
  });
});

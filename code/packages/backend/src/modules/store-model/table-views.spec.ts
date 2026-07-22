// Per-table view persistence (tables.mdx §4) — the round trip the UI actually depends on.
//
// Runner: vitest (`pnpm test` in this package).
//
// THE BUG THIS EXISTS FOR. The PUT body was validated by a hand-written zod object that listed the
// fields one by one, and it had drifted: `file_filter` — the entire §2.11 Filter dropdown state on every
// file table — was missing from it. zod objects STRIP unknown keys, so the browser sent the filter, the
// server answered `200 { ok: true }`, and the value was thrown away. Nothing failed, nothing logged; the
// user simply found their filter gone after every reload while the sort and search beside it survived.
//
// Two invariants keep that from recurring:
//   1. WIRE COMPLETENESS — every field of TableView survives a save/load round trip. Derive the body
//      schema from TableViewSchema (as the router now does) and this holds by construction.
//   2. PATCH SEMANTICS — a partial write changes only the keys it sends. Not every writer sends the
//      whole view (FullPathsPage persists `file_filter` alone), and defaulting the absent keys wipes
//      that table's sort/search/columns.
import { test, beforeEach, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TableViewSchema } from "@lfb/shared";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-table-views-test-"));
process.env.LFB_STATE_DIR = TMP;
process.env.LFB_LOG_DIR = TMP;

const { loadTableViews, saveTableView } = await import("./table-views.service.js");

const EMAIL = "viewtest@example.com";
const NOW = "2026-07-22T12:00:00.000Z";

beforeEach(() => {
  fs.rmSync(path.join(TMP, "users"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// The full view a file table writes — one non-default value in EVERY persisted field, so any field the
// wire drops shows up as a concrete difference rather than a coincidental match against a default.
const FULL = {
  sort: [{ col: "size", dir: "desc" as const }],
  filters: { name: "trees" },
  search: "charlie_kirk",
  hidden_columns: ["peers"],
  large_only: true,
  hidden_types: ["other", "video"],
  file_filter: "transcribe = not_yet AND size = only_large",
  facet_hidden: { match_basis: ["fingerprint"] },
};

test("every persisted field survives the round trip — no field is silently dropped", async () => {
  await saveTableView(EMAIL, "repo-files:all", FULL, NOW);
  const back = loadTableViews(EMAIL)["repo-files:all"];

  for (const [key, want] of Object.entries(FULL)) {
    assert.deepEqual(
      back[key as keyof typeof back],
      want,
      `${key} did not survive the save/load round trip — it is being dropped on the wire`,
    );
  }
});

// The guard for invariant 1 itself: if someone adds a field to TableViewSchema, FULL above must grow to
// cover it, or the round-trip test above silently stops testing the new field.
test("the round-trip fixture covers every field TableViewSchema declares", () => {
  const declared = Object.keys(TableViewSchema.shape).filter((k) => k !== "updated_at");
  const covered = Object.keys(FULL);
  const missing = declared.filter((k) => !covered.includes(k));
  assert.deepEqual(
    missing,
    [],
    `TableViewSchema gained field(s) ${missing.join(", ")} — add them to FULL (and to the UI's save ` +
      `payload + hydration in DataTable.tsx), or they will persist for nobody.`,
  );
});

// THE ACTUAL REGRESSION POINT. The service was always willing to store `file_filter`; the router's body
// schema is what silently deleted it before the service ever saw it. Parse the exact payload the browser
// sends through the exact schema the route uses.
test("the wire schema keeps every field the browser sends — it must not strip", async () => {
  const { viewBody } = await import("./table-views.router.js");
  const parsed = viewBody.parse(FULL);
  assert.deepEqual(
    parsed,
    FULL,
    "the PUT body schema dropped a field — zod strips unknown keys, so anything it does not declare " +
      "is discarded with a 200 and no log line",
  );
});

test("a partial patch changes only the keys it sends", async () => {
  await saveTableView(EMAIL, "fs-paths", FULL, NOW);
  // FullPathsPage's writer: file_filter and nothing else.
  await saveTableView(EMAIL, "fs-paths", { file_filter: "ocr = done" }, NOW);

  const back = loadTableViews(EMAIL)["fs-paths"];
  assert.equal(back.file_filter, "ocr = done", "the sent key must be updated");
  assert.deepEqual(back.sort, FULL.sort, "an unsent key must not be reset to its default");
  assert.equal(back.search, FULL.search, "an unsent key must not be reset to its default");
  assert.deepEqual(back.hidden_columns, FULL.hidden_columns, "an unsent key must not be reset");
});

test("writing one table never clobbers another table's view", async () => {
  await saveTableView(EMAIL, "repos", { search: "alpha" }, NOW);
  await saveTableView(EMAIL, "storages", { search: "beta" }, NOW);

  const all = loadTableViews(EMAIL);
  assert.equal(all["repos"].search, "alpha");
  assert.equal(all["storages"].search, "beta");
});

test("a fresh user reads back an empty map, not an error", () => {
  assert.deepEqual(loadTableViews("nobody@example.com"), {});
});

// D2 — the three-state rule (crash_recovery.mdx §5). Runner: vitest (`pnpm test` in this package).
//
// This is the test for the defect the incident review calls "the core product defect": on 2026-07-15 an
// OOM destroyed ~1,290 queued jobs and this page rendered "Nothing is processing right now." — the calm
// Empty copy — for six hours. D1 lost the work; **D2 hid the loss**.
//
// The LOCKED rule being pinned: an empty page renders **Empty** ONLY when the app can affirmatively
// assert nothing was interrupted. Unknown ⇒ Interrupted. We fail toward telling the user something
// happened. Most of these cases exist to make it impossible to quietly regress back toward Empty.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { SessionView } from "@lfb/shared";
import { deriveEmptyState, sessionCopy } from "./sessionState.js";

const clean: SessionView = { startedAt: "2026-07-16T04:00:00.000Z", previousEnded: "clean" };

test("Empty: a clean previous session with no work ⇒ the calm empty state", () => {
  assert.equal(deriveEmptyState(clean, false), "empty");
  assert.equal(sessionCopy(clean, false).headline, "Nothing is processing right now.");
});

test("Finished ≠ Empty: work that ran and completed says SO", () => {
  assert.equal(deriveEmptyState(clean, true), "finished");
  const copy = sessionCopy(clean, true, "1,440 files finished (Describe).");
  assert.equal(copy.state, "finished");
  assert.match(copy.headline, /1,440 files finished/);
});

test("Interrupted: an abnormal previous end ⇒ never Empty", () => {
  const s: SessionView = { ...clean, previousEnded: "abnormal", previousEndedAt: "2026-07-15T22:13:00.000Z" };
  assert.equal(deriveEmptyState(s, false), "interrupted");
  const copy = sessionCopy(s, false);
  assert.match(copy.headline, /stopped unexpectedly at/);
  assert.match(copy.headline, /No unfinished jobs were pending/, "zero restored is still a fact (§4.2)");
});

test("Interrupted: UNKNOWN must render Interrupted, never Empty — the LOCKED rule", () => {
  // The single most important assertion in this file. `unknown` means the BOOT marker rotated away, so we
  // CANNOT assert innocence. Flipping this to "empty" would restore the exact confident lie D2 kills.
  const s: SessionView = { ...clean, previousEnded: "unknown" };
  assert.equal(deriveEmptyState(s, false), "interrupted");
  assert.match(sessionCopy(s, false).headline, /can't confirm how the previous session ended/);
});

test("Interrupted: a missing session block is also unknown ⇒ Interrupted", () => {
  // Before boot records it, or if the backend is older than the field. Absence of evidence must not read
  // as evidence of absence.
  assert.equal(deriveEmptyState(null, false), "interrupted");
});

test("the restore banner reports restored, already-done, and quarantined counts (§4.2)", () => {
  const s: SessionView = {
    ...clean,
    previousEnded: "abnormal",
    previousEndedAt: "2026-07-15T22:13:00.000Z",
    restored: 1291,
    restoreSkipped: 146,
    quarantined: 3,
  };
  const copy = sessionCopy(s, false);
  assert.equal(copy.state, "interrupted");
  assert.match(copy.headline, /1,291 jobs were restored and are running now/);
  assert.match(copy.headline, /146 had already finished/);
  assert.match(copy.headline, /3 were not retried because they crashed the app twice/);
  assert.match(copy.sub ?? "", /don't need to re-run/);
});

test("Interrupted wins even when this session has since finished work", () => {
  // A crash the user has not yet been told about outranks a later success. Otherwise the notice would
  // vanish the moment anything else completed — while they were still asleep.
  const s: SessionView = { ...clean, previousEnded: "abnormal", restored: 10 };
  assert.equal(deriveEmptyState(s, true), "interrupted");
});

test("a clean end that nonetheless restored work still reads Interrupted", () => {
  // Belt and braces: if anything was restored, something was left unfinished — say so regardless of how
  // the markers read.
  assert.equal(deriveEmptyState({ ...clean, restored: 5 }, false), "interrupted");
});

test("quarantine alone is surfaced, with the retry guidance", () => {
  const s: SessionView = { ...clean, previousEnded: "abnormal", previousEndedAt: "2026-07-15T22:13:00.000Z", quarantined: 1 };
  const copy = sessionCopy(s, false);
  assert.match(copy.headline, /1 job was not retried because it crashed the app twice/);
  assert.match(copy.sub ?? "", /listed below as failed/);
});

test("singular/plural read like English, not like a template", () => {
  const one = sessionCopy({ ...clean, previousEnded: "abnormal", restored: 1 }, false);
  assert.match(one.headline, /1 job was restored and is running now/);
  const many = sessionCopy({ ...clean, previousEnded: "abnormal", restored: 2 }, false);
  assert.match(many.headline, /2 jobs were restored and are running now/);
});

test("an unparseable previousEndedAt degrades to the timeless sentence, never 'Invalid Date'", () => {
  const s: SessionView = { ...clean, previousEnded: "abnormal", previousEndedAt: "not-a-date" };
  const copy = sessionCopy(s, false);
  assert.ok(!copy.headline.includes("Invalid Date"), "never show the user a JS artifact");
  assert.match(copy.headline, /Large File Bridge stopped unexpectedly\./);
});

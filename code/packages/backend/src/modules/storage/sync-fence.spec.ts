// THE SYNC FENCE (database.mdx §2). Four documents used to travel between the user's computers as plain
// last-writer-wins copies, because `LOCAL_ONLY` and `MERGED_NEVER_COPIED` are applied by `copyTreeGen` ONLY
// at `rel === ""` and none of the four was named in either set. All four sit at the tracking ROOT, so they
// were in scope of the gate the whole time — they were simply missing from it.
//
// These tests are written so that removing any of the four names, or weakening the policy conflict rule back
// to "whoever wrote last wins", fails loudly.
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { DecisionPolicyDocSchema, type DecisionPolicyDoc } from "@lfb/shared";
import { LOCAL_ONLY_FOR_TEST, MERGED_NEVER_COPIED_FOR_TEST, pickPolicy } from "./tracking-sync.service.js";

const policy = (over: Partial<DecisionPolicyDoc> = {}): DecisionPolicyDoc =>
  DecisionPolicyDocSchema.parse({ ...over });

describe("the four documents that used to escape (database.mdx §2.1)", () => {
  it("holds MACHINE-LOCAL content out of the mirror entirely", () => {
    // files.yaml is derived from THIS computer's disk. Two computers holding different subsets would
    // overwrite each other on every cycle — the exact ping-pong the repo_storage.yaml `counts:` scrub exists
    // to stop. It must never travel.
    expect(LOCAL_ONLY_FOR_TEST.has("files.yaml")).toBe(true);
  });

  it("holds BOTH failed-merge quarantines out of the mirror", () => {
    // A quarantine's entire value is being the local evidence of a LOCAL failure. A peer's copy landing on
    // top of ours destroys the only thing it is for.
    expect(LOCAL_ONLY_FOR_TEST.has("decisions.conflicted.yaml")).toBe(true);
    expect(LOCAL_ONLY_FOR_TEST.has("manifest.conflicted.yaml")).toBe(true);
  });

  it("keeps the pre-existing two, so the fix is additive", () => {
    expect(LOCAL_ONLY_FOR_TEST.has(".sync-repo")).toBe(true);
    expect(LOCAL_ONLY_FOR_TEST.has(".durable-artifact")).toBe(true);
  });

  it("merges SHARED user intent instead of copying it", () => {
    // decisions_policy.yaml is the one of the four that must NOT be held back: it is shared intent and has
    // to reach the other computers. It travels by FOLD, so it is in the merged set, never plain-copied.
    expect(MERGED_NEVER_COPIED_FOR_TEST.has("decisions_policy.yaml")).toBe(true);
    expect(LOCAL_ONLY_FOR_TEST.has("decisions_policy.yaml")).toBe(false);
  });
});

describe("pickPolicy — the conflict rule is a TOTAL ORDER (database.mdx §2.1)", () => {
  it("prefers a real choice over the schema default", () => {
    // A policy with no `set_at` was never chosen by anyone; it is what the schema hands back when the file is
    // missing. It must never beat a deliberate decision, in either argument position.
    const chosen = policy({ set_at: "2026-08-01T00:00:00.000Z", set_by: "bryan" });
    const untouched = policy();
    expect(pickPolicy(untouched, chosen)).toBe(chosen);
    expect(pickPolicy(chosen, untouched)).toBe(chosen);
  });

  it("takes the newer set_at, whichever side it arrives on", () => {
    const older = policy({ set_at: "2026-08-01T00:00:00.000Z", set_by: "bryan" });
    const newer = policy({ set_at: "2026-08-20T00:00:00.000Z", set_by: "bryan" });
    expect(pickPolicy(older, newer)).toBe(newer);
    expect(pickPolicy(newer, older)).toBe(newer);
  });

  it("is SYMMETRIC — both computers land on the same document", () => {
    // This is the property that makes the fold converge. If it were false, each machine would keep choosing
    // its own copy and the pair would rewrite (and re-commit) each other forever.
    const a = policy({ set_at: "2026-08-10T00:00:00.000Z", set_by: "laptop" });
    const b = policy({ set_at: "2026-08-11T00:00:00.000Z", set_by: "tower" });
    expect(pickPolicy(a, b)).toEqual(pickPolicy(b, a));
  });

  it("breaks a set_at tie deterministically on set_by, not on arrival order", () => {
    // Two computers can genuinely stamp the same millisecond. Falling back to "whoever mirrored last" here
    // would reintroduce exactly the bug this fold replaced.
    const at = "2026-08-15T12:00:00.000Z";
    const alice = policy({ set_at: at, set_by: "alice" });
    const bob = policy({ set_at: at, set_by: "bob" });
    expect(pickPolicy(alice, bob)).toBe(bob);
    expect(pickPolicy(bob, alice)).toBe(bob);
  });

  it("prefers an attributed policy over an anonymous one at the same instant", () => {
    const at = "2026-08-15T12:00:00.000Z";
    const named = policy({ set_at: at, set_by: "bryan" });
    const anon = policy({ set_at: at, set_by: null });
    expect(pickPolicy(anon, named)).toBe(named);
    expect(pickPolicy(named, anon)).toBe(named);
  });

  it("keeps the local document when the two are identical, so nothing is rewritten", () => {
    // A settled fleet must produce ZERO writes. tracking-sync.service.ts:225-234 records that 58 of the last
    // 60 device commits were a lone `updated_at` line — a merge that returns a fresh-but-equal object here
    // is how that happens.
    const mine = policy({ set_at: "2026-08-15T12:00:00.000Z", set_by: "bryan" });
    const theirs = policy({ set_at: "2026-08-15T12:00:00.000Z", set_by: "bryan" });
    expect(pickPolicy(mine, theirs)).toBe(mine);
  });

  it("survives both sides being absent", () => {
    expect(pickPolicy(null, null)).toBeNull();
  });

  it("lets a real policy win over an unparseable one (parsed as absent)", () => {
    const real = policy({ set_at: "2026-08-15T12:00:00.000Z", set_by: "bryan" });
    expect(pickPolicy(null, real)).toBe(real);
    expect(pickPolicy(real, null)).toBe(real);
  });

  it("round-trips through YAML the way the mirror actually writes it", () => {
    // The fold serializes with sortMapEntries, and the next pass parses that back. If the round trip did not
    // preserve the ranking fields, the pass after a write would pick a different winner than the write did.
    const chosen = policy({ set_at: "2026-08-20T00:00:00.000Z", set_by: "tower", attribution: "handle" });
    const reparsed = DecisionPolicyDocSchema.parse(YAML.parse(YAML.stringify(chosen, { sortMapEntries: true })));
    expect(pickPolicy(reparsed, chosen)).toEqual(chosen);
    expect(reparsed.set_at).toBe(chosen.set_at);
    expect(reparsed.set_by).toBe(chosen.set_by);
  });
});

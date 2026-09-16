// The repair for a YAML document a LINE UNION tore apart (union-damage.ts).
//
// This is a DATA-LOSS guard, not a tidiness one. The live case it was written from: a 3.4 MB
// `decisions.yaml` in the company sync repo, unparseable because ONE item's `- ` leader had been dissolved
// by `merge=union`. The cost of not repairing it was not a warning — it was 12,511 decision events read as
// `[]`, that repo's decisions no longer travelling between the user's computers, and the mirror re-paying
// its full cost on the event loop every pass forever because a refusal is deliberately not memoized.
//
// Two properties, and the second matters as much as the first:
//   1. A damaged document parses again, with every entry present.
//   2. Nothing is INVENTED or DROPPED. The repair only restores `- ` leaders, so the content of a repaired
//      document is the content of the damaged one, character for character.
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { repairUnionDamagedYaml, parseYamlHealingUnionDamage } from "./union-damage.js";

/** The exact shape `merge=union` leaves behind: two items fused because the second lost its `- `. */
const FUSED = `schema_version: 1
events:
  - sid: r:aaa
    path: videos/one.mp4
    asked: true
    decided_at: 2026-09-10T22:22:26.941Z
    path: videos/two.mp4
    asked: true
    decided_at: 2026-09-10T22:21:40.888Z
`;

describe("repairUnionDamagedYaml", () => {
  it("restores the dissolved item leader so the document parses, with both entries intact", () => {
    expect(() => YAML.parse(FUSED)).toThrow(); // the premise: this is what the live file did

    const repaired = repairUnionDamagedYaml(FUSED);
    expect(repaired).not.toBeNull();
    const doc = YAML.parse(repaired!) as { events: Array<Record<string, unknown>> };
    expect(doc.events).toHaveLength(2);
    expect(doc.events[0]!.path).toBe("videos/one.mp4");
    expect(doc.events[1]!.path).toBe("videos/two.mp4");
    // The second item keeps its own fields and inherits nothing it did not have.
    expect(doc.events[1]!.decided_at).toBe("2026-09-10T22:21:40.888Z");
    expect(doc.events[1]!.sid).toBeUndefined();
  });

  it("changes nothing but leaders — no content is invented or lost", () => {
    const repaired = repairUnionDamagedYaml(FUSED)!;
    const strip = (s: string): string => s.replace(/^(\s*)- /gm, "$1").replace(/\s+/g, "");
    expect(strip(repaired)).toBe(strip(FUSED));
  });

  it("leaves a healthy document alone (returns null rather than rewriting it)", () => {
    const fine = `schema_version: 1
events:
  - sid: r:aaa
    path: videos/one.mp4
  - sid: r:bbb
    path: videos/two.mp4
`;
    expect(repairUnionDamagedYaml(fine)).toBeNull();
  });

  it("does not mistake a NESTED block's keys for the item's own", () => {
    // `size` appears twice, but at different depths: once inside `hashes.uncompressed` and once inside
    // `hashes.compressed`. A repair that compared keys without regard to indent would split this item in
    // three and lose the nesting.
    const nested = `files:
  - path: movie.mp4
    hashes:
      uncompressed:
        hash: aaa
        size: 10
      compressed:
        hash: bbb
        size: 5
`;
    expect(repairUnionDamagedYaml(nested)).toBeNull();
    expect(() => YAML.parse(nested)).not.toThrow();
  });

  it("does not mistake a folded multi-line scalar for a key", () => {
    // A real path from the live file: long enough that the serializer folded it onto a second line. That
    // continuation is indented DEEPER than the key, which is what keeps it out of the key comparison.
    const folded = `events:
  - sid: r:aaa
    path: videos/X_Shooter/Project Constitution - BREAKING CHARLIE KIRK SHOOTER
      IDENTIFIED MORE COMING SOON [1976506741958352896].mp4
    asked: true
`;
    expect(repairUnionDamagedYaml(folded)).toBeNull();
  });

  it("repairs several fusions in one document", () => {
    const many = `events:
  - path: a
    at: 1
    path: b
    at: 2
    path: c
    at: 3
`;
    const doc = YAML.parse(repairUnionDamagedYaml(many)!) as { events: Array<Record<string, unknown>> };
    expect(doc.events.map((e) => e.path)).toEqual(["a", "b", "c"]);
  });
});

describe("parseYamlHealingUnionDamage", () => {
  it("reports whether a repair was needed, so a caller knows the bytes on disk are stale", () => {
    const clean = parseYamlHealingUnionDamage("a: 1\n");
    expect(clean.doc).toEqual({ a: 1 });
    expect(clean.repaired).toBeNull(); // already fine — writing back would be a pointless churn

    const healed = parseYamlHealingUnionDamage(FUSED);
    expect(healed.doc).not.toBeNull();
    expect(healed.repaired).not.toBeNull(); // healed — the caller may write its own serialization back
  });

  it("gives up (rather than guessing) on text that is not this damage", () => {
    const garbage = parseYamlHealingUnionDamage("this: [is: not: yaml\n\t\tat all");
    expect(garbage.doc).toBeNull();
    expect(garbage.repaired).toBeNull();
  });
});

// THE FOUR RULES OF SLICE 7 THAT ARE SILENT WHEN THEY ARE WRONG (database.mdx §4.1, migration 0007).
//
// Postgres is not mocked and not reached here. Everything under test is a pure function, on purpose: each
// one has a WRONG version that raises no error, writes no warning, and is only discovered later as "this
// computer's pins are attributed to a machine that is not it", "a claim we withdrew came back", or "a repo
// the user opted out of started publishing its manifest". The SQL half — the sweep, the ratchet and the
// `lfb_pin_claim_guard` rejection — is exercised for real against a scratch database by `just db-backfill`
// and the live probes recorded in this slice's verification, the same split `backfill.spec.ts` uses.
import { describe, it, expect } from "vitest";
import {
  claimOriginFor,
  dedupeEntries,
  manifestToEntries,
  toRelPosix,
  type DeviceIndex,
} from "./manifest.repo.js";
import { aliasRowsFrom, stagesToRun } from "./manifest-backfill.js";

const index: DeviceIndex = {
  byLabel: new Map([
    ["bryanstarbuck-macbook-pro", 3],
    ["pc-10-pc10-mint", 7],
    // A computer whose declared name carries a space — the case the sanitizer creates a second spelling for.
    ["xmod2 sjoshi", 9],
  ]),
  byFolderKey: new Map([
    ["bryanstarbuck-macbook-pro", 3],
    ["pc-10-pc10-mint", 7],
    ["xmod2_sjoshi", 9],
  ]),
  selfDeviceId: 3,
  selfLabel: "bryanstarbuck-macbook-pro",
};

describe("the merge asymmetry, as a value — a claim about THIS computer is never 'wire'", () => {
  // `manifest-merge.ts:123-128` strips our own claim from every arriving entry and passes every peer's
  // through unchanged. Getting this backwards does not fail: it writes a row `lfb_pin_claim_guard` then
  // refuses, which aborts the whole repo's transaction — or, worse, if the guard were ever dropped, it
  // quietly records a PEER's word as proof that the bytes are pinned here (ipfs.mdx §1.1).
  it("classifies our own label as 'local'", () => {
    expect(claimOriginFor("bryanstarbuck-macbook-pro", "bryanstarbuck-macbook-pro", 3, 3)).toBe("local");
  });

  it("classifies every peer as 'wire'", () => {
    expect(claimOriginFor("pc-10-pc10-mint", "bryanstarbuck-macbook-pro", 7, 3)).toBe("wire");
  });

  it("still says 'local' when the claim names the is_self device under a spelling we did not expect", () => {
    // This clause is what keeps the writer and the guard in agreement. The guard's predicate is
    // `device.is_self`, not the label — so a claim resolving to the self device MUST be written 'local' or
    // the database is entitled to refuse the row and take 4,184 entries down with it.
    expect(claimOriginFor("some-old-spelling", "bryanstarbuck-macbook-pro", 3, 3)).toBe("local");
  });

  it("recognises the sanitized spelling of this computer as this computer", () => {
    // `history/<device>.txt` filenames are repoFolderKey-sanitized while `pinned_by` labels are not, and
    // the sanitizer folds anything outside [a-z0-9._-] to `_` — so a computer declared as `xmod2 sjoshi`
    // appears as `xmod2_sjoshi` on that side. With no `is_self` row to lean on (a machine whose backfill
    // has not run) the label comparison is the ONLY thing standing between us and filing our own pins as a
    // peer's.
    expect(claimOriginFor("xmod2_sjoshi", "xmod2 sjoshi", 9, null)).toBe("local");
  });

  it("claims nothing as ours when we do not know who we are", () => {
    // No `is_self` row and no label: 'wire' is the only honest answer, and it is also the SAFE one — the
    // guard cannot fire, and nothing gets recorded as pinned-here on this computer's behalf.
    expect(claimOriginFor("pc-10-pc10-mint", "", 7, null)).toBe("wire");
  });
});

describe("rel_posix — the TypeScript twin of a GENERATED column", () => {
  it("mirrors `replace(rel_path, '\\', '/')` exactly", () => {
    // The sweep predicates name rows by `rel_posix`. If this drifted from 0007's expression, a write would
    // insert a row and then immediately delete it as "not in the keep set".
    expect(toRelPosix("a\\b\\c.mp4")).toBe("a/b/c.mp4");
    expect(toRelPosix("a/b/c.mp4")).toBe("a/b/c.mp4");
  });

  it("collapses the two spellings of one path onto ONE row, unioning their claims", () => {
    // The PK is (unit_id, stage, rel_posix), so `a\b.mp4` and `a/b.mp4` ARE one row. A multi-row
    // `INSERT … ON CONFLICT DO UPDATE` carrying both dies with "cannot affect row a second time" and takes
    // the whole repo's manifest with it. `normalizeManifestPaths` heals the documents on this machine, which
    // is exactly why the case has to be handled rather than assumed away.
    const rows = dedupeEntries([
      { relPath: "a\\b.mp4", cidText: "bafk1", cidCanon: "bafk1", sizeBytes: 1, sha256: null, modifiedAt: null,
        claims: [{ deviceId: 7, origin: "wire", cidCanon: "bafk1" }] },
      { relPath: "a/b.mp4", cidText: "bafk1", cidCanon: "bafk1", sizeBytes: 2, sha256: null, modifiedAt: null,
        claims: [{ deviceId: 3, origin: "local", cidCanon: "bafk1" }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].relPosix).toBe("a/b.mp4");
    expect(rows[0].sizeBytes).toBe(2); // later wins, matching foldManifestFiles' last-wins fold
    expect(new Set(rows[0].claims.map((c) => c.deviceId))).toEqual(new Set([3, 7]));
  });

  it("never demotes a 'local' claim to 'wire' while folding a duplicate", () => {
    // The in-memory fold has to apply the SAME ratchet the SQL upsert does, or the two would disagree about
    // one document depending on which spelling of a path happened to come last.
    const rows = dedupeEntries([
      { relPath: "a/b.mp4", cidText: null, cidCanon: null, sizeBytes: 0, sha256: null, modifiedAt: null,
        claims: [{ deviceId: 3, origin: "local", cidCanon: null }] },
      { relPath: "a\\b.mp4", cidText: null, cidCanon: null, sizeBytes: 0, sha256: null, modifiedAt: null,
        claims: [{ deviceId: 3, origin: "wire", cidCanon: null }] },
    ]);
    expect(rows[0].claims).toEqual([{ deviceId: 3, origin: "local", cidCanon: null }]);
  });
});

describe("manifestToEntries — cid_text verbatim, cid_canon computed in TypeScript (R7)", () => {
  const manifest = {
    schema_version: 1,
    unit: "repo" as const,
    files: [
      {
        path: "movies/a.mp4",
        // A CIDv0 spelling. `canonicalCid` re-encodes it as its CIDv1 base32 twin; the VERBATIM value is
        // what the fleet recorded and must survive untouched (cid-equivalence.service.ts).
        cid: "QmSomeLegacyCid",
        size: 10,
        sha256: null,
        pinned_by: ["bryanstarbuck-macbook-pro", "pc-10-pc10-mint", "a-computer-we-have-never-met"],
      },
    ],
  };

  it("keeps cid_text verbatim and canonicalises only cid_canon", () => {
    const entries = manifestToEntries(manifest, {
      canonicalCid: (c) => (c.startsWith("Qm") ? `bafy-of-${c}` : c),
      selfLabel: "bryanstarbuck-macbook-pro",
      index,
    });
    expect(entries[0].cidText).toBe("QmSomeLegacyCid");
    expect(entries[0].cidCanon).toBe("bafy-of-QmSomeLegacyCid");
  });

  it("explodes pinned_by with the right origin per device", () => {
    const entries = manifestToEntries(manifest, {
      canonicalCid: (c) => c,
      selfLabel: "bryanstarbuck-macbook-pro",
      index,
    });
    expect(entries[0].claims).toEqual([
      { deviceId: 3, origin: "local", cidCanon: "QmSomeLegacyCid" },
      { deviceId: 7, origin: "wire", cidCanon: "QmSomeLegacyCid" },
    ]);
  });

  it("REPORTS a label with no device row instead of dropping it silently", () => {
    // `device_id` is a NOT NULL FK, so an unknown label cannot become a row. What it must not do is vanish:
    // the backfill turns this callback into a reject record naming the label, which is how a fleet member
    // area 1 never saw becomes visible rather than becoming a quietly missing pin claim.
    const seen: string[] = [];
    manifestToEntries(manifest, {
      canonicalCid: (c) => c,
      selfLabel: "bryanstarbuck-macbook-pro",
      index,
      onUnknownLabel: (l) => seen.push(l),
    });
    expect(seen).toEqual(["a-computer-we-have-never-met"]);
  });
});

describe("stagesToRun — resume is per (unit, stage), and 'unit' comes first", () => {
  it("runs both stages from cold", () => {
    expect(stagesToRun("r/charlie-kirk", null)).toEqual(["unit", "tracking"]);
  });

  it("resumes at 'tracking' after an interrupted run finished the unit stage", () => {
    expect(stagesToRun("r/charlie-kirk", "r/charlie-kirk:unit")).toEqual(["tracking"]);
  });

  it("runs nothing when both stages were already written", () => {
    expect(stagesToRun("r/charlie-kirk", "r/charlie-kirk:tracking")).toEqual([]);
  });

  it("ignores a cursor belonging to a DIFFERENT scope", () => {
    // The harness hands the scope its own cursor, but a hand-edited `migration_state.yaml` could carry
    // anything. Re-doing a scope from zero is idempotent; skipping one that was never written is not.
    expect(stagesToRun("r/charlie-kirk", "r/all:tracking")).toEqual(["unit", "tracking"]);
  });
});

describe("cid aliases — the two local maps are not the same claim", () => {
  const reject = (): void => {};

  it("tags each map with the proof standard its writer actually holds itself to", () => {
    // `cid_equivalence.yaml` pairs come from re-hashing the bytes and finding the local pin;
    // `superseded_cids.yaml` pairs are only written from a walk that ACTUALLY RESOLVED. Recording both as
    // one kind would let an equivalence — two valid spellings of one file — suppress a CID the way a proven
    // wrapper-directory correction does, which is the ping-pong `superseded-cids.service.ts` ended.
    const eq = aliasRowsFrom({ bafkA: "bafkB" }, "equivalent", "rehash", reject);
    expect(eq).toEqual([{ aliasCanon: "bafkA", targetCanon: "bafkB", kind: "equivalent", proof: "rehash" }]);
    const sup = aliasRowsFrom({ bafkC: "bafkD" }, "superseded", "resolveFileCid", reject);
    expect(sup[0]).toMatchObject({ kind: "superseded", proof: "resolveFileCid" });
  });

  it("records a self-pair rather than handing `cid_alias_not_self` a row it must refuse", () => {
    // The CHECK would abort the statement and take all 74 pairs with it. Both YAML writers already skip
    // `key === val`, so a self-pair on disk means a hand edit or a file older than that check.
    const seen: string[] = [];
    const rows = aliasRowsFrom({ bafkA: "bafkA" }, "equivalent", "rehash", (k) => seen.push(k));
    expect(rows).toEqual([]);
    expect(seen).toEqual(["bafkA"]);
  });

  it("records a pair with a blank half instead of writing a NOT NULL violation", () => {
    const seen: string[] = [];
    const rows = aliasRowsFrom({ bafkA: "" }, "superseded", "resolveFileCid", (k) => seen.push(k));
    expect(rows).toEqual([]);
    expect(seen).toEqual(["bafkA"]);
  });
});

// THE `lfb` GIT MERGE DRIVER — how git merges the shared documents on a computer running build ≥ 7
// (backward_compatibility.md §4.1).
//
// WHY GIT NEEDS ONE. The sync repo's `.gitattributes` has long said `decisions.yaml merge=union` (and the
// same for manifest.yaml and the per-file sidecars). A line union is right for a FLAT log and wrong for a
// nested YAML sequence: an item whose `- ` leader lands on the far side of git's seam is absorbed into the
// item above it, and the document stops parsing (performance.mdx P-52). Every reader heals that on read,
// but healing is repair after damage, on every read, on every computer. This driver merges the DOCUMENT
// instead of its lines, so a build-7 computer never produces the damage at all.
//
// HOW IT COEXISTS WITH OLDER BUILDS (the part that makes it safe to ship to a mixed fleet). Git applies the
// LAST `.gitattributes` line that matches a path. Older builds keep their `X merge=union` lines present (they
// re-add them if missing, which would flap the file), so we never remove them: build 7 appends
// `X merge=lfb` AFTER them. On a computer that has registered the driver, git runs this. On an older computer
// the name `lfb` is not registered, and git falls back to its ordinary text merge — a CONFLICT, which that
// build's own resolver already settles with its "union" rule, i.e. exactly what it did before. Nothing an
// older computer does changes; a newer one simply stops creating damage.
//
// CONTRACT WITH GIT: invoked as `<node> <loader> git-merge-driver.ts %O %A %B %P` — base, ours, theirs (temp
// files) and the path in the tree. The merged result is written to %A; exit 0 = merged cleanly.
//
// IT NEVER MAKES A MERGE WORSE THAN THE OLD ATTRIBUTE. Any document it cannot merge semantically (unparseable
// side, unknown shape, a bug here) falls back to git's own line union followed by the union-damage repair —
// the old behaviour, minus the damage. It exits non-zero only if even that fails, which hands the path to
// the backbone's conflict resolver exactly as a text conflict would.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { ManifestSchema, type Manifest } from "@lfb/shared";
import { parseLedgerDetailed, unionLedgerEvents, serializeLedger } from "../modules/storage/ledger-merge.js";
import { parseDeletionsText, mergeDeletions, serializeDeletions } from "../modules/pin/deletions-merge.js";
import { mergeManifests, serializeManifest, foldManifestFiles } from "../modules/storage/manifest-merge.js";
import { repairUnionDamagedYaml, parseYamlHealingUnionDamage } from "../modules/storage/union-damage.js";

type Merger = (base: string, ours: string, theirs: string) => string;

const hasMarkers = (t: string): boolean => /^(<{7}|={7}|>{7})(\s|$)/m.test(t);

/** Decision ledger: an event log — union by event identity, compacted, one canonical spelling. */
const mergeLedger: Merger = (_base, ours, theirs) => {
  const a = parseLedgerDetailed(ours);
  const b = parseLedgerDetailed(theirs);
  // A side that could not be read at all contributes nothing and must not be "merged" as empty — that would
  // publish a ledger missing every event it held. Only unreadable-and-nonblank is refused.
  if ((a.events.length === 0 && ours.trim() && a.damaged) || (b.events.length === 0 && theirs.trim() && b.damaged)) {
    throw new Error("a side of the decision ledger could not be read");
  }
  return serializeLedger(unionLedgerEvents(a.events, b.events));
};

/** Fleet deletion ledger: the grow-only merge `mergeDeletions` already defines (deletion.mdx §6). */
const mergeDeletionDocs: Merger = (_base, ours, theirs) =>
  serializeDeletions(mergeDeletions(parseDeletionsText(ours), parseDeletionsText(theirs)));

function parseManifest(text: string): Manifest {
  if (!text.trim()) return ManifestSchema.parse({});
  if (hasMarkers(text)) throw new Error("manifest has conflict markers");
  const { doc } = parseYamlHealingUnionDamage(text);
  if (doc === null) throw new Error("manifest is unreadable");
  return ManifestSchema.parse(doc ?? {});
}

/**
 * Manifest: per-entry merge, with a THREE-WAY merge of `pinned_by`. The claim list is the one field where the
 * base matters: a computer that stopped holding a file REMOVES its own label, and a two-way union would hand
 * the label straight back from the other side (the grow-only trap manifest-merge.ts describes). Against the
 * base, a label is kept when both sides have it or when either side ADDED it — so a withdrawal on one side
 * survives, and an addition on either side survives. Symmetric, so both computers reach the same result.
 */
const mergeManifestDocs: Merger = (base, ours, theirs) => {
  const o = parseManifest(ours);
  const t = parseManifest(theirs);
  let b: Manifest;
  try {
    b = parseManifest(base);
  } catch {
    b = ManifestSchema.parse({});
  }
  const merged = mergeManifests(o, t, null, {});
  const claims = (m: Manifest): Map<string, Set<string>> =>
    new Map(foldManifestFiles(m.files, m.unit).map((f) => [f.path, new Set(f.pinned_by ?? [])]));
  const [bc, oc, tc] = [claims(b), claims(o), claims(t)];
  merged.files = merged.files.map((f) => {
    const B = bc.get(f.path) ?? new Set<string>();
    const O = oc.get(f.path) ?? new Set<string>();
    const T = tc.get(f.path) ?? new Set<string>();
    const keep = new Set<string>();
    for (const c of O) if (T.has(c) || !B.has(c)) keep.add(c);
    for (const c of T) if (O.has(c) || !B.has(c)) keep.add(c);
    return { ...f, pinned_by: [...keep] };
  });
  return serializeManifest(merged);
};

/** The documents this driver merges semantically, by file name. Everything else gets the repaired union. */
const SEMANTIC: Record<string, Merger> = {
  "decisions.yaml": mergeLedger,
  "deletions.yaml": mergeDeletionDocs,
  "manifest.yaml": mergeManifestDocs,
};

/** git's own line union (`merge-file --union`), then — for YAML — the union-damage repair. */
function repairedUnion(basePath: string, oursPath: string, theirsPath: string, rel: string): string {
  let out: string;
  try {
    out = execFileSync("git", ["merge-file", "-p", "--union", oursPath, basePath, theirsPath], { encoding: "utf8", maxBuffer: 1 << 30 });
  } catch (e) {
    // merge-file exits with the number of conflicts; with --union there are none, but be tolerant.
    const stdout = (e as { stdout?: string }).stdout;
    if (typeof stdout !== "string") throw e;
    out = stdout;
  }
  return /\.ya?ml$/i.test(rel) ? (repairUnionDamagedYaml(out) ?? out) : out;
}

function main(): number {
  const [basePath, oursPath, theirsPath, rel = ""] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write("usage: git-merge-driver %O %A %B %P\n");
    return 2;
  }
  const read = (p: string): string => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const merger = SEMANTIC[path.posix.basename(rel.replace(/\\/g, "/"))];
  if (merger) {
    try {
      const merged = merger(read(basePath), read(oursPath), read(theirsPath));
      // Belt and braces: whatever we write must parse. A merger bug must never commit an unreadable file.
      YAML.parse(merged);
      fs.writeFileSync(oursPath, merged);
      return 0;
    } catch (e) {
      process.stderr.write(`lfb merge driver: ${rel}: semantic merge failed (${(e as Error).message}) — using the repaired union\n`);
    }
  }
  try {
    fs.writeFileSync(oursPath, repairedUnion(basePath, oursPath, theirsPath, rel));
    return 0;
  } catch (e) {
    process.stderr.write(`lfb merge driver: ${rel}: ${(e as Error).message} — leaving it to the conflict resolver\n`);
    return 1;
  }
}

process.exit(main());

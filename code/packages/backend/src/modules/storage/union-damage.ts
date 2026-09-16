// union-damage.ts — REPAIR a shared YAML document that a LINE-BASED union merge tore apart.
//
// THE DEFECT THIS CLOSES, and it is not hypothetical: on 2026-09-11 the reference machine's
// `act3_large_files_bridge/repos/charlie-kirk-83e62afc2c80/decisions.yaml` (3.4 MB, 100,588 lines) had been
// unparseable since the previous afternoon —
//
//     Map keys must be unique at line 100581, column 5:
//         path: videos/video/https%3A%2F%2Fx.com%2F…mp4
//
// — and every consequence of that was a product failure, not a cosmetic one:
//
//   • `mirrorToSyncRepo` REFUSES to write over a mirror document it could not read (rightly — see
//     `refuseUnparseableMirror`). So that repo's decisions stopped travelling to the user's other
//     computers altogether, which is the entire promise of this product, and nothing said so in the UI.
//   • The refusal calls `forgetPair`, deliberately, so the next pass re-tries it. With a file that can
//     never parse, "re-try every pass" means re-reading and re-merging all 3,649 of that repo's sidecars
//     forever — on the event loop. It is the single largest contributor to the `storage.mirror held the
//     event loop for …` WARNs (131 of them in one day) and therefore to the blank spinner in the browser.
//   • It repeated one ERROR line per pass into `error.err` for a whole day, which is how a fault trail
//     stops being read.
//
// WHERE THE DAMAGE COMES FROM. `.gitattributes` carries `decisions.yaml merge=union` (git.service.ts
// `UNION_MERGE_PATHS`), and LFB's own conflict fallback does the same thing by hand for `.yaml`
// (`unionConflictedText`). Both reason that these documents are append-only lists, so keeping every line
// from both sides is a safe superset and "the readers fold duplicate entries anyway". That is true of a
// FLAT log — one record per line, which is why `history/<device>.txt` union-merges correctly — and false of
// a NESTED block sequence. A union of two YAML sequences interleaves the two sides' lines, and an item
// whose `- ` leader ends up on the far side of the seam is absorbed into the item above it:
//
//     - sid: r:83e62afc2c80          # one item …
//       path: videos/X_Shooter/…mp4
//       decided_at: 2026-09-10T22:22:26.941Z
//       path: videos/video/…mp4      # … and the next item's fields, with its `- ` gone
//       decided_at: 2026-09-10T22:21:40.888Z
//
// The result is not a superset with duplicates. It is a file that no parser will accept, so the "readers
// fold duplicates" argument never gets to run.
//
// THE REPAIR is the inverse of that specific damage and nothing more: inside a block-sequence item, a key
// that has ALREADY been seen in this item cannot belong to it, so it starts a new item. That rule is
// exactly as strong as the corruption it undoes — it needs no schema, no knowledge of which document this
// is, and it cannot invent or drop a field, because every line is kept and only `- ` leaders are restored.
//
// CONTRACT: pure, allocation-bounded, never throws, and returns `null` when it changed nothing — so a
// caller can tell "healed" from "was already fine" from "beyond us".
import YAML from "yaml";

/** A mapping key line: indentation, then a plain key, then `:` followed by end-of-line or a space. */
const KEY_LINE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.\-/]*):(\s|$)/;

/** A block-sequence item's first line: indentation, `- `, then the item's first key (or scalar). */
const ITEM_LINE = /^(\s*)-\s+(\S.*)$/;

/**
 * Restore the `- ` item leaders a line union dissolved. Returns the repaired text, or `null` when the
 * input needed no repair.
 *
 * Scoped to keys at the item's OWN key indent, which is what keeps it safe around the two shapes that would
 * otherwise fool it: a nested block (deeper indent, so its keys are never compared against the item's) and
 * a folded multi-line scalar (a continuation line must be indented further than its key, by YAML's own
 * rules, so it can never match at the key indent).
 */
export function repairUnionDamagedYaml(raw: string): string | null {
  const lines = raw.split("\n");
  const out: string[] = [];
  let repairs = 0;
  // The item currently being read: the indent of its `- `, the indent its own keys sit at, and the keys
  // seen so far. `null` = not inside a sequence item.
  let item: { dashIndent: number; keyIndent: number; seen: Set<string> } | null = null;

  for (const line of lines) {
    const asItem = ITEM_LINE.exec(line);
    if (asItem) {
      const dashIndent = asItem[1]!.length;
      // A NEW item at this level, or the first item of a nested sequence. Either way the key set restarts.
      item = { dashIndent, keyIndent: dashIndent + 2, seen: new Set<string>() };
      const firstKey = KEY_LINE.exec(asItem[2]!);
      if (firstKey) item.seen.add(firstKey[2]!);
      out.push(line);
      continue;
    }
    if (!item) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= item.dashIndent) {
      // Dedented out of the sequence entirely (a sibling mapping key, a new document).
      item = null;
      out.push(line);
      continue;
    }
    const asKey = KEY_LINE.exec(line);
    if (!asKey || asKey[1]!.length !== item.keyIndent) {
      // A deeper nested line, or a scalar continuation — part of this item, not a key of it.
      out.push(line);
      continue;
    }
    const key = asKey[2]!;
    if (item.seen.has(key)) {
      // THE REPAIR. This key already belongs to the item, so this line opens the next one: put its `- `
      // back and keep every character after the indentation exactly as it was.
      out.push(`${" ".repeat(item.dashIndent)}- ${line.slice(item.keyIndent)}`);
      item = { dashIndent: item.dashIndent, keyIndent: item.keyIndent, seen: new Set([key]) };
      repairs += 1;
      continue;
    }
    item.seen.add(key);
    out.push(line);
  }
  if (repairs === 0) return null;
  return out.join("\n");
}

/**
 * Parse `raw` as YAML, repairing line-union damage first if that is what is wrong with it.
 *
 * Returns the parsed document and — the part callers care about — the REPAIRED TEXT when a repair was what
 * made the parse succeed. A caller holding repaired text knows two things: the document is usable, and the
 * bytes on disk are not the bytes it is holding, so writing its own serialization back is a heal rather
 * than a clobber.
 *
 * Never throws. `{ doc: null, repaired: null }` means the text is beyond this repair, which is the case
 * `refuseUnparseableMirror` still exists for.
 */
export function parseYamlHealingUnionDamage(raw: string): { doc: unknown; repaired: string | null } {
  try {
    return { doc: YAML.parse(raw), repaired: null };
  } catch {
    /* fall through to the repair */
  }
  const repaired = repairUnionDamagedYaml(raw);
  if (repaired === null) return { doc: null, repaired: null };
  try {
    return { doc: YAML.parse(repaired), repaired };
  } catch {
    return { doc: null, repaired: null };
  }
}

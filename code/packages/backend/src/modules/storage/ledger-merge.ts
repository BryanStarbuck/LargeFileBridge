// The decision-ledger UNION MERGE (decisions.mdx §5) — a LEAF module (types + pure functions only),
// shaped after manifest-merge.ts and for the same reason: the SHARED ledger travels between computers
// through the sync-repo mirror, and a wholesale file copy in EITHER direction is last-writer-wins — it
// silently deletes whichever side's events the copy source did not know about.
//
// THE DEFECT THIS CLOSES (2026-07-20, charlie-kirk, "not backed up: 22 here / 0 there"): the mirror's
// `decisions.yaml` was copied wholesale both ways (tracking-sync.service.ts `copyTree`), so two clones of
// the same repo — or the user's two computers — ping-ponged full replacements of each other's ledgers.
// Events that existed on one side and not the other were erased instead of unioned, the surviving frozen
// `decisions:` cache kept honoring them locally, and the OTHER computer could never learn the decision at
// all: the file stayed pinned on one machine forever and `not_backed_up` never drained.
//
// An event log unions by EVENT IDENTITY: an event present on either side survives, exact duplicates
// collapse, and `foldLedger` (latest decided_at per path) resolves any conflict deterministically on read.
import YAML from "yaml";
import { parseYamlHealingUnionDamage } from "./union-damage.js";
import { DecisionEventSchema, DecisionsLedgerSchema, type DecisionEvent } from "@lfb/shared";
import { healWindowsPath } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";

/** The full identity of one event — every recorded field. Two events are "the same" only when byte-equal
 *  on all of them; anything less risks collapsing a genuine tombstone/decide pair recorded in the same
 *  millisecond. The separator is NUL, written as its ESCAPE: the raw byte was in this file from the day
 *  it was created and made git treat the whole module as BINARY — no diff, no review, no blame. Same
 *  character, same identities, a text file again. */
function eventIdentity(e: DecisionEvent): string {
  return [e.sid, e.path, e.fingerprint ?? "", e.asked, e.ipfs, e.gitignore, e.decided_by ?? "", e.decided_at].join("\u0000");
}

/** Union two event logs by event identity — an event on either side survives, duplicates collapse. The
 *  result is sorted with EXACTLY the same comparator as decisions.service.ts `writeLedger`, so a merged
 *  ledger re-serializes deterministically (an unchanged log stays byte-identical). */
export function unionLedgerEvents(a: DecisionEvent[], b: DecisionEvent[]): DecisionEvent[] {
  const byId = new Map<string, DecisionEvent>();
  for (const e of [...a, ...b]) {
    const id = eventIdentity(e);
    const prior = byId.get(id);
    // The same event, twice — keep the copy that still carries its WRITER STAMP (backward_compatibility.md
    // §3). An older build strips fields it does not know when it re-serializes, so the mirror can hold a
    // stamp-less copy of an event this computer holds stamped. The stamp is not part of the identity (that
    // would split one event into two and grow the log on every round trip), so the choice has to be made
    // here, and it must be a TOTAL order so both computers keep the same copy whichever side arrives first.
    if (!prior || stampRank(e) > stampRank(prior)) byId.set(id, e);
  }
  return [...byId.values()].sort(
    (x, y) =>
      x.decided_at.localeCompare(y.decided_at) ||
      x.sid.localeCompare(y.sid) ||
      x.path.localeCompare(y.path) ||
      (x.decided_by ?? "").localeCompare(y.decided_by ?? ""),
  );
}

/** Order two copies of one event by their writer stamp: stamped beats unstamped, higher build beats lower,
 *  then the device name — a total order on the stamp alone, independent of arrival order. */
function stampRank(e: DecisionEvent): string {
  if (e.writer_build === undefined) return "";
  return `${String(e.writer_build).padStart(6, "0")}\u0000${e.writer_device ?? ""}`;
}

/**
 * The LATEST event per file — the fold rule every reader applies (decisions.mdx §5), in ONE place.
 *
 * `foldLedger` (decisions.service.ts) and the semantic write gate below must agree on this exactly: if they
 * ever differed, the gate could decide "nothing changed" about a ledger whose folded answer did change, and
 * a decision would silently stop travelling. So both call this. Keyed by the POSIX-healed path; the latest
 * `decided_at` wins; ties break by `decided_by` so every computer folds identically.
 */
export function latestEventPerPath(events: DecisionEvent[]): Map<string, DecisionEvent> {
  const latest = new Map<string, DecisionEvent>();
  for (const e of events) {
    const key = healWindowsPath(e.path);
    const prev = latest.get(key);
    if (
      !prev ||
      e.decided_at > prev.decided_at ||
      (e.decided_at === prev.decided_at && (e.decided_by ?? "") > (prev.decided_by ?? ""))
    ) {
      latest.set(key, e);
    }
  }
  return latest;
}

/**
 * THE MEANING of a ledger: what every reader will conclude from it, and nothing else.
 *
 * The semantic write gate (backward_compatibility.md §4.2) compares two ledgers by THIS, not by bytes. Two
 * ledgers with the same meaning differ only in things no reader consults — event order, compaction of
 * repeated statements, writer stamps an older build stripped, superseded history — and rewriting a SHARED
 * copy for any of those is how two builds end up rewriting each other's file forever: each pass produces a
 * byte difference, a commit, a merge, and the other build's pass puts its own spelling back.
 *
 * Includes `decided_by`/`decided_at` of the winning event, because those ARE read (the UI shows who decided
 * and when). A string, so equality is one comparison.
 */
export function ledgerMeaning(events: DecisionEvent[]): string {
  const rows: string[] = [];
  for (const [p, e] of latestEventPerPath(events)) {
    rows.push([p, e.asked, e.ipfs, e.gitignore, e.decided_by ?? "", e.decided_at].join("\u0000"));
  }
  rows.sort();
  return rows.join("\n");
}

/**
 * Collapse RE-STAMPS: an event stating the same DECISION as another for the same file, differing only in
 * when it was recorded and in metadata the fold never reads. A pure function of the SET, so it is
 * idempotent and converges under `merge=union` — both computers compute the same result from the same
 * union and the merge after it is a no-op.
 *
 * Append-only is the right shape for this log, but a writer that re-appends an unchanged decision every
 * pass turns it into unbounded growth carrying no new information, and a union-merged log has no other way
 * to lose a line. The Windows-separator mismatch fixed in `reconcile` did exactly that: measured on the live
 * company repo, 21,142 events for 2,059 distinct files — one of them re-stamped 1,585 times over two days —
 * a 5 MB, 172k-line document every computer parses on every decision. Stopping that writer could not shrink
 * what it had already written.
 *
 * What survives: every CHANGE of decision, plus the FIRST and LAST time each unchanged one was stated, so
 * both provenance and the fold's answer are untouched. Only identical middle re-stamps go — 35 of the 2,209
 * groups in that measurement had any. `foldLedger` reads the LATEST event per path and this never drops a
 * group's latest, so the folded decision is by construction the same before and after.
 */
export function compactLedger(events: DecisionEvent[]): DecisionEvent[] {
  const groups = new Map<string, DecisionEvent[]>();
  for (const e of events) {
    // The key is EXACTLY WHAT `foldLedger` READS, and nothing else — that is the whole rule. Two events
    // agreeing on every field the fold consults say the same thing about the same file, whatever else
    // differs, so collapsing them cannot change any answer this log can be asked for. Paths normalize the
    // way the fold normalizes them, so a Windows peer's `jfk\training\…` re-stamp collapses against this
    // computer's `jfk/training/…` instead of living beside it forever.
    //
    // `sid` and `fingerprint` are therefore ABSENT, and their absence is the point: the fold reads NEITHER
    // (it keys on path alone and returns no fingerprint), yet keying on them is what let the noise survive
    // the fix meant to remove it. The live company ledger carries THREE sids for one storage — the raw
    // remote-URL hash since corrected in `decisionSid` — so events identical in every way the fold reads
    // sat in different groups and no amount of compaction could bring them together. `fingerprint` is the
    // same trap not yet sprung: it moves whenever a file's CONTENT changes, so one decision re-stated
    // across an edit would open a fresh group every time and grow without bound again.
    const key = [
      healWindowsPath(e.path),
      e.asked,
      e.ipfs,
      e.gitignore,
      e.decided_by ?? "",
    ].join("\u0000");
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const kept: DecisionEvent[] = [];
  for (const g of groups.values()) {
    if (g.length <= 2) {
      kept.push(...g);
      continue;
    }
    // The same total order `writeLedger` sorts by, so WHICH two survive cannot depend on arrival order.
    const sorted = [...g].sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.path.localeCompare(b.path));
    kept.push(sorted[0]!, sorted[sorted.length - 1]!);
  }
  return kept;
}

/** Read + parse a ledger file best-effort: missing/unparseable → `[]`, and a file carrying git
 *  merge-conflict markers → `[]` (never parse a half-merged file as truth — decisions.mdx §5). `[]` makes
 *  the union a no-op for that side, so one bad copy can never erase the other side's events.
 *
 *  A SCHEMA-INVALID EVENT no longer voids the file: line-union damage is healed first and the remaining
 *  events are validated one at a time, so one bad record costs one record (`eventsOfLedgerDoc`). `file` is
 *  used only to name the document in the recovery WARN. */
export function parseLedgerBestEffort(raw: string | null, file?: string): DecisionEvent[] {
  return parseLedgerDetailed(raw, file).events;
}

/**
 * `parseLedgerBestEffort`, also saying whether the TEXT was damaged — repaired line-union damage, or records
 * dropped. The semantic write gate needs the difference: a damaged shared copy must be written back healed
 * even when its MEANING is intact, or every reader on every computer keeps re-healing it (and warning) on
 * every read forever.
 */
export function parseLedgerDetailed(
  raw: string | null,
  file?: string,
): { events: DecisionEvent[]; damaged: boolean; unreadable: boolean } {
  if (!raw?.trim()) return { events: [], damaged: false, unreadable: false };
  // `unreadable` is exactly `ledgerIsUnreadable`'s answer, from the same single parse — the mirror's refusal
  // guard and the merge used to parse a multi-megabyte ledger twice to ask two questions about it.
  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(raw)) return { events: [], damaged: true, unreadable: true };
  // A ledger that was UNION-MERGED by git (`decisions.yaml merge=union`) can arrive with an item's `- `
  // leader dissolved, which makes the whole 3 MB document unparseable over one line. Healing it here is
  // what turns 12,511 recovered events into a union instead of a `[]` that quietly discards them all;
  // union-damage.ts explains the damage and why the repair is exactly its inverse.
  const { doc, repaired } = parseYamlHealingUnionDamage(raw);
  if (doc === null) return { events: [], damaged: true, unreadable: true };
  const { events, dropped, shapeOk } = eventsOfLedgerDoc(doc);
  const damaged = repaired !== null || dropped > 0;
  if (damaged && file !== undefined) {
    // Say it once per read, with the numbers, because this is the line that tells the user their ledger
    // was damaged in transit AND that we recovered it. Silence here would make the heal invisible and the
    // one lost record look like a decision they never made.
    log.warn(
      "storage",
      `${file ?? "a decision ledger"}: ${repaired !== null ? "repaired line-union damage and " : ""}` +
        `recovered ${events.length} decision event(s)` +
        `${dropped > 0 ? `, dropping ${dropped} record(s) the union left incomplete` : ""}. ` +
        `The repaired document is written back on this pass. See union-damage.ts.`,
    );
  }
  return { events, damaged, unreadable: !shapeOk };
}

/**
 * Validate a parsed ledger document EVENT BY EVENT.
 *
 * ONE BAD RECORD MUST NEVER DISCARD THE REST, and `DecisionsLedgerSchema.safeParse` cannot give us that:
 * `events: z.array(DecisionEventSchema)` fails the WHOLE array if a single element is wrong, so the
 * document collapses to `[]` and — because `[]` is also what a valid empty ledger looks like — 12,510
 * perfectly good decisions are read as "this side has nothing to contribute" and silently dropped out of
 * the union.
 *
 * That is not theoretical. A ledger healed from line-union damage (union-damage.ts) is valid YAML whose
 * ONE re-split item is missing whichever fields ended up on the far side of git's seam — on the live file
 * the fused entry had lost its `sid`, which the schema requires. So the heal made the document parse and
 * the all-or-nothing validation threw the whole thing away regardless: the mirror kept refusing that repo
 * every pass, its decisions kept not travelling, and the 3.4 MB re-parse kept running on the event loop.
 *
 * `dropped` is returned rather than logged here because this is a pure function called from both legs of
 * the mirror; the caller that knows WHICH file this was does the reporting.
 */
export function eventsOfLedgerDoc(doc: unknown): { events: DecisionEvent[]; dropped: number; shapeOk: boolean } {
  const asDoc = (doc ?? {}) as { events?: unknown };
  if (asDoc.events !== undefined && !Array.isArray(asDoc.events)) return { events: [], dropped: 0, shapeOk: false };
  const raw = Array.isArray(asDoc.events) ? asDoc.events : [];
  const events: DecisionEvent[] = [];
  let dropped = 0;
  for (const e of raw) {
    const one = DecisionEventSchema.safeParse(e);
    if (one.success) events.push(one.data);
    else dropped += 1;
  }
  return { events, dropped, shapeOk: true };
}

/**
 * Did this text FAIL to parse, as opposed to parsing fine and holding nothing?
 *
 * `parseLedgerBestEffort` answers `[]` to both questions, and a caller that reads that as "corrupt" gets a
 * VALID, EMPTY ledger — the shape every freshly-created mirror subtree starts life in — wrong. The mirror's
 * "refuse to overwrite what we could not read" guard has to tell those two apart or it refuses to seed a
 * brand-new mirror, forever, and reports a data-loss ERROR while doing it (performance.mdx P-45).
 *
 * Blank/absent text is NOT unreadable: there is nothing there to protect.
 */
export function ledgerIsUnreadable(raw: string | null): boolean {
  if (!raw?.trim()) return false;
  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(raw)) return true; // conflict markers — a half-merged file
  // "Unreadable" must mean "we cannot recover this", not "a strict parse threw": union damage is both
  // recoverable and, on a fleet whose `.gitattributes` union-merges this file, routine. Answering `true`
  // for a healable document is what made the mirror refuse the same repo every pass for a day, stopping
  // its decisions from travelling at all (union-damage.ts).
  const { doc } = parseYamlHealingUnionDamage(raw);
  if (doc === null) return true;
  // READABLE means "we can recover this document's events", not "every event in it is perfect". A ledger
  // with one malformed record among 12,511 is a ledger we can merge; refusing it protects nothing and
  // costs the user that repo's whole decision history (see `eventsOfLedgerDoc`). Only a document whose
  // SHAPE is wrong — `events` present but not a list, or text we could not parse at all — is unreadable.
  const { shapeOk } = eventsOfLedgerDoc(doc);
  return !shapeOk;
}

/** The ONE serialization of this document, shared by `writeLedger`, the mirror and the reconcile:
 *  DETERMINISTIC (stable order, no volatile fields, so an unchanged log re-serializes byte-identically and
 *  never churns git) and COMPACTED. Compaction belongs HERE rather than at any single writer for the same
 *  reason the manifest's self-claim strip does: `mirrorToSyncRepo` unions the local log with the PRIOR
 *  MIRROR, so a writer that compacted only its own copy would get every dropped re-stamp handed straight
 *  back on the next union. */
export function serializeLedger(events: DecisionEvent[]): string {
  return serializeCanonicalLedger(canonicalLedgerEvents(events));
}

/** The exact event list `serializeLedger` writes — compacted, deduped, in the document's total order. What a
 *  fresh parse of the written file returns, so a cache seeded with it is indistinguishable from a re-read. */
export function canonicalLedgerEvents(events: DecisionEvent[]): DecisionEvent[] {
  return unionLedgerEvents(compactLedger(events), []);
}

/** Serialize an ALREADY-canonical list (skips re-compaction when the caller has just computed it). */
export function serializeCanonicalLedger(canonical: DecisionEvent[]): string {
  return YAML.stringify({ schema_version: 1, events: canonical });
}

/**
 * The STRICT reader's parse, as a pure function of the text: whole-document schema validation, exactly what
 * `readLedger` (decisions.service.ts) accepts. `ok:false` carries the reason; the caller that owns the file
 * does the reporting and the quarantine. Lives here so the merge worker thread can run it.
 */
export function parseLedgerStrict(raw: string): { ok: true; events: DecisionEvent[] } | { ok: false; reason: "conflict" | "yaml" | "schema"; message: string } {
  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(raw)) return { ok: false, reason: "conflict", message: "git merge-conflict markers" };
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    return { ok: false, reason: "yaml", message: (e as Error).message };
  }
  const result = DecisionsLedgerSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "schema", message: result.error.message };
  return { ok: true, events: result.data.events };
}

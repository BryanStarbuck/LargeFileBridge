// The ADDITIVE copy for the two tracking shapes that had no merge at all: the per-file `files/<rel>.yaml`
// SIDECARS and the per-device `history/<device>.txt` LOGS. A LEAF module (fs + path + yaml + logging), so
// both legs of the sync-repo mirror can share it without an import cycle.
//
// THE DEFECT THIS CLOSES. `manifest.yaml`, `decisions.yaml` and `repo_storage.yaml` each got a real merge
// after entries were measured going missing on the live repos. The sidecars and the history logs did not —
// tracking-sync.service.ts copied them with a bare `fs.copyFileSync` in BOTH directions, and its header
// asserted that a copy is "safe for those shapes". A copy is safe for an append-only list only while the
// two sides never diverge, and these two diverge constantly:
//
//   • `appendFileEvent` writes Local Storage and does NOT mirror. The mirror is refreshed only by
//     `writeRepoStorage` / `writeRepoTrackingManifest`, while `reconcileFromSyncRepo` runs on EVERY
//     backbone pull (device worker 10 min, page-load freshness 2 min, boot, artifact trigger). So the
//     inbound copy routinely lands on top of local events written since the last mirror — including the
//     `pull` + `ipfs_pin` events `pullMissing` writes the moment a file arrives.
//   • The outbound leg is worse. A mirror deferred by the working-tree gate drains inside `pull()`'s
//     `withWorktreeBusy` finally — AFTER the merge landed the peer's sidecars, BEFORE
//     `reconcileMirroredRepos` folds them in. This computer's copy then stamps over freshly-merged peer
//     events and the backbone PUSHES the loss as a commit.
//
// `**/files/**/*.yaml merge=union` in `.gitattributes` cannot help: it governs the git merge inside the
// sync repo, not a file copy either side of it.
//
// SYMMETRY IS THE REQUIREMENT, not just union. Two computers merging the same pair must land on the same
// bytes, or each one's "fix" re-dirties what the other just wrote and the backbone commits forever (the
// churn class §6.6's quiet gate exists to kill). Every rule below is commutative: events union and sort by
// a stable key, `first_seen` takes the EARLIEST, and the identity block is chosen by a total order both
// sides compute identically.
import fs from "node:fs";
import YAML from "yaml";
import { log } from "../../shared/logging.js";
import { readYamlDoc, writeYamlDoc } from "./sidecar-heal.js";

/** The exact bytes {@link writeYamlDoc} produces — kept in lockstep with sidecar-heal.ts so the two writers
 *  of one document never re-dirty each other (repo__list_syns.mdx §6). Used for the no-op check below. */
function serialize(doc: unknown): string {
  return YAML.stringify(doc, { sortMapEntries: true });
}

/** Is this a per-file sidecar — `…/files/<rel>.yaml` (repo_tracking_scheme.mdx §3)? */
export function isSidecarPath(relFromStateDir: string): boolean {
  const parts = relFromStateDir.split(/[\\/]/);
  return parts[0] === "files" && relFromStateDir.endsWith(".yaml");
}

/** Is this a per-device history log — `…/history/<device>.txt` (repo_tracking_scheme.mdx §4)? */
export function isHistoryPath(relFromStateDir: string): boolean {
  const parts = relFromStateDir.split(/[\\/]/);
  return parts[0] === "history" && relFromStateDir.endsWith(".txt");
}

/**
 * Copy `src` onto `dst`, MERGING instead of overwriting when `dst` already exists and the shape is one we
 * know how to union. `rel` is the path relative to the per-repo state dir, which is what tells a sidecar
 * from a history log from an ordinary file.
 *
 * The fallback is a plain copy, deliberately: an unknown shape behaves exactly as it did before, so this
 * can only ever add safety. The one asymmetry is the UNREADABLE case, resolved by least-loss:
 *   • destination unparseable → copy over it (we are replacing garbage with something valid);
 *   • source unparseable      → keep the destination (never clobber good with bad).
 *
 * RETURNS whether the destination's bytes actually changed. The reconcile leg uses that answer to decide
 * whether a peer's state really arrived — and therefore whether to pay for the expensive downstream fold
 * (a whole-manifest merge, a ledger re-parse, a UI topic bump) for this repo. Reporting an idempotent
 * no-op as an arrival is what made that fold run for every repo on every pass; see reconcileFromSyncRepo.
 */
export function copyTrackedFile(src: string, dst: string, rel: string): boolean {
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
    return true;
  }
  // IDENTICAL BYTES ⇒ NOTHING TO MERGE. This check used to sit BELOW the shape dispatch, guarding only the
  // plain copy — so it protected the one path that was already cheap and skipped the two that are not.
  //
  // Merging two byte-identical documents is provably a no-op: every rule below is idempotent on equal
  // inputs (events union a set with itself, `first_seen` takes the earliest of two equal timestamps, and
  // the identity block's total order over two identical blocks returns that block). The merge therefore
  // costs two `readFileSync`s, two full YAML parses and a `YAML.stringify` to arrive back at the bytes
  // already on disk.
  //
  // At this product's scale that is the whole hang. Measured on this machine: 20,059 of 20,062 sidecars
  // (99.98%) are byte-identical between Local Storage and the mirror on any given pass — because the
  // mirror is a RECONCILIATION to current state, not a queue of changes, so an unchanged repo re-mirrors
  // its unchanged sidecars every time. A CPU profile of the live backend attributed 7.9 s of 17 s of
  // non-idle time to `readYamlDoc` alone, plus 1.65 s to `serialize` — all of it spent recomputing files
  // that did not change. That is what `loop-watch` reports as `EVENT LOOP BLOCKED … up to 13858ms`, and
  // what `run-worker` sees from the outside as "no acknowledgement from the app within 15s".
  //
  // Returning `false` is exactly right: the destination's bytes did not change, which is the question the
  // reconcile leg asks to decide whether a peer's state really arrived.
  if (sameBytes(src, dst)) return false;
  if (isSidecarPath(rel)) return mergeSidecarInto(src, dst);
  if (isHistoryPath(rel)) return mergeHistoryInto(src, dst);
  fs.copyFileSync(src, dst);
  return true;
}

/** Are these two files byte-identical? A read failure answers "no", so the copy still happens.
 *
 *  BOUNDED ON PURPOSE (memory.mdx — resident memory). This used to be
 *  `fs.readFileSync(a).equals(fs.readFileSync(b))`, which pulls BOTH files fully into memory. On this
 *  product that is the wrong shape by construction: the tracked files ARE the large ones — a pair of 2GB
 *  videos meant 4GB of live Buffers, and this runs for every tracked file of every mirrored repo on every
 *  backbone pass. Two files that differ in the first byte cost the same 4GB as two that are identical.
 *
 *  Now: a size check settles the common case for free, and the byte comparison streams through a fixed
 *  CHUNK-sized pair of buffers, so peak memory is constant no matter how large the files are. It is also
 *  faster in the mismatch case, which is the case that actually triggers a copy — it stops at the first
 *  differing chunk instead of reading both files to the end. */
const SAME_BYTES_CHUNK = 1024 * 1024; // 1 MiB per side; the whole comparison is bounded at ~2 MiB

// ONE pair of scratch buffers for the whole process, not one pair per call.
//
// `Buffer.allocUnsafe(1 MiB)` twice per comparison was 2 MiB of garbage per FILE — and this now runs for
// every tracked file of every mirrored repo on every pass, which on this machine is ~20,000 files, i.e.
// ~40 GB of allocation churn per pass to compare files that average about a kilobyte. That rate is the
// same failure `foreign-pin.service.ts`'s write-back store was built to stop (memory.mdx — the 4 GB RSS
// incident): V8 grows and the OS keeps the pages needed to absorb the churn, so RSS ratchets up while
// `heapUsed`, sampled between GCs, looks fine. The profile agreed — the garbage collector was the third
// largest consumer in the run that found this.
//
// Reuse is safe because `sameBytes` is SYNCHRONOUS and never re-entered: it does no `await` and calls
// nothing that could call back into it, so no second comparison can be in flight over the same buffers.
const sameBytesBufA = Buffer.allocUnsafe(SAME_BYTES_CHUNK);
const sameBytesBufB = Buffer.allocUnsafe(SAME_BYTES_CHUNK);

// ── the equality memo: "we already PROVED these two identical, and neither has moved since" ────────────
//
// The size check settles files of different lengths for two stats. It cannot settle the case this module
// actually spends its life in: 20,059 of 20,062 sidecars on this machine are byte-IDENTICAL to their
// mirror on any given pass, so the size check passes and both files are then opened and read in full —
// every file, every repo, every pass, in BOTH directions. Measured 2026-08-24 after the multi-megabyte
// merges were memoized (performance.mdx P-45), that walk was the whole of the remaining 2,709 ms of
// synchronous blocking per pass: ~59,000 comparisons at ~46 µs each, essentially all of it open/read/close.
//
// A proof of equality stays true for exactly as long as neither file changes, and (ino, size, mtimeNs)
// answers "did it change?" for a fraction of the cost of reading it. So we record the pair's identity at
// the moment we proved it equal, and a later comparison whose identities still match is answered from
// the memo — 2 stats instead of 2 stats + 2 opens + 2 reads + 2 closes.
//
// WHY NANOSECONDS, not `mtimeMs`. This is a correctness boundary, not a tuning knob: a false "identical"
// means a real change never travels to the user's other computer, which is the one failure this whole
// module exists to prevent. `statSync(..., { bigint: true })` reports APFS/ext4's native nanosecond
// timestamp, so a rewrite that lands in the same MILLISECOND at the same size still moves the identity.
// (It is also measurably FASTER than a plain stat here — 16 ms vs 73 ms over 3×3,266 files — because it
// allocates no `Date` objects.)
//
// The key is a HASH of the two paths, not the paths themselves: at ~30,000 files × two 120-character
// absolute paths, storing the strings would cost ~20 MB of long-lived heap to save 2 s of CPU. A hash
// collision cannot manufacture a false positive on its own — the VALUE still carries both inodes, both
// sizes and both nanosecond mtimes, so a colliding entry would have to describe the same two inodes in
// the same state to be believed.
interface ByteId {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

/** How many proven-equal pairs to remember. ~30,000 tracked files here; the cap is the backstop against a
 *  process that runs for months across many storages, and dropping the memo only costs a re-read. */
const EQUAL_MEMO_MAX = 200_000;
const equalMemo = new Map<string, string>();

function byteId(file: string): ByteId | null {
  try {
    const s = fs.statSync(file, { bigint: true });
    return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs };
  } catch {
    return null;
  }
}

/** FNV-1a over both paths, in a stable order, as two 32-bit halves. Cheap (no allocation beyond the key
 *  string) and stable across passes, which is all a memo key has to be. */
function pairKey(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = `${x} ${y}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}.${h2.toString(36)}`;
}

/** The identity of a proven-equal pair, in the same stable order as {@link pairKey}. */
function pairId(a: string, b: string, ia: ByteId, ib: ByteId): string {
  const [p, q] = a < b ? [ia, ib] : [ib, ia];
  return `${p.ino},${p.size},${p.mtimeNs};${q.ino},${q.size},${q.mtimeNs}`;
}

/** TEST-ONLY: forget every proven-equal pair. */
export function resetSameBytesMemo(): void {
  equalMemo.clear();
}

function sameBytes(a: string, b: string): boolean {
  let fdA: number | null = null;
  let fdB: number | null = null;
  try {
    const ia = byteId(a);
    const ib = byteId(b);
    // A file we cannot stat cannot be proven equal; answering "no" copies, which is the safe side.
    if (!ia || !ib) return false;
    // Different lengths cannot be equal — the overwhelmingly common answer, and it costs two stats.
    if (ia.size !== ib.size) return false;
    if (ia.size === 0n) return true;

    // Proven equal before, and neither file has moved a nanosecond since. Nothing to read.
    const key = pairKey(a, b);
    const id = pairId(a, b, ia, ib);
    if (equalMemo.get(key) === id) return true;

    const size = Number(ia.size);
    fdA = fs.openSync(a, "r");
    fdB = fs.openSync(b, "r");
    const bufA = sameBytesBufA;
    const bufB = sameBytesBufB;
    let offset = 0;
    while (offset < size) {
      const want = Math.min(SAME_BYTES_CHUNK, size - offset);
      const readA = fs.readSync(fdA, bufA, 0, want, offset);
      const readB = fs.readSync(fdB, bufB, 0, want, offset);
      // A short/failed read means we cannot PROVE equality; answering "no" copies, which is the safe side.
      if (readA !== want || readB !== want) return false;
      if (Buffer.compare(bufA.subarray(0, want), bufB.subarray(0, want)) !== 0) return false;
      offset += want;
    }
    // Proven identical, right now, for these exact two inodes in these exact states. Remember it so the
    // next pass over an unchanged tree costs two stats per file instead of two full reads. A pair that is
    // NOT equal is deliberately not recorded: the memo only ever answers "yes", so it can never be the
    // reason a real change fails to travel.
    if (equalMemo.size >= EQUAL_MEMO_MAX) equalMemo.clear();
    equalMemo.set(key, id);
    return true;
  } catch {
    return false;
  } finally {
    // Never leak a descriptor on the error paths above — this runs per tracked file per pass, so a leaked
    // fd here would exhaust the process's file-descriptor table long before anything else complained.
    if (fdA !== null) try { fs.closeSync(fdA); } catch { /* already gone */ }
    if (fdB !== null) try { fs.closeSync(fdB); } catch { /* already gone */ }
  }
}

// ── sidecars ────────────────────────────────────────────────────────────────────────────────────────

/** Identity of one sidecar event — when + what + where. Two computers collide on all three only by
 *  coincidence, and an exact re-send of the same event SHOULD collapse. Matches sidecar-heal.ts so the
 *  stray-name heal and this merge agree on what "the same event" means. */
function eventKey(e: Record<string, unknown>): string {
  return `${String(e.at)}|${String(e.kind)}|${String(e.on_device)}`;
}

function eventsOf(block: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return Array.isArray(block?.events) ? (block.events as Record<string, unknown>[]) : [];
}

/** The scalar identity fields — everything in the `file:` block that is not the event list. */
function identityOf(block: Record<string, unknown>): Record<string, unknown> {
  const { events: _events, ...rest } = block;
  return rest;
}

/**
 * Which side's identity block wins: the one whose `modified` is newer, ties broken by a canonical string
 * compare so BOTH computers pick the same one. Chosen as a whole block rather than per field — a `size`
 * from one computer beside a `hash` from another describes a file that never existed.
 */
function pickIdentity(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const am = String(a.modified ?? "");
  const bm = String(b.modified ?? "");
  if (am !== bm) return am > bm ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

/** `first_seen` is the EARLIEST sighting by definition, so the merge takes the earlier `at` — which also
 *  makes the field converge to one value on every computer instead of ping-ponging. */
function earlierFirstSeen(a: unknown, b: unknown): unknown {
  const ao = (a ?? null) as Record<string, unknown> | null;
  const bo = (b ?? null) as Record<string, unknown> | null;
  if (!ao) return bo;
  if (!bo) return ao;
  const at = String(ao.at ?? "");
  const bt = String(bo.at ?? "");
  if (at && bt && at !== bt) return at < bt ? ao : bo;
  return JSON.stringify(ao) <= JSON.stringify(bo) ? ao : bo;
}

function mergeSidecarInto(src: string, dst: string): boolean {
  const incoming = readYamlDoc(src);
  const local = readYamlDoc(dst);
  const incomingBlock = incoming?.file as Record<string, unknown> | undefined;
  const localBlock = local?.file as Record<string, unknown> | undefined;
  if (!incomingBlock) return false; // unreadable/foreign source — keep what we have
  if (!localBlock) {
    fs.copyFileSync(src, dst); // destination is garbage; the incoming copy is strictly better
    return true;
  }
  const byKey = new Map<string, Record<string, unknown>>();
  for (const e of [...eventsOf(localBlock), ...eventsOf(incomingBlock)]) byKey.set(eventKey(e), e);
  const events = [...byKey.entries()]
    .sort(([ka], [kb]) => ka.localeCompare(kb))
    .map(([, e]) => e);

  const merged: Record<string, unknown> = {
    ...pickIdentity(identityOf(localBlock), identityOf(incomingBlock)),
    first_seen: earlierFirstSeen(localBlock.first_seen, incomingBlock.first_seen),
    events,
  };
  const next = { ...(local as Record<string, unknown>), file: merged };
  // Only write when the bytes actually change — an unchanged sidecar must never re-dirty the mirror.
  try {
    if (fs.readFileSync(dst, "utf8") === serialize(next)) return false;
  } catch {
    /* unreadable destination — fall through and write */
  }
  writeYamlDoc(dst, next);
  return true;
}

// ── history logs ────────────────────────────────────────────────────────────────────────────────────

/** A `#`-prefixed banner line the log opens with (history-log.service.ts). */
function isHeaderLine(line: string): boolean {
  return line.startsWith("#");
}

/**
 * One log ENTRY: a flush-left line plus the indented per-file lines that belong to it
 * (repo_tracking_scheme.mdx §4.1). Unioning by whole blocks — never by bare lines — is what keeps an
 * indented `pin=yes  path` attached to the entry it explains.
 */
function historyBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (isHeaderLine(line)) continue; // headers are re-emitted once, below
    if (/^\s/.test(line) && blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
    else blocks.push(line);
  }
  return blocks;
}

function headerOf(text: string): string[] {
  return text.split("\n").filter(isHeaderLine);
}

function mergeHistoryInto(src: string, dst: string): boolean {
  let incoming: string;
  let local: string;
  try {
    incoming = fs.readFileSync(src, "utf8");
    local = fs.readFileSync(dst, "utf8");
  } catch (e) {
    log.warn("storage", `history merge: could not read ${src} / ${dst}: ${(e as Error).message}`);
    return false; // keep the destination — never clobber on a read failure
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const b of [...historyBlocks(local), ...historyBlocks(incoming)]) {
    if (seen.has(b)) continue;
    seen.add(b);
    blocks.push(b);
  }
  // Every line opens with an ISO timestamp, so sorting the block text sorts chronologically AND gives both
  // computers the identical order for the identical set.
  blocks.sort((a, b) => a.localeCompare(b));
  const header = headerOf(local).length > 0 ? headerOf(local) : headerOf(incoming);
  const next = [...header, ...blocks].join("\n") + "\n";
  if (next === local) return false; // nothing new arrived — leave the file (and the mirror) alone
  const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, dst);
    return true;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    log.warn("storage", `history merge: could not write ${dst}: ${(e as Error).message}`);
    return false;
  }
}

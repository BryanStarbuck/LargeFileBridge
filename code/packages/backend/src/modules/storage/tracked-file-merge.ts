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
  if (isSidecarPath(rel)) return mergeSidecarInto(src, dst);
  if (isHistoryPath(rel)) return mergeHistoryInto(src, dst);
  // The plain-copy fallback compares first. `copyFileSync` on identical bytes is not free — this path runs
  // for every tracked file of every mirrored repo on every backbone pass.
  if (sameBytes(src, dst)) return false;
  fs.copyFileSync(src, dst);
  return true;
}

/** Are these two files byte-identical? A read failure answers "no", so the copy still happens. */
function sameBytes(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
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

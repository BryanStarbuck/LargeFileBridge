// Everything that makes a manifest ADDITIVE, in one LEAF module (pure functions, no app state): the
// duplicate FOLD, the per-entry MERGE (storage_company.mdx §8.4.3), and the canonical SERIALIZATION.
//
// It lives apart from tracking-sync.service.ts because both the WRITE path (reconciling a pulled sync-repo
// subtree) and the READ path (units.service folding the unit and tracking manifests for the file rows) need
// it, and units.service cannot import tracking-sync.service without an import cycle. Every other module that
// reads or writes a manifest routes through here, which is the point: the ways this file's entries have
// actually been lost were all "some caller did its own thing" — a bare Map, a bare YAML.stringify, a
// wholesale copy.
import YAML from "yaml";
import type { Manifest, ManifestFile } from "@lfb/shared";
import { healWindowsPath } from "../../shared/rel-path.js";

/**
 * Fold a file list so ONE path appears ONCE, unioning what the duplicates knew.
 *
 * Duplicates are the NORMAL output of the backbone, not a corruption: `manifest.yaml` carries
 * `merge=union` (git_backbone.mdx §4.2), so a conflicting merge CONCATENATES both sides and the file
 * legitimately holds the same `- path:` twice. Measured on the live `all` repo's mirror: 27 of 92 commits
 * held 29 entry blocks for 19 distinct paths.
 *
 * Every reader used to collapse that with `new Map(files.map((f) => [f.path, f]))` — LAST OCCURRENCE WINS,
 * silently discarding whichever twin held the CID or the peer's pin claim. That is a delete disguised as a
 * read: `mergeManifests` promises "absence is never a delete", then loses a claim before the merge even
 * starts. Folding unions instead — the same rule the `\`-vs-`/` collision already used.
 *
 * `unit === "computer"` keys on ABSOLUTE paths, where `C:\Users\…` is a legitimate value, so separators are
 * left alone there (repo__list_syns.mdx §6.1 is about repo-relative keys).
 */
export function foldManifestFiles(files: ManifestFile[], unit: Manifest["unit"]): ManifestFile[] {
  const heal = unit !== "computer";
  const byPath = new Map<string, ManifestFile>();
  for (const f of files) {
    const p = heal ? healWindowsPath(f.path) : f.path;
    const prev = byPath.get(p);
    if (!prev) {
      byPath.set(p, { ...f, path: p });
      continue;
    }
    // Prefer the twin that knows more (has a CID; else the newer modified_at), and union the device claims
    // so no computer's "I hold this" is dropped by the fold.
    const incWins = (!!f.cid && !prev.cid) || (!!f.cid === !!prev.cid && (f.modified_at ?? "") > (prev.modified_at ?? ""));
    byPath.set(p, {
      ...(incWins ? f : prev),
      path: p,
      sha256: prev.sha256 ?? f.sha256,
      pinned_by: [...new Set([...prev.pinned_by, ...f.pinned_by])],
    });
  }
  return [...byPath.values()];
}

/**
 * Merge an incoming manifest into the local one (storage_company.mdx §8.4.3). An arriving manifest is a set
 * of CLAIMS from another computer, never ground truth (sync_list.mdx §5), so this is a per-entry MERGE:
 *
 *   • **union by `path`** — an entry on either side survives;
 *   • **union `pinned_by`** — the two computers' pin claims ADD. This is the load-bearing one: a
 *     last-writer copy erases the peer's claim, and the peer's claim IS the "a computer of yours has this"
 *     signal the whole pull-down feature reads;
 *   • **absence is NEVER a delete** — a path missing from the incoming copy keeps its local entry;
 *   • a **CID conflict** on the same path resolves to the newer `modified_at`; at the SAME stamp it
 *     resolves to the lexicographically smaller CID — see `incAuthoritative` below.
 *
 * `selfLabel` is THIS computer's device label, and passing it is what ENFORCES the rule the header of this
 * paragraph used to only assert: an incoming `pinned_by` claim naming us is DROPPED, never unioned in. Pin
 * truth is self-claim-only and derived from the local pinset (ipfs.mdx §1.1), so a claim about us arriving
 * over the wire is not evidence of anything — it is our own past claim coming back, or a peer's stale copy
 * of it. The merge used to union it and rely on the pin pass to re-derive the truth afterwards, which holds
 * only for units the pin pass actually visits: a repo with `pinned: false` runs the RECEIVE half every pass
 * (marker + reconcile) and `runUnitPin` NEVER, so the claim had no writer that could ever correct it.
 * Measured on charlie-kirk (`pinned: false`, `last_pin_at: null`): 173 entries advertised `xenx-xenx-pc`
 * while `ipfs pin ls` held none of those CIDs — this computer telling the user's other computers it was
 * holding bytes it did not have. Omit the argument only where there is no wire (a fold of two local
 * documents); every path that reads another computer's copy must pass it.
 *
 * `opts.incomingIsWire` says the incoming side is the SHARED MIRROR — the one copy every computer writes
 * its own claims into — and it is what makes a WITHDRAWN claim able to travel at all. "Union `pinned_by`"
 * is grow-only, and `healSelfPinClaims` is a DELETE: only device D can prove D no longer holds a CID, and
 * under a pure union no other computer can ever learn that it did. Measured on the live company repo,
 * 2026-08-11: `bryan-mac-pro` dropped 10 unbacked claims in charlie-kirk and 3 in `all`, and
 * `bryanstarbuck-macbook-pro` — for whom those are ordinary PEER claims — re-unioned every one of them from
 * its stale local copy and pushed them back, one commit each way, every ten to twenty minutes, all day.
 * 77% of that day's commits were this and nothing else.
 *
 * So on the wire the two halves of `pinned_by` have DIFFERENT owners and must merge differently: OUR label
 * comes from the local document (only we can know it, and that is the existing self-claim rule), and every
 * OTHER label PASSES THROUGH from the mirror unchanged — never re-added from what we happen to remember.
 * A peer's withdrawal then survives one hop instead of being undone by it. This cannot lose an entry: a
 * path the wire has never seen is not iterated here at all and keeps its local claims whole.
 */
export function mergeManifests(
  local: Manifest,
  incoming: Manifest,
  selfLabel?: string | null,
  opts: {
    incomingIsWire?: boolean;
    /** Map a recorded CID this computer has DISPROVED to the one that replaces it (superseded-cids.service.ts).
     *  Injected rather than imported so this stays a pure leaf; only the two WIRE merges pass it, because a
     *  fold of two local documents cannot reintroduce a CID we already corrected. */
    supersededCid?: (cid: string) => string | null;
  } = {},
): Manifest {
  // FOLD EACH SIDE FIRST. Either side may legitimately carry the same path twice (a `merge=union` git
  // merge concatenates both), and keying a raw list into a Map is last-wins — the twin that held the CID
  // or the peer's claim would be dropped before this function's own union rules ever ran.
  const byPath = new Map<string, ManifestFile>(foldManifestFiles(local.files, local.unit).map((f) => [f.path, f]));
  // Our own label, stripped from every arriving entry before it is unioned (see the doc block).
  const peerClaims = (f: ManifestFile): string[] =>
    selfLabel ? (f.pinned_by ?? []).filter((c) => c !== selfLabel) : (f.pinned_by ?? []);
  // What the LOCAL side contributes. Off the wire that is our own label only — every peer's claim is the
  // mirror's to state, so a withdrawal there is not undone by our stale copy of it. Requires `selfLabel`:
  // without one we cannot tell our claim from a peer's, and dropping both would publish a lie.
  const ownClaims = (f: ManifestFile): string[] =>
    opts.incomingIsWire && selfLabel ? (f.pinned_by ?? []).filter((c) => c === selfLabel) : (f.pinned_by ?? []);
  for (const inc of foldManifestFiles(incoming.files, incoming.unit)) {
    const cur = byPath.get(inc.path);
    if (!cur) {
      byPath.set(inc.path, { ...inc, pinned_by: peerClaims(inc) });
      continue;
    }
    const incNewer = (inc.modified_at ?? "") > (cur.modified_at ?? "");
    const sameStamp = (inc.modified_at ?? "") === (cur.modified_at ?? "");
    // THE TIE IS THE WHOLE BUG. Two CIDs for one path at the SAME `modified_at` is not a disagreement about
    // time — it is the same bytes recorded under two add profiles (a bare `ipfs add` → `Qm…` vs this app's
    // v1-raw-leaves → `bafk…`). "Ties keep local" is not a tie-break at all: it is symmetric, so BOTH
    // computers keep their own value and stamp it over the other's on the next mirror, forever. Measured on
    // charlie-kirk's mirror: 14 consecutive backbone commits alternating `Qm…` / `bafk…` every ~20 minutes,
    // one commit per pass on each machine, none of them carrying any new information.
    //
    // A total order on the VALUE converges instead: both sides compute the same winner, so the merge after
    // it is a no-op and the churn stops. Plain `<` and never `localeCompare` — collation is locale-dependent
    // and two computers must not be able to disagree about which CID won.
    const incWinsTie = sameStamp && !!cur.cid && !!inc.cid && cur.cid !== inc.cid && inc.cid < cur.cid;
    const incAuthoritative = incNewer || incWinsTie;
    byPath.set(inc.path, {
      ...cur,
      // The winning side supplies the whole (cid, size) pair — splitting them would leave `size` to
      // ping-pong on its own for exactly the reason the CID did.
      cid: cur.cid && inc.cid ? (incAuthoritative ? inc.cid : cur.cid) : (cur.cid ?? inc.cid),
      size: incAuthoritative ? (inc.size ?? cur.size) : cur.size,
      sha256: cur.sha256 ?? inc.sha256,
      modified_at: incAuthoritative ? inc.modified_at : cur.modified_at,
      pinned_by: [...new Set([...ownClaims(cur), ...peerClaims(inc)])].sort((a, b) => a.localeCompare(b)),
    });
  }
  // LAST, AFTER the winner is chosen — a CID we have PROVEN wrong must not stand however it won.
  //
  // The tie-break above is a total order on the VALUE, which converges but does not know what it is
  // ordering. For two add profiles of one file that is exactly right. For a wrapper-DIRECTORY CID beside
  // the file CID it contains it is a coin toss, and on charlie-kirk it came up wrapper: a pull healed 8
  // entries and pulled the bytes down, the next backbone reconcile put all 8 wrapper CIDs straight back,
  // and the count returned to 16 with every file on disk and pinned. Correcting here rather than inside the
  // tie-break also means the corrected value is what gets PUBLISHED, so the peer still holding the bad CID
  // is fixed by the next round rather than arguing with us forever.
  const fixCid = opts.supersededCid;
  return {
    ...local,
    files: [...byPath.values()]
      .map((f) => {
        const fixed = f.cid && fixCid ? fixCid(f.cid) : null;
        return fixed && fixed !== f.cid ? { ...f, cid: fixed } : f;
      })
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * The ONE canonical, byte-stable serialization of a manifest (repo__list_syns.mdx §6): entries sorted by
 * `path`, stable key order, `pinned_by` sorted, POSIX separators, no volatile timestamp — so an unchanged
 * list re-serializes byte-identically and produces no commit.
 *
 * It lives in this leaf so EVERY writer shares it. It used to be private to manifest.service.ts, which meant
 * the two writers that cannot import that module — the sync-repo mirror and the reconcile — wrote the same
 * document with a plain `YAML.stringify`. Two spellings of one file is churn by construction: each writer
 * re-dirtied what the other had just written, and every one of those diffs became a backbone commit.
 */
export function serializeManifest(manifest: Manifest): string {
  return YAML.stringify({
    schema_version: manifest.schema_version,
    unit: manifest.unit,
    files: foldManifestFiles(manifest.files, manifest.unit)
      .map((f) => ({
        path: f.path,
        cid: f.cid,
        size: f.size,
        sha256: f.sha256,
        modified_at: f.modified_at,
        pinned_by: [...f.pinned_by].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}


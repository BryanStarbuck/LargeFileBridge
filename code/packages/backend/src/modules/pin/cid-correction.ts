// WHICH CORRECTION A DIFFERING CID DESERVES — the one decision, in one place (knowledge/ipfs.mdx §5.1).
//
// Three code paths re-hash a file's bytes, find them pinned here under a CID the shared manifest does not
// record, and have to write down what they learned: the reconciler's probe, `runUnitPin`'s foreign-profile
// adopt, and the pull's local-bytes fast path. There are two possible conclusions and they are opposites:
//
//   • the recorded CID is a FILE → two legitimate add profiles over the same bytes. The fleet's record
//     stands and the pair is remembered LOCALLY (`cid_equivalence.yaml`), because neither computer's
//     spelling is more true than the other's and rewriting it is how two machines stamp over each other
//     every pass forever.
//   • the recorded CID is a wrapper DIRECTORY → not a spelling of this file at all. No computer can ever
//     `cat` it, so an equivalence would quietly satisfy THIS machine while every peer keeps a CID it cannot
//     use. It gets corrected in the shared record and written to `superseded_cids.yaml`.
//
// ONLY THE RECONCILER MADE THAT DISTINCTION. The other two recorded an equivalence unconditionally, and one
// of them poisoned a live fleet: on 2026-08-12 pc-10 pulled `chain_of_evil.mp4`, took the fast path (bytes
// already on disk), and recorded `wrapper → file` as an EQUIVALENCE. From that moment `pinsetHasContent`
// answered true through the pair, so the reconciler's probe — the only thing that would have noticed the
// directory — never ran again on that entry. pc-10 kept publishing the wrapper CID, pc-4 (which had proved
// it) kept rewriting it to the file CID, and charlie-kirk's manifest alternated between the two every 5-10
// minutes for days: 30 consecutive commits carrying 4 distinct versions of one file.
//
// SILENCE IS A THIRD ANSWER. `dagNodeType` returns null when the node cannot say — the blocks are not here
// and no peer served them in time — and null is NOT "file". Recording either correction on an unknown is
// how the wrong one gets written down permanently; the pass simply learns nothing and asks again next time.
import { noteCidEquivalence } from "./cid-equivalence.service.js";
import { noteSupersededCid } from "./superseded-cids.service.js";
import { canonicalCid, dagNodeType } from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

/** What was written down. `superseded` means the CALLER must also replace the recorded CID with `localCid`. */
export type CidCorrection = "same" | "equivalent" | "superseded" | "unknown";

/**
 * Record the right correction for "the manifest says `recordedCid`, these bytes are pinned here as
 * `localCid`", and tell the caller which one it was.
 *
 * Costs one `files/stat` on the recorded CID, and only on the paths that have already paid to re-hash a
 * whole file — never on the common case where the two CIDs agree.
 */
export async function recordCidCorrection(
  recordedCid: string,
  localCid: string,
  ctx: { path?: string; timeoutMs?: number } = {},
): Promise<CidCorrection> {
  const where = ctx.path ? ` for ${ctx.path}` : "";
  // BOOKKEEPING MUST NEVER FAIL THE WORK IT DESCRIBES. Two of the three callers are inside a pin pass's
  // parallel fan-out and a pull's per-file try, where a throw here would fail a file whose bytes are
  // already safely pinned. Nothing below throws today (`dagNodeType` answers null on any fault, and both
  // maps swallow their own write errors); this keeps that true for whoever edits them next.
  try {
    if (canonicalCid(recordedCid) === canonicalCid(localCid)) return "same";
    const type = await dagNodeType(recordedCid, ctx.timeoutMs);
    if (type === "directory") {
      noteSupersededCid(recordedCid, localCid);
      log.info("pin", `recorded CID${where} is a wrapper directory (${recordedCid}) — the file is ${localCid}`);
      return "superseded";
    }
    if (type === "file") {
      noteCidEquivalence(recordedCid, localCid);
      return "equivalent";
    }
    // Unknown. Say so in the log, because the alternative — an entry that keeps being re-probed every pass
    // — otherwise looks like the map is simply not working.
    log.debug("pin", `cannot tell what ${recordedCid}${where} is yet — recording nothing this pass`);
    return "unknown";
  } catch (e) {
    log.warn("pin", `classifying the recorded CID${where} failed: ${(e as Error).message}`);
    return "unknown";
  }
}

// ENFORCE A UNIT'S TOMBSTONES RIGHT NOW (pm/deletion.mdx §7).
//
// The scheduled pin pass enforces the ledger on every pass, which is what carries a deletion across the
// fleet. This is the INTERACTIVE twin: the user just typed `lfb delete` (or clicked "Delete everywhere…")
// and the bytes must be gone when the command returns — not in up to fifteen minutes, after they have been
// told the file was deleted. Telling someone their file is gone while it is still on disk is the kind of
// small lie this feature cannot afford.
//
// It runs the SAME `reap()` the pass runs. Everything about what deletion means lives in deletions.service;
// this module only assembles the dependencies for one repo and writes the results back.
import { log } from "../../shared/logging.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { pinsetHasContent } from "./cid-equivalence.service.js";
import { computerLabel } from "../store-model/config.service.js";
import { readRepoTrackingManifest, writeRepoTrackingManifest } from "./manifest.service.js";
import { joinRelConfined } from "../../shared/rel-path.js";
import {
  deletionsPathForRepo,
  readDeletions,
  writeDeletions,
  reap,
  sidecarPathsForRepoRel,
  type ReapResult,
} from "./deletions.service.js";

export interface EnforceNowResult extends ReapResult {
  /** True when the IPFS node was unreachable: bytes and sidecars were still handled, pins were not. */
  pinsSkipped: boolean;
}

export async function enforceNow(repoRoot: string): Promise<EnforceNowResult> {
  const file = deletionsPathForRepo(repoRoot);
  const ledger = readDeletions(file); // a throw here is the caller's to report — never start a fresh ledger
  const label = computerLabel();

  const manifest = readRepoTrackingManifest(repoRoot);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));

  // A DEAD IPFS NODE MUST NOT BLOCK THE DELETE. Unpinning is one of three things enforcement does, and the
  // other two — removing the bytes and removing the derived transcription/description/OCR — are the ones
  // that actually take the content off this computer. Refusing the whole operation because the daemon is
  // down would leave the file, and its full text extraction, sitting right where they were. The pin is
  // reported as skipped and the next scheduled pass drops it.
  let pinset = new Set<string>();
  let pinsSkipped = false;
  try {
    pinset = new Set((await ipfs.listPins()).map((p) => ipfs.canonicalCid(p.cid)));
  } catch (e) {
    pinsSkipped = true;
    log.warn("pin", `enforceNow(${repoRoot}): pin list unavailable, unpinning deferred: ${(e as Error).message}`);
  }

  const result = await reap(
    ledger,
    {
      resolveAbs: (rel) => joinRelConfined(repoRoot, rel),
      pinsetHasContent: (cid) => (pinsSkipped ? false : pinsetHasContent(pinset, cid)),
      pinRm: (cid) => ipfs.pinRm(cid),
      canonicalCid: ipfs.canonicalCid,
      label,
      byPath,
      sidecarPathsFor: (rel) => sidecarPathsForRepoRel(repoRoot, rel),
    },
    new Date().toISOString(),
  );

  // Write the receipts and the `state: removed` marks. The ledger write is what makes this device's
  // enforcement visible to the rest of the fleet on the next backbone push.
  writeDeletions(file, ledger);
  if (result.entriesMarked > 0) {
    try {
      writeRepoTrackingManifest(repoRoot, { ...manifest, files: [...byPath.values()] });
    } catch (e) {
      // The bytes are already gone and the ledger is already written, so the deletion HOLDS — the gate reads
      // the ledger, not the manifest mark. Log and continue rather than failing a delete that succeeded.
      log.warn("pin", `enforceNow(${repoRoot}): manifest mark not written: ${(e as Error).message}`);
    }
  }
  return { ...result, pinsSkipped };
}

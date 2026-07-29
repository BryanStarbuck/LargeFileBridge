// The LOCAL content-equivalence map: "the CID the shared manifest records" → "the CID THIS computer has
// pinned for the very same bytes" (knowledge/ipfs.mdx §5.1).
//
// WHY THIS EXISTS (the 2026-07-29 manifest ping-pong). Two computers can pin identical bytes under
// DIFFERENT CIDs — a legacy `ipfs add` produces a CIDv0 `Qm…` dag-pb CID, a raw-leaves build produces a
// `bafk…` CIDv1 — and those are different multihashes, so `canonicalCid()` cannot bridge them (it only
// re-encodes the SAME multihash). The pin pass handled that with FOREIGN-PROFILE ADOPTION: re-hash the
// bytes, find the local pin, and write that CID into the manifest entry.
//
// But the manifest is SHARED and committed. So computer A wrote `bafk…`, computer B pulled it, adopted its
// own `Qm…` and pushed, A pulled that, adopted `bafk…` back, and so on — every cycle, forever. The commits
// were real conflicts on a real payload file, which is exactly the kind the backbone must retry and race
// over. Two machines with different IPFS add profiles kept the company repo in permanent conflict.
//
// The fix is to keep the adoption where it belongs: this equivalence is a fact about THIS computer's
// pinset, not about the fleet's record of the file. It is stored locally, in the state root, and the
// shared manifest CID is left exactly as the fleet recorded it.
import type { CidEquivalence } from "@lfb/shared";
import { CidEquivalenceSchema } from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { cidEquivalencePath } from "../../shared/store/scopes.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

const FILE = () => cidEquivalencePath();

let cache: CidEquivalence | null = null;

function load(): CidEquivalence {
  if (cache) return cache;
  try {
    cache = readYaml(FILE(), CidEquivalenceSchema);
  } catch (e) {
    // A corrupt local cache is never fatal — it is derived data we can rebuild by re-hashing.
    log.warn("pin", `cid equivalence map unreadable, starting fresh: ${(e as Error).message}`);
    cache = CidEquivalenceSchema.parse({});
  }
  return cache;
}

/** Record that `recordedCid` (what the shared manifest says) and `localCid` (what we have pinned) are the
 *  same bytes on THIS computer. Keyed canonically so base/version differences never split an entry. */
export function noteCidEquivalence(recordedCid: string, localCid: string): void {
  const doc = load();
  const key = canonicalCid(recordedCid);
  const val = canonicalCid(localCid);
  if (key === val || doc.pairs[key] === val) return;
  doc.pairs[key] = val;
  try {
    writeYaml(FILE(), doc as unknown as Record<string, unknown>);
  } catch (e) {
    // Losing the cache costs a re-hash next pass — never a failure worth aborting the pin pass for.
    log.warn("pin", `could not persist cid equivalence: ${(e as Error).message}`);
  }
}

/** The locally-pinned equivalent of a recorded CID, if we have ever established one. */
export function equivalentCid(recordedCid: string): string | null {
  return load().pairs[canonicalCid(recordedCid)] ?? null;
}

/** Is this recorded CID pinned here — either directly, or as a known content-identical local CID? */
export function pinsetHasContent(pinset: Set<string>, recordedCid: string): boolean {
  if (pinset.has(canonicalCid(recordedCid))) return true;
  const equiv = equivalentCid(recordedCid);
  return equiv !== null && pinset.has(equiv);
}

/** Test seam — drop the in-process cache so a fresh read hits disk. */
export function resetCidEquivalenceCache(): void {
  cache = null;
}

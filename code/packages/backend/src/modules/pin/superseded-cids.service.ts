// CIDs THIS COMPUTER HAS PROVEN WRONG — "the manifest records a folder, not the file" (ipfs.mdx §5.1
// Layer 0), and the file CID that folder really contains.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `cid_equivalence.yaml`. That map answers "different spelling, same
// bytes" and its whole design is to keep the shared manifest UNTOUCHED — two add profiles are both valid,
// so neither computer gets to overwrite the other. A wrapper-directory CID is the opposite case: it is not
// a spelling of the file at all, no computer can ever `cat` it, and leaving it in the shared record helps
// nobody. It has to be corrected, and the correction has to STICK.
//
// It did not stick. `mergeManifests` breaks a same-timestamp CID disagreement with a total order on the
// value — right for two add profiles, arbitrary for a folder beside a file. Measured on charlie-kirk
// 2026-08-12: a pull healed 8 wrapper CIDs and pulled the bytes down, the backbone reconcile a minute later
// handed all 8 wrapper CIDs straight back, and the pull-down count went from 8 to 16 with the files sitting
// on disk, pinned. Every attempt for weeks had been undone the same way.
//
// So the healer writes down what it proved. The wire merge then reads the arriving CID through this map:
// a CID we have disproved cannot win a tie it should never have been in, and the corrected value is what
// gets published back — which is how the peer still holding the bad CID is eventually fixed too.
//
// LOCAL, like the equivalence map, and for the same reason: it is derived. Any computer re-establishes it
// by walking the CID, and the fleet's copy of the conclusion travels in the manifest itself.
import type { SupersededCids } from "@lfb/shared";
import { SupersededCidsSchema } from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { supersededCidsPath } from "../../shared/store/scopes.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

const FILE = () => supersededCidsPath();

let cache: SupersededCids | null = null;

function load(): SupersededCids {
  if (cache) return cache;
  try {
    cache = readYaml(FILE(), SupersededCidsSchema);
  } catch (e) {
    log.warn("pin", `superseded cid map unreadable, starting fresh: ${(e as Error).message}`);
    cache = SupersededCidsSchema.parse({});
  }
  return cache;
}

/**
 * Record that `wrongCid` does not denote this file and `fileCid` does — only ever from a walk that ACTUALLY
 * RESOLVED (`resolveFileCid`), never from a guess. A wrong entry here would suppress a legitimate CID on
 * every merge from now on, so the bar is proof, not suspicion.
 */
export function noteSupersededCid(wrongCid: string, fileCid: string): void {
  const doc = load();
  const key = canonicalCid(wrongCid);
  const val = canonicalCid(fileCid);
  if (key === val || doc.pairs[key] === val) return;
  doc.pairs[key] = val;
  try {
    writeYaml(FILE(), doc as unknown as Record<string, unknown>);
  } catch (e) {
    // Losing this costs another walk next pass — never a failure worth aborting a pull or a pass for.
    log.warn("pin", `could not persist superseded cid: ${(e as Error).message}`);
  }
}

/** The file CID that replaces a recorded CID we have disproved, or null when we know nothing about it. */
export function supersededCid(recorded: string): string | null {
  return load().pairs[canonicalCid(recorded)] ?? null;
}

/** A cheap shape test for the ONE untrusted input this module takes: pairs copied out of a peer's device
 *  file. Not a full multibase parse — just enough that a truncated line or a stray comment can never be
 *  written into a map whose whole job is to override CIDs. */
function looksLikeCid(s: string): boolean {
  return typeof s === "string" && (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s) || /^ba[a-z2-7]{57,}$/.test(s));
}

/** Everything this computer has proved, for publishing into its own device file (devices.mdx §7.3). */
export function supersededPairs(): Record<string, string> {
  return { ...load().pairs };
}

/**
 * Take on what ANOTHER of the user's computers proved (`devices/<peer>.yaml` → `superseded_cids`).
 *
 * WHY A SECOND-HAND PROOF IS ACCEPTED HERE and nowhere else. The walk that establishes a pair needs the
 * wrapper's blocks; a computer that never held them cannot repeat it, so on that machine the merge tie-break
 * keeps choosing the wrapper CID and publishing it — and the one machine that DID prove it keeps correcting
 * it back. That is not a disagreement anyone can win: it is two computers with different evidence, forever.
 * Whoever has the evidence states it, and the rest of the fleet stops arguing.
 *
 * Conservative in the one direction that matters: a pair we already hold is never overwritten (our own walk
 * outranks a peer's report), and a pair is only taken when both halves parse as CIDs, so a mangled peer file
 * cannot suppress a legitimate CID here. Returns how many were new.
 */
export function adoptSupersededCids(pairs: Record<string, string>): number {
  let added = 0;
  for (const [wrong, file] of Object.entries(pairs ?? {})) {
    // A peer file we cannot make sense of is a claim we skip, never a failure — and never a pair, because
    // `canonicalCid` passes an unrecognized string straight through (it is deliberately non-throwing).
    if (!looksLikeCid(wrong) || !looksLikeCid(file)) continue;
    const key = canonicalCid(wrong);
    const val = canonicalCid(file);
    if (key === val || load().pairs[key]) continue;
    noteSupersededCid(key, val);
    added++;
  }
  if (added > 0) log.info("pin", `adopted ${added} wrapper-CID correction(s) proved by another of your computers`);
  return added;
}

/** Test seam — drop the in-process cache so a fresh read hits disk. */
export function resetSupersededCidsCache(): void {
  cache = null;
}

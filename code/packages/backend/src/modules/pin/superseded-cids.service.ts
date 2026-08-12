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

/** Test seam — drop the in-process cache so a fresh read hits disk. */
export function resetSupersededCidsCache(): void {
  cache = null;
}

// The "get file list" engine behind the CLI (cli.mdx §4) — GET /api/files/list.
// A QUERY, not an action: it changes nothing on disk. It composes the SAME per-file verdicts the UI
// renders (composeFileRows via computeRepoDetail — task statuses, git-ignore axis, presence, pin
// claims) and groups the matching files by category. The CLI prints the result verbatim; category
// membership is decided HERE so the CLI and the UI can never disagree (cli.mdx §4.2, LOCKED).
import path from "node:path";
import { mediaKindForName } from "@lfb/shared";
import type { FileRow, FilesListCategory, FilesListCategoryKey, FilesListResult } from "@lfb/shared";
import { listRepoFolders, getRepoConfig, computeRepoDetail } from "../store-model/units.service.js";
import { listStoragesPage } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

export const FILES_LIST_CATEGORY_KEYS: FilesListCategoryKey[] = [
  "compress",
  "ignore",
  "pull_down",
  "not_backed_up",
  "transcribe",
  "describe",
  "ocr",
];

// Display titles — the headers the CLI prints (cli.mdx §4.4). Plain English; the product name, when
// it appears in prose, is spelled out "Large File Bridge" (never abbreviated in user-facing text).
const TITLES: Record<FilesListCategoryKey, string> = {
  compress: "Compressible",
  ignore: "Should be git-ignored",
  pull_down: "Pull down (on your other computers)",
  not_backed_up: "Not backed up anywhere",
  transcribe: "Transcribable",
  describe: "AI describable",
  ocr: "OCR-able",
};

// Category predicates over the ONE row shape the UI already trusts (cli.mdx §4.2). Each reads
// backend-computed fields only — no filesystem access, no re-derivation, in this file.
const MATCH: Record<FilesListCategoryKey, (r: FileRow) => boolean> = {
  compress: (r) => r.compress === "could",
  // Big-but-not-ignored check-in hazards (scan rule 4). `gitignore === false` is git's own verdict
  // (`git check-ignore`, never the ledger); undefined means "not determined" and never matches.
  ignore: (r) => r.presence !== "remote-only" && r.gitignore === false && r.analysisOnly !== true,
  // Bytes exist on another of the user's computers and not here: a manifest-composed remote-only row,
  // or a decided (sync) file whose local pinset verifiably lacks the CID (pinnedHere === false).
  pull_down: (r) => r.presence === "remote-only" || (r.decision === "sync" && r.pinnedHere === false),
  // No durable copy anywhere we can see: present locally, no sync decision, no device claims a pin,
  // and no foreign pin discovered. Lose this disk, lose the file (cli.mdx §4.2).
  not_backed_up: (r) =>
    r.presence !== "remote-only" &&
    r.decision !== "sync" &&
    (r.peers?.length ?? 0) === 0 &&
    r.pinnedForeign !== true &&
    r.analysisOnly !== true,
  transcribe: (r) => r.transcribe === "could",
  describe: (r) => r.describe === "could",
  ocr: (r) => r.ocr === "could",
};

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** True when `child` is `parent` or lives underneath it. Pure string containment on resolved paths. */
function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** A unit participates when the scope covers it, it sits inside the scope, or the scope sits inside it. */
function unitInScope(root: string, scope: string | "all"): boolean {
  if (scope === "all") return true;
  return isUnder(root, scope) || isUnder(scope, root);
}

/**
 * The "get file list" query (cli.mdx §4.5). `scope` is a resolved absolute path (a repo, a directory
 * inside one, a personal-files path — always recursive) or the literal "all" for every tracked root.
 * Returns only categories with ≥1 match, paths absolute and sorted. Implements cli.mdx §4 —
 * `listFilesByCategory()`.
 */
export async function listFilesByCategory(
  rawScope: string,
  keys: FilesListCategoryKey[],
): Promise<FilesListResult> {
  const scope = rawScope === "all" ? ("all" as const) : expandHome(rawScope);
  const wanted = keys.length ? keys : FILES_LIST_CATEGORY_KEYS;
  const buckets = new Map<FilesListCategoryKey, Set<string>>(wanted.map((k) => [k, new Set()]));
  let unitsSearched = 0;

  // Live pin reality fetched ONCE for the whole query (same pattern as repos.router repoDetailWithPins):
  // a down/slow IPFS node yields an undefined pinset and pull_down simply loses its pinnedHere===false
  // sub-signal (remote-only rows still match) — the query never blocks on the node.
  const health = await ipfs.health();
  let pinset: Set<string> | undefined;
  try {
    pinset = await ipfs.canonicalPinnedSet();
  } catch (e) {
    log.debug("files-query", `pinset fetch skipped: ${(e as Error).message}`);
  }

  // ── Repo units — all seven categories (cli.mdx §4.2) ───────────────────────
  for (const folder of listRepoFolders()) {
    const cfg = getRepoConfig(folder);
    if (!cfg.repo.path) continue;
    const root = expandHome(cfg.repo.path);
    if (!unitInScope(root, scope)) continue;
    unitsSearched++;
    let rows: FileRow[];
    try {
      rows = computeRepoDetail(folder, health, pinset).files;
    } catch (e) {
      log.warn("files-query", `row composition failed for repo ${folder}: ${(e as Error).message}`);
      continue;
    }
    for (const row of rows) {
      const abs = path.join(root, row.path);
      if (scope !== "all" && isUnder(scope, root) && !isUnder(abs, scope)) continue;
      for (const key of wanted) if (MATCH[key](row)) buckets.get(key)!.add(abs);
    }
  }

  // ── Directory storages (personal / company file areas) — the categories their fingerprint index
  // supports today: compress, transcribe, describe (cli.mdx §4.6). ignore is git-only (N/A here);
  // pull_down / not_backed_up / ocr join when the SDL index carries those signals.
  const page = listStoragesPage();
  const sdlRows = [page.personal, ...page.companies].filter(
    (r): r is NonNullable<typeof r> => r !== null && r.root !== "" && r.hasLfbridge,
  );
  for (const storage of sdlRows) {
    const root = expandHome(storage.root);
    if (!unitInScope(root, scope)) continue;
    unitsSearched++;
    for (const f of readStorageIndex(root, storage.type)) {
      const abs = path.join(root, f.path);
      if (scope !== "all" && isUnder(scope, root) && !isUnder(abs, scope)) continue;
      const kind = mediaKindForName(f.path);
      if (wanted.includes("compress") && f.compressible !== null) buckets.get("compress")!.add(abs);
      if (
        wanted.includes("transcribe") &&
        (kind === "video" || kind === "audio") &&
        !f.analysis.includes("transcript")
      )
        buckets.get("transcribe")!.add(abs);
      if (
        wanted.includes("describe") &&
        (kind === "video" || kind === "image") &&
        !f.analysis.includes("description")
      )
        buckets.get("describe")!.add(abs);
    }
  }

  const categories: FilesListCategory[] = wanted
    .map((key) => ({ key, title: TITLES[key], paths: [...buckets.get(key)!].sort() }))
    .filter((c) => c.paths.length > 0);
  return { scope: scope === "all" ? "all" : scope, unitsSearched, categories };
}

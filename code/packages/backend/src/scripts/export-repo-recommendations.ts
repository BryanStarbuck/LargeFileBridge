/**
 * Export one repo's recommendation lists to YAML (one_repo.mdx §3 metric tiles).
 *
 * The One-repo page shows a COUNT per tile but never a durable list — the popups re-derive the file
 * lists in the browser and they die with the tab. This script runs the SAME computation the page runs
 * (`computeRepoDetail` + `missingPinnedFromPeers`), applies the SAME per-tile predicates, and writes the
 * resulting file lists to a YAML file so the recommendations can be read, diffed, and acted on offline.
 *
 * The predicates here are deliberately copies of the two places that own them today —
 * `store-model/units.service.ts` `computeTaskMetrics` (backend tile counts) and
 * `frontend/src/pages/repos/metricWarnings.ts` `gitIgnoreCandidates` (client-side tile) — so a list
 * length here equals the number on the tile.
 *
 * Usage:
 *   pnpm --filter @lfb/backend exec tsx src/scripts/export-repo-recommendations.ts <repoPathOrName> <out.yaml>
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listRepoFolders, getRepoConfig, computeRepoDetail } from "../modules/store-model/units.service.js";
import { missingPinnedFromPeers } from "../modules/pin/pin.service.js";
import { compressInfo } from "../modules/fs/badges.js";
import { computerLabel } from "../modules/store-model/config.service.js";
import { getAppConfig } from "../modules/store-model/config.service.js";
import * as ipfs from "../modules/ipfs/ipfs.service.js";
import type { FileRow, RepoDetail } from "@lfb/shared";

function expand(p: string): string {
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** Find the state-root folder key for a repo given its working-tree path or its name. */
function resolveFolder(target: string): string {
  const wanted = expand(target);
  const folders = listRepoFolders();
  for (const f of folders) {
    const cfg = getRepoConfig(f);
    const p = cfg.repo.path ? expand(cfg.repo.path) : "";
    if (p === wanted || cfg.repo.name === target || path.basename(p) === target) return f;
  }
  throw new Error(`no registered repo matches ${target} (${folders.length} repos known)`);
}

/** Absolute path for a repo-relative FileRow path. */
function absFor(root: string, rel: string): string {
  return path.join(root, rel);
}

async function main() {
  const [target, outArg] = process.argv.slice(2);
  if (!target || !outArg) throw new Error("usage: export-repo-recommendations.ts <repoPathOrName> <out.yaml>");
  const out = expand(outArg);

  const folder = resolveFolder(target);
  const cfg = getRepoConfig(folder);
  const root = expand(cfg.repo.path || "");

  const health = await ipfs.health();
  let pinset: Set<string> | undefined;
  try {
    pinset = await ipfs.canonicalPinnedSet();
  } catch {
    pinset = undefined; // node down → intent-only, exactly as the page degrades
  }
  const detail: RepoDetail = computeRepoDetail(folder, health, pinset);
  let missingPinned: Awaited<ReturnType<typeof missingPinnedFromPeers>> = [];
  try {
    missingPinned = await missingPinnedFromPeers(root);
  } catch {
    missingPinned = [];
  }

  const selfLabel = computerLabel();
  let checkedInThreshold = 52428800;
  try {
    checkedInThreshold = getAppConfig().big_file.checked_in_threshold_bytes;
  } catch {
    /* keep the 50 MB default */
  }

  const files = detail.files;
  // The decision/space tiles ignore analysis-only rows (scan rule 5) and remote-only rows.
  const local = (f: FileRow) => !f.analysisOnly && f.presence !== "remote-only";

  const entry = (f: FileRow) => ({
    path: absFor(root, f.path),
    size_bytes: f.sizeBytes,
    cid: f.cid,
    decision: f.decision,
  });

  const addToIpfs = files.filter(
    (f) =>
      !f.analysisOnly &&
      f.decision === "undecided" &&
      (f.presence === "remote-only" || !f.pinnedForeign),
  );
  const gitIgnore = files.filter(
    (f) => !f.gitignore && !f.gitignoreLocked && !f.analysisOnly && f.presence !== "remote-only",
  );
  const notBackedUp = files.filter(
    (f) => local(f) && f.decision === "sync" && f.cid != null && !f.peers.some((p) => p !== selfLabel),
  );
  const compressible = files.filter((f) => local(f) && f.compress === "could");
  const compressibleImages = compressible.filter(
    (f) => compressInfo(path.basename(f.path)).compressible === "image",
  );
  const compressibleVideos = compressible.filter(
    (f) => compressInfo(path.basename(f.path)).compressible !== "image",
  );
  const transcribable = files.filter((f) => f.transcribe === "could");
  const describable = files.filter((f) => f.describe === "could");
  const ocrable = files.filter((f) => f.ocr === "could");
  const bigNotIgnored = files.filter((f) => local(f) && !f.gitignore && f.sizeBytes >= checkedInThreshold);

  const doc = {
    repo: {
      name: detail.name,
      path: root,
      remote: cfg.repo.remote ?? null,
      computer: selfLabel,
      generated_by: "export-repo-recommendations.ts",
      file_rows: files.length,
    },
    counts: {
      add_to_ipfs: addToIpfs.length,
      git_ignore: gitIgnore.length,
      pull_down: missingPinned.length,
      not_backed_up: notBackedUp.length,
      compressible_videos: compressibleVideos.length,
      compressible_images: compressibleImages.length,
      transcribable: transcribable.length,
      ai_describable: describable.length,
      ocrable: ocrable.length,
      big_not_ignored: bigNotIgnored.length,
    },
    add_to_ipfs: addToIpfs.map(entry),
    git_ignore: gitIgnore.map(entry),
    pull_down: missingPinned.map((m) => ({
      path: absFor(root, m.path),
      size_bytes: m.sizeBytes,
      cid: m.cid,
      added_by_device: m.addedByDevice ?? null,
    })),
    not_backed_up: notBackedUp.map(entry),
    compressible_videos: compressibleVideos.map(entry),
    compressible_images: compressibleImages.map(entry),
    transcribable: transcribable.map(entry),
    ai_describable: describable.map(entry),
    ocrable: ocrable.map(entry),
    big_not_ignored: bigNotIgnored.map(entry),
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, YAML.stringify(doc), "utf8");
  console.log(`wrote ${out}`);
  console.log(JSON.stringify(doc.counts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

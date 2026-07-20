import path from "node:path";
import { computeRepoDetail, getRepoConfig, listRepoFolders, getRepoManifest } from "./modules/store-model/units.service.js";
import { missingPinnedFromPeers } from "./modules/pin/pin.service.js";
import { readStorageIndex } from "./modules/storage/tracking.service.js";
import { readSidecar } from "./modules/storage/file-sidecar.service.js";
import * as ipfs from "./modules/ipfs/ipfs.service.js";

function root(folder: string) {
  const p = getRepoConfig(folder).repo.path!;
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}
async function main() {
  const health = await ipfs.health();
  const pinset = health === "ok" ? await ipfs.canonicalPinnedSet() : undefined;
  const folders = listRepoFolders();
  let td = 0, tm = 0, ti = 0, ts = 0, tman = 0, rows = 0;
  const t0 = Date.now();
  for (const f of folders.slice(0, 25)) {
    try {
      let t = Date.now(); const d = computeRepoDetail(f, health, pinset); td += Date.now() - t;
      const r = root(f);
      t = Date.now(); await missingPinnedFromPeers(r); tm += Date.now() - t;
      t = Date.now(); getRepoManifest(f); tman += Date.now() - t;
      t = Date.now(); readStorageIndex(r); ti += Date.now() - t;
      t = Date.now(); for (const fr of d.files) readSidecar(r, fr.path); ts += Date.now() - t;
      rows += d.files.length;
    } catch (e) { /* skip */ }
  }
  console.log(JSON.stringify({ repos: 25, rows, totalMs: Date.now() - t0, computeRepoDetail: td, missingPinned: tm, manifest: tman, storageIndex: ti, sidecars: ts }, null, 2));
}
void main();

import { performance } from "node:perf_hooks";
import { listRepoFolders, getRepoConfig } from "./modules/store-model/units.service.js";
import { mirrorToSyncRepo, reconcileFromSyncRepo } from "./modules/storage/tracking-sync.service.js";

const folders = listRepoFolders();
console.log(`repos: ${folders.length}`);

const rows: Array<{ name: string; m1: number; m2: number; r1: number; r2: number }> = [];
for (const f of folders) {
  const root = getRepoConfig(f).repo.path;
  if (!root) continue;
  const t = (fn: () => void): number => { const s = performance.now(); try { fn(); } catch { /* */ } return performance.now() - s; };
  const m1 = t(() => mirrorToSyncRepo(root));
  const r1 = t(() => reconcileFromSyncRepo(root));
  const m2 = t(() => mirrorToSyncRepo(root));
  const r2 = t(() => reconcileFromSyncRepo(root));
  rows.push({ name: f, m1, m2, r1, r2 });
}
rows.sort((a, b) => (b.m2 + b.r2) - (a.m2 + a.r2));
console.log("\n  COLDm   COLDr    WARMm   WARMr   repo");
for (const r of rows.slice(0, 12)) {
  console.log(`${r.m1.toFixed(0).padStart(7)} ${r.r1.toFixed(0).padStart(7)}  ${r.m2.toFixed(0).padStart(7)} ${r.r2.toFixed(0).padStart(7)}   ${r.name}`);
}
const cold = rows.reduce((a, r) => a + r.m1 + r.r1, 0);
const warm = rows.reduce((a, r) => a + r.m2 + r.r2, 0);
console.log(`\nTOTAL across ${rows.length} repos:  COLD ${cold.toFixed(0)}ms   WARM ${warm.toFixed(0)}ms`);

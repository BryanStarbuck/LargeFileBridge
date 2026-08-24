import { listRepoFolders, getRepoStatus, getRepoConfig, getRepoManifest } from "./src/modules/store-model/units.service.js";
const folders = listRepoFolders();
console.log("folders", folders.length);
for (let pass = 0; pass < 4; pass++) {
  const t = process.hrtime.bigint();
  let rows = 0;
  for (const f of folders) {
    const s = getRepoStatus(f); rows += s.candidates.length;
    getRepoConfig(f); getRepoManifest(f);
  }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`pass ${pass}: ${ms.toFixed(1)} ms, candidates=${rows}`);
}

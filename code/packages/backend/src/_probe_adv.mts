import { readAllBatches, readBatchById } from "./modules/todo/todo-batches.store.js";
import { listManifests, readManifest } from "./modules/jobqueue/batch-manifest.service.js";

function t(label: string, fn: () => unknown) {
  const a = process.hrtime.bigint();
  const r = fn();
  const b = process.hrtime.bigint();
  console.log(`${label}: ${(Number(b - a) / 1e6).toFixed(2)} ms`, Array.isArray(r) ? `(${r.length})` : "");
  return r;
}

const b1 = t("readAllBatches COLD", () => readAllBatches()) as any[];
t("readAllBatches WARM #1", () => readAllBatches());
t("readAllBatches WARM #2", () => readAllBatches());
t("readAllBatches WARM #3", () => readAllBatches());
console.log("batch ids:", b1.map((b) => b.doc.id).join(", "));
const big = b1.find((b) => b.file === "repo_all_2_do.yaml");
console.log("repo_all items:", big?.doc.items?.length);
t("readBatchById(last) WARM", () => readBatchById(b1[b1.length - 1].doc.id));

const m1 = t("listManifests(200) #1", () => listManifests(200)) as any[];
t("listManifests(200) #2", () => listManifests(200));
t("listManifests(200) #3", () => listManifests(200));
console.log("manifests:", m1.map((m) => `${m.batchId.slice(0,8)}/${m.fileCount}/${m.terminalState}`).join(" "));
t("readManifest(big ocr)", () => readManifest(m1.find((m) => m.fileCount > 1000)!.batchId));

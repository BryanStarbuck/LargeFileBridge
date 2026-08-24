import { walkFilesFlatStreaming } from "./src/modules/fsindex/fsindex.service.js";
const t = Date.now();
let rows = 0;
const s = await walkFilesFlatStreaming(process.env.ROOT || "~", false, { onBatch: (b) => { rows += b.length; } });
console.log(JSON.stringify({ ms: Date.now() - t, rows, total: s.total, truncated: s.truncated, root: s.root, threshold: s.thresholdBytes }));

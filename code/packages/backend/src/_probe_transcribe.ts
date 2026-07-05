// TEMP probe — verifies the async engine runs non-blocking and streams progress. Deleted after use.
import { Transcriber } from "./tools/transcribe/Transcribe.js";

const input = process.argv[2];
const output = process.argv[3];
const engine = new Transcriber();

console.log("tools:", engine.toolStatus());

// Prove the event loop is NOT blocked: this heartbeat must keep printing while whisper runs.
let ticks = 0;
const hb = setInterval(() => console.log(`  [heartbeat ${++ticks}] event loop alive`), 1000);

const t0 = Date.now();
const r = await engine.transcribeToFile(input, output, ({ fraction, stage }) =>
  console.log(`  progress: ${stage} ${(fraction * 100).toFixed(0)}%`),
);
clearInterval(hb);
console.log(`RESULT (${((Date.now() - t0) / 1000).toFixed(1)}s):`, r);

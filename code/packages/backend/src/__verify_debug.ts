import fs from "node:fs";
import YAML from "yaml";
const f = process.env.HOME + "/BGit/Bryan_git/personal_large_files_bridge/debug/bryan-mac-pro/debug.yaml";
const d = YAML.parse(fs.readFileSync(f, "utf8"));
const bad: string[] = [];
for (const k of Object.keys(d.counts)) {
  if (!Array.isArray(d.metrics[k])) bad.push(`${k}: metric list MISSING`);
  else if (d.metrics[k].length !== d.counts[k]) bad.push(`${k}: count ${d.counts[k]} != list ${d.metrics[k].length}`);
}
const missingKey = Object.keys(d.metrics).filter((k) => !Array.isArray(d.metrics[k]));
console.log("AC-9 count===length:", bad.length ? "FAIL " + bad.join("; ") : "PASS");
console.log("AC-7 all metrics present as arrays:", missingKey.length ? "FAIL" : `PASS (${Object.keys(d.metrics).length} metrics)`);
const req = ["path","repo","rel","size_bytes","cid","decision"];
let missField = 0;
for (const k of Object.keys(d.metrics)) for (const e of d.metrics[k]) for (const r of req) if (!(r in e)) missField++;
console.log("AC-8 required fields on every entry:", missField ? `FAIL (${missField})` : "PASS");
const abs = Object.values(d.metrics).flat().filter((e: any) => !e.path.startsWith("/")).length;
console.log("AC-8 path absolute:", abs ? `FAIL (${abs})` : "PASS");
console.log("units:", d.units.length, "| units with remote:", d.units.filter((u: any) => u.remote).length);
console.log("\npull_down sample:", JSON.stringify(d.metrics.pull_down.slice(0,2), null, 1));
console.log("\nnot_backed_up sample:", JSON.stringify(d.metrics.not_backed_up.slice(0,1), null, 1));

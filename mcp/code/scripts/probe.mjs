// Hand probe (pm/mcp.mdx §15): spawn the BUILT server exactly as Claude Code does, over stdio, and drive a
// few tools against the live local backend. Usage: node scripts/probe.mjs [dir-to-scan] [file-a] [file-b]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, a, b] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "../dist/index.js"), "serve"], stderr: "inherit" });
const client = new Client({ name: "lfb-probe", version: "0" });
await client.connect(transport);
const show = (label, r) => {
  const txt = r.content?.[0]?.text ?? "";
  console.log(`\n=== ${label}${r.isError ? " (isError)" : ""} — ${txt.length} bytes\n${txt.slice(0, 1400)}`);
  try { return JSON.parse(txt); } catch { return null; }
};
const call = async (name, args) => show(name, await client.callTool({ name, arguments: args }));

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
console.log("instructions chars:", client.getInstructions()?.length);
await call("lfb_whoami", {});
if (a) await call("lfb_fingerprint_files", { paths: [a, b].filter(Boolean) });
if (a && b) await call("lfb_fingerprint_compare", { a, b });
if (dir) {
  const r = await call("lfb_fingerprint_directory", { dir, wait_seconds: 50 });
  let job = r?.data;
  while (job?.pending) job = (await call("lfb_fingerprint_job", { job_id: job.job_id, wait_seconds: 50, limit: 5 }))?.data;
  if (job) await call("lfb_fingerprint_export_csv", { job_id: job.job_id });
}
await call("lfb_fingerprint_files", { paths: ["/definitely/not/here.png"] });
await call("lfb_fingerprint_export_csv", {});
await client.close();

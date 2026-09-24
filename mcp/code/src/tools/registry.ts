// The ONE list of tools (pm/mcp.mdx §8). Names are unique and all carry the lfb_ prefix; the check runs at
// import, so a duplicate or an unprefixed name fails the build's smoke test rather than shipping.
import { FINGERPRINT_TOOLS } from "./fingerprints.js";
import { filesList, whoami } from "./orientation.js";
import type { ToolDef } from "./types.js";

export const TOOLS: ToolDef[] = [whoami, ...FINGERPRINT_TOOLS, filesList] as ToolDef[];

const seen = new Set<string>();
for (const t of TOOLS) {
  if (!t.name.startsWith("lfb_")) throw new Error(`tool ${t.name} lacks the lfb_ prefix`);
  if (seen.has(t.name)) throw new Error(`duplicate tool name ${t.name}`);
  seen.add(t.name);
}

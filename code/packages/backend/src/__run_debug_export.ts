import { resolveDebugTarget, exportDebugInfo } from "./modules/debug/debug-export.service.js";
async function main() {
  console.log("TARGET:", JSON.stringify(resolveDebugTarget(), null, 2));
  const r = await exportDebugInfo({ scope: "computer", invokedFrom: "settings" });
  console.log("RESULT:", JSON.stringify(r, null, 2));
}
void main();

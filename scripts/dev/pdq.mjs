// Build the PDQ fingerprint sidecar (code/sidecars/pdq → code/sidecars/pdq/bin/lfb-pdq) and the MCP server
// (mcp/code → mcp/code/dist/index.js), and print the Claude Code registration line. Portable: node + go +
// pnpm only (justfile rule 1).
//
//   node scripts/dev/pdq.mjs build        build the Go sidecar (skips with a warning when Go is missing)
//   node scripts/dev/pdq.mjs mcp-build    install + build the MCP server bundle
//   node scripts/dev/pdq.mjs mcp-register print (and with --apply, run) `claude mcp add lfb …`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sidecarDir = path.join(root, "code", "sidecars", "pdq");
const exe = process.platform === "win32" ? "lfb-pdq.exe" : "lfb-pdq";
const bin = path.join(sidecarDir, "bin", exe);
const mcpCode = path.join(root, "mcp", "code");
const mcpEntry = path.join(mcpCode, "dist", "index.js");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.error) return { ok: false, why: r.error.message };
  return { ok: r.status === 0, why: `exit ${r.status}` };
}

function has(cmd) {
  const r = spawnSync(cmd, ["version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !r.error && r.status === 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "build") {
  if (!has("go")) {
    console.error(
      "WARN: Go is not installed, so the PDQ fingerprint engine was not built.\n" +
        "      Install it (macOS: brew install go · Linux: your package manager · Windows: winget install GoLang.Go),\n" +
        "      then run: just build-pdq. Everything else in Large File Bridge works without it.",
    );
    process.exit(0);
  }
  const r = run("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", bin, "."], { cwd: sidecarDir, env: { ...process.env, CGO_ENABLED: "0" } });
  if (!r.ok) {
    console.error(`ERROR: go build of the PDQ sidecar failed (${r.why}).`);
    process.exit(1);
  }
  console.log(`PDQ sidecar built: ${bin}`);
} else if (cmd === "mcp-build") {
  let r = run("pnpm", ["-C", mcpCode, "install"]);
  if (r.ok) r = run("pnpm", ["-C", mcpCode, "build"]);
  if (!r.ok) {
    console.error(`ERROR: building the MCP server failed (${r.why}).`);
    process.exit(1);
  }
  console.log(`MCP server built: ${mcpEntry}`);
} else if (cmd === "mcp-register") {
  if (!fs.existsSync(mcpEntry)) {
    console.error("The MCP server is not built yet — run: just build-mcp");
    process.exit(1);
  }
  const args = ["mcp", "add", "--scope", "user", "lfb", "--", "node", mcpEntry, "serve"];
  console.log(`claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  if (rest.includes("--apply")) {
    const r = run("claude", args);
    if (!r.ok) {
      console.error(`claude mcp add failed (${r.why}). If "lfb" is already registered: claude mcp remove lfb --scope user, then retry.`);
      process.exit(1);
    }
  } else {
    console.log("(printed only — run `just mcp-register apply` to register it with Claude Code)");
  }
} else {
  console.error("usage: node scripts/dev/pdq.mjs build | mcp-build | mcp-register [--apply]");
  process.exit(1);
}

#!/usr/bin/env node
// Large File Bridge CLI shim — the callable top level (pm/cli.mdx §1.1), in Node so it is the same shim
// on macOS, Linux and Windows.
//
// It was a bash script (`cli/lfb`), which meant the CLI simply did not exist on Windows: no bash, and
// `find -newer` for the staleness check. Everything real still lives in cli/code/; this only self-builds
// when dist/ is missing or stale, then runs it. `cli/lfb` and `cli/lfb.cmd` are one-line delegates to
// this file, so `./lfb …` keeps working in a POSIX shell and `lfb …` works in cmd/PowerShell.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runTool } from "../scripts/dev/proc.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.join(dir, "code");
const main = path.join(codeDir, "dist", "main.js");

/** Any source newer than the built entry — the same cheap check `find -newer` was doing. */
function needsBuild() {
  let builtAt;
  try {
    builtAt = fs.statSync(main).mtimeMs;
  } catch {
    return true; // never built
  }
  const stack = [path.join(codeDir, "src")];
  while (stack.length) {
    let entries;
    try {
      entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      try {
        if (fs.statSync(full).mtimeMs > builtAt) return true;
      } catch {
        /* vanished mid-walk — not our problem */
      }
    }
  }
  return false;
}

if (needsBuild()) {
  process.stderr.write("Building the Large File Bridge CLI…\n");
  // Build chatter goes to stderr so a piped `lfb … | …` still sees only the CLI's own stdout.
  const install = await runTool("pnpm", ["-C", codeDir, "install", "--silent"], { stdio: ["ignore", 2, 2] });
  const build = install === 0 ? await runTool("pnpm", ["-C", codeDir, "build"], { stdio: ["ignore", 2, 2] }) : install;
  if (build !== 0) {
    process.stderr.write("The Large File Bridge CLI could not be built.\n");
    process.exit(build);
  }
}

const child = spawn(process.execPath, [main, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
child.on("exit", (code, signal) => process.exit(typeof code === "number" ? code : signal ? 1 : 0));

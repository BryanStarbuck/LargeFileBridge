// Large File Bridge CLI (`lfb`) — entry point (pm/cli.mdx). A thin wrapper: parse arguments,
// ensure the server is up (cli.mdx §2), ensure the shared API secret (cli.mdx §3), make ONE REST
// call, render. No business logic lives here — the backend computes every answer (cli.mdx §1).
import os from "node:os";
import path from "node:path";
import { apiGet, backendHealthy, backendPort, type FilesListResult } from "./client";
import { ensureServerUp } from "./bringup";
import { renderFlat, renderTree } from "./render";

// Piping into `head` (etc.) closes stdout early — that is a normal way to consume a list CLI, not
// an error. Exit clean on EPIPE instead of crashing with a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const CATEGORY_FLAGS: Record<string, string> = {
  "--compress": "compress",
  "--ignore": "ignore",
  "--pull-down": "pull_down",
  "--not-backed-up": "not_backed_up",
  "--transcribe": "transcribe",
  "--describe": "describe",
  "--ocr": "ocr",
};

const HELP = `Large File Bridge CLI

Usage:
  lfb files [PATH] [--all] [category flags] [--tree] [--bare]
  lfb up          Bring the web app up (build if needed) and wait for /api/health
  lfb status      Report backend health and the web app port
  lfb help        Show this help

files — the "get file list" family (pm/cli.mdx §4). Scope is PATH and everything
below it, recursively (default: the current directory); --all covers every root
Large File Bridge tracks. Category flags (combine freely; none = all categories,
each printed under a title header, two blank lines between blocks):
  --compress        Video/image files that look uncompressed
  --ignore          Big files that are NOT git-ignored yet
  --pull-down       On your other computers, missing here
  --not-backed-up   No IPFS pin anywhere — no durable copy
  --transcribe      Audio/video with no transcription yet
  --describe        Video/image with no AI description yet
  --ocr             Image/video/PDF with no OCR text yet
Output: full absolute paths (pipe-friendly; counts go to stderr).
  --tree            Hierarchical tree of only the matching files
  --bare            Suppress the title headers
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

async function cmdFiles(args: string[]): Promise<void> {
  let scopeArg: string | null = null;
  let all = false;
  let tree = false;
  let bare = false;
  const categories: string[] = [];
  for (const a of args) {
    if (a === "--all") all = true;
    else if (a === "--tree") tree = true;
    else if (a === "--bare") bare = true;
    else if (a in CATEGORY_FLAGS) categories.push(CATEGORY_FLAGS[a]);
    else if (a === "-h" || a === "--help") return void process.stdout.write(HELP);
    else if (a.startsWith("-")) fail(`Unknown flag: ${a}\n\n${HELP}`);
    else if (scopeArg) fail(`Only one PATH may be given (got "${scopeArg}" and "${a}").`);
    else scopeArg = a;
  }
  if (all && scopeArg) fail("--all and a PATH are mutually exclusive (pm/cli.mdx §4.1).");
  const scope = all
    ? "all"
    : path.resolve((scopeArg ?? process.cwd()).replace(/^~(?=\/|$)/, os.homedir()));

  if (!(await ensureServerUp())) process.exit(1);

  const qs = new URLSearchParams({ scope });
  if (categories.length) qs.set("categories", categories.join(","));
  const result = await apiGet<FilesListResult>(`/files/list?${qs.toString()}`);

  if (!result.categories.length) {
    if (result.unitsSearched === 0 && scope !== "all") {
      fail(
        `Large File Bridge does not track anything under ${scope} — add it as a repo or storage in the web app first.`,
      );
    }
    process.stderr.write("No matching files.\n");
    return;
  }
  (tree ? renderTree : renderFlat)(result.categories, bare);
}

async function cmdStatus(): Promise<void> {
  const healthy = await backendHealthy();
  process.stdout.write(`backend  :${backendPort()} ${healthy ? "UP (health OK)" : "DOWN"}\n`);
  try {
    const fs = await import("node:fs");
    const port = fs.readFileSync("/tmp/lfb.web.port", "utf8").trim();
    process.stdout.write(`web app  :${port} (last recorded port)\n`);
  } catch {
    process.stdout.write("web app  port not recorded (/tmp/lfb.web.port absent)\n");
  }
  if (!healthy) process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "files":
      return cmdFiles(rest);
    case "up":
      process.exit((await ensureServerUp()) ? 0 : 1);
      break;
    case "status":
      return cmdStatus();
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});

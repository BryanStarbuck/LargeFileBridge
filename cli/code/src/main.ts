// Large File Bridge CLI (`lfb`) — entry point (pm/cli.mdx). A thin wrapper: parse arguments,
// ensure the server is up (cli.mdx §2), ensure the shared API secret (cli.mdx §3), make ONE REST
// call, render. No business logic lives here — the backend computes every answer (cli.mdx §1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiGet, backendHealthy, backendPort, logInvocation, type FilesListResult } from "./client";
import { ensureServerUp } from "./bringup";
import { renderFlat, renderTree } from "./render";
import { Spinner } from "./progress";

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
  lfb [PATH] [--tree]   List EVERY file under PATH (default: the current
                        directory), recursively. All file types, any directory —
                        a tracked repo, an untracked folder, anywhere. Skips
                        .git, node_modules, build outputs, hidden files, and
                        macOS app bundles.
  lfb files [PATH] [--all] [category flags] [--everything] [--tree] [--bare]
                        The "get file list" family (pm/cli.mdx §4): files
                        matching task categories, computed by the web app.
  lfb up                Bring the web app up (build if needed) and wait for /api/health
  lfb status            Report backend health and the web app port
  lfb help              Show this help (also: -h, --help)

Scope is PATH and everything below it, recursively — always; --all covers every
root Large File Bridge tracks instead of a path.

Category flags (combine freely; none = all categories, each printed under a
title header, two blank lines between blocks):
  --compress        Video/image files that look uncompressed
  --ignore          Big files that are NOT git-ignored yet
  --pull-down       On your other computers, missing here
  --not-backed-up   No IPFS pin anywhere — no durable copy
  --transcribe      Audio/video with no transcription yet
  --describe        Video/image with no AI description yet
  --ocr             Image/video/PDF with no OCR text yet
  --everything      Not a category: EVERY file in the scope — what bare \`lfb\`
                    runs. Cannot combine with the category flags above.

Output: full absolute paths on stdout (pipe-friendly; counts, progress, and
diagnostics go to stderr — a spinner shows while a slow answer is computed).
  --tree            Hierarchical tree of only the matching files
  --bare            Suppress the title headers

The \`files\` word is optional: \`lfb --compress\` = \`lfb files --compress\`,
\`lfb ~/Videos --tree\` = the full listing of ~/Videos as a tree.
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

async function cmdFiles(args: string[], opts: { defaultEverything?: boolean } = {}): Promise<void> {
  let scopeArg: string | null = null;
  let all = false;
  let tree = false;
  let bare = false;
  let everything = false;
  const categories: string[] = [];
  for (const a of args) {
    if (a === "--all") all = true;
    else if (a === "--tree") tree = true;
    else if (a === "--bare") bare = true;
    else if (a === "--everything") everything = true;
    else if (a in CATEGORY_FLAGS) categories.push(CATEGORY_FLAGS[a]);
    else if (a === "-h" || a === "--help") return void process.stdout.write(HELP);
    else if (a.startsWith("-")) fail(`Unknown flag: ${a}\n\n${HELP}`);
    else if (scopeArg) fail(`Only one PATH may be given (got "${scopeArg}" and "${a}").`);
    else scopeArg = a;
  }
  if (all && scopeArg) fail("--all and a PATH are mutually exclusive (pm/cli.mdx §4.1).");
  if (everything && categories.length)
    fail("--everything lists every file — it cannot be combined with category flags (pm/cli.mdx §4.2).");
  // Bare `lfb` (no `files` word, no category flags) defaults to the full listing (cli.mdx §4.0);
  // an explicit `lfb files` with no flags keeps the all-categories default (§4.2, LOCKED).
  if (opts.defaultEverything && !categories.length) everything = true;
  const scope = all
    ? "all"
    : path.resolve((scopeArg ?? process.cwd()).replace(/^~(?=\/|$)/, os.homedir()));

  if (!(await ensureServerUp())) process.exit(1);

  const qs = new URLSearchParams({ scope });
  if (everything) qs.set("mode", "everything");
  else if (categories.length) qs.set("categories", categories.join(","));
  const started = Date.now();
  const spinner = new Spinner();
  spinner.start(
    everything
      ? `Listing every file under ${scope === "all" ? "every tracked root" : scope}…`
      : "Asking Large File Bridge for the file list…",
  );
  let result: FilesListResult;
  try {
    result = await apiGet<FilesListResult>(`/files/list?${qs.toString()}`);
  } finally {
    spinner.stop(); // cleanup contract (cli.mdx §4.7): no spinner residue before results OR errors
  }
  const matched = result.categories.reduce((n, c) => n + c.paths.length, 0);
  await logInvocation(
    `files scope=${scope} mode=${everything ? "everything" : "categories"} categories=${categories.join(",") || "all"} units=${result.unitsSearched} matched=${matched} durationMs=${Date.now() - started}`,
  );

  if (!result.categories.length) {
    // Category queries need a tracked scope; the everything walk works anywhere (cli.mdx §4.0).
    if (!everything && result.unitsSearched === 0 && scope !== "all") {
      fail(
        `Large File Bridge does not track anything under ${scope} — add it as a repo or storage in the web app first.`,
      );
    }
    process.stderr.write(everything ? "No files found.\n" : "No matching files.\n");
    return;
  }
  if (result.truncated) {
    process.stderr.write(
      "Note: the listing stopped at the 200,000-file cap — narrow the scope for a complete list.\n",
    );
  }
  // The everything listing is one implicit block — headers exist to separate categories (§4.0).
  (tree ? renderTree : renderFlat)(result.categories, bare || everything);
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

/** A first argument that reads as a filesystem path, not a command word (cli.mdx §4.0). */
function isPathish(a: string): boolean {
  if (a.startsWith("/") || a.startsWith("~") || a.startsWith(".") || a.includes(path.sep)) return true;
  try {
    return fs.existsSync(a);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "files":
      return cmdFiles(rest);
    case "up":
      process.exit((await ensureServerUp()) ? 0 : 1);
      break;
    case "status":
      return cmdStatus();
    case undefined:
      // Bare `lfb`: the zero-argument default — every file under the cwd, recursively (cli.mdx §4.0).
      return cmdFiles([], { defaultEverything: true });
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      // `lfb <path>` / `lfb --flag …` route to the files machinery without the `files` word (§4.0).
      if (cmd.startsWith("-") || isPathish(cmd)) return cmdFiles(argv, { defaultEverything: true });
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});

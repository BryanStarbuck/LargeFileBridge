// Large File Bridge CLI (`lfb`) — entry point (pm/cli.mdx). A thin wrapper: parse arguments,
// ensure the server is up (cli.mdx §2), ensure the shared API secret (cli.mdx §3), make ONE REST
// call, render. No business logic lives here — the backend computes every answer (cli.mdx §1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiGet, apiPost, backendHealthy, backendPort, logInvocation, type FilesListResult } from "./client";
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

const HELP = `Large File Bridge CLI — large git-ignored files: list them, sync them over
IPFS, and create transcriptions, AI descriptions, and OCR text for them.

USAGE
  lfb [PATH] [--tree]   List EVERY file under PATH (default: the current
                        directory), recursively. All file types, any directory —
                        a tracked repo, an untracked folder, anywhere. Skips
                        .git, node_modules, build outputs, hidden files, and
                        macOS app bundles.
  lfb files [PATH] [--all] [category flags] [--everything] [--tree] [--bare]
                        The "get file list" family (pm/cli.mdx §4): files
                        matching task categories, computed by the web app.
  lfb transcription FILE [--create] [--overwrite] [--text]
                        Print the path of FILE's transcription (.transcription
                        sidecar). --create makes it first if it does not exist.
                        (alias: lfb transcribe FILE)
  lfb description FILE [--create] [--overwrite] [--text]
                        Same for the AI visual description (.ai_description).
                        (alias: lfb describe FILE)
  lfb ocr FILE [--create] [--overwrite] [--text]
                        Same for the on-screen/OCR text (.ocr sidecar).
  lfb up                Bring the web app up (build if needed) and wait for /api/health
  lfb status            Report backend health and the web app port
  lfb help              Show this help (also: -h, --help)

FILE LISTS (lfb / lfb files)
  Scope is PATH and everything below it, recursively — always; --all covers
  every root Large File Bridge tracks instead of a path.

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

ARTIFACTS (lfb transcription / description / ocr)
  Each command answers one question about ONE media file: where is its derived
  text artifact? stdout is exactly one line — the artifact's absolute path — so
  it composes: \`cat "$(lfb transcription video.mp4)"\`.

    (no flag)         Locate only. Prints the artifact path if it exists;
                      if not, says so on stderr and exits 1 (nothing is created).
    --create          Create the artifact if it is missing (the web app backend
                      does the work; a spinner + elapsed time shows on stderr),
                      then print its path. If it already exists, just prints the
                      path — safe to run repeatedly.
    --overwrite       Regenerate even if the artifact exists (implies --create).
    --text            Print the artifact's TEXT CONTENT on stdout instead of
                      its path.

  Examples:
    lfb transcription ~/videos/demo.mp4              # where is the transcript?
    lfb transcription ~/videos/demo.mp4 --create     # make it if needed, print path
    lfb description  poster.png --create --text      # AI description text itself
    lfb ocr contract.pdf --create                    # OCR a PDF, print sidecar path

Large File Bridge runs everything through its local web app; if the app is not
running, the CLI starts it automatically and waits for it to become healthy.
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

// ── Artifact commands: transcription / description / ocr (cli.mdx §9) ──────────────────────────
// One media file in, one line out: the absolute path of its derived-text sidecar (or, with --text,
// the text itself). The backend owns ALL the work — the CLI only calls GET/POST /api/<kind>/file.

interface ArtifactKind {
  /** REST segment: /api/<api>/file */
  api: string;
  /** Plain-English noun for messages ("transcription", "AI description", "OCR text"). */
  noun: string;
  /** Field naming the sidecar path in both the read view and the create result. */
  pathField: string;
  /** Successful create statuses (anything else with no artifact path is a failure to explain). */
  createdStatus: string[];
}
const ARTIFACT_KINDS: Record<string, ArtifactKind> = {
  transcription: { api: "transcribe", noun: "transcription", pathField: "transcriptPath", createdStatus: ["transcribed", "skipped"] },
  description: { api: "describe", noun: "AI description", pathField: "descriptionPath", createdStatus: ["described", "skipped"] },
  ocr: { api: "ocr", noun: "OCR text", pathField: "ocrPath", createdStatus: ["ocred", "skipped"] },
};
/** Command-word aliases: the verb forms route to the same commands (cli.mdx §9.1). */
const ARTIFACT_ALIASES: Record<string, string> = { transcribe: "transcription", describe: "description" };

interface ArtifactView {
  mediaPath: string;
  text: string;
  /** describe only: set when the provider REFUSED the file — there IS no description. */
  rejection?: { reason?: string | null } | null;
  [k: string]: unknown;
}
interface ArtifactResult {
  path: string;
  status: string;
  reason: string | null;
  [k: string]: unknown;
}

async function cmdArtifact(kindWord: string, args: string[]): Promise<void> {
  const kind = ARTIFACT_KINDS[ARTIFACT_ALIASES[kindWord] ?? kindWord];
  let fileArg: string | null = null;
  let create = false;
  let overwrite = false;
  let text = false;
  for (const a of args) {
    if (a === "--create") create = true;
    else if (a === "--overwrite") { overwrite = true; create = true; }
    else if (a === "--text") text = true;
    else if (a === "-h" || a === "--help") return void process.stdout.write(HELP);
    else if (a.startsWith("-")) fail(`Unknown flag: ${a}\n\n${HELP}`);
    else if (fileArg) fail(`Only one FILE may be given (got "${fileArg}" and "${a}").`);
    else fileArg = a;
  }
  if (!fileArg) fail(`A media file is required: lfb ${kindWord} FILE [--create] [--overwrite] [--text]`);
  const abs = path.resolve(fileArg.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(abs)) fail(`No such file: ${abs}`);

  if (!(await ensureServerUp())) process.exit(1);
  const started = Date.now();
  const q = encodeURIComponent(abs);

  const finish = async (view: ArtifactView, how: "found" | "created"): Promise<void> => {
    const artifactPath = view[kind.pathField] as string;
    await logInvocation(
      `${kindWord} file=${abs} outcome=${how} artifact=${artifactPath} durationMs=${Date.now() - started}`,
    );
    process.stdout.write(`${text ? view.text : artifactPath}\n`);
  };

  // 1. Locate: does the artifact already exist? (GET /api/<kind>/file — a pure read.)
  let view = await apiGet<ArtifactView | null>(`/${kind.api}/file?path=${q}`);
  if (view?.rejection && !overwrite) {
    // AI description only: the provider considered the file and REFUSED it — recorded, never
    // auto-retried. --overwrite is the explicit "ask again" (it repeats the verdict most times).
    fail(
      `The AI provider rejected this file (${view.rejection.reason ?? "no reason recorded"}) — there is no ${kind.noun}.\n` +
        `Re-ask anyway with: lfb ${kindWord} "${abs}" --overwrite`,
    );
  }
  if (view && !view.rejection && !overwrite) return finish(view, "found");

  if (!create) {
    await logInvocation(`${kindWord} file=${abs} outcome=missing durationMs=${Date.now() - started}`);
    fail(`No ${kind.noun} exists yet for ${abs}\nCreate it with: lfb ${kindWord} "${abs}" --create`);
  }

  // 2. Create: POST /api/<kind>/file does the real work in the backend and answers when done.
  const spinner = new Spinner();
  spinner.start(`Creating the ${kind.noun} with Large File Bridge… (this can take a while for long media)`);
  let result: ArtifactResult;
  try {
    result = await apiPost<ArtifactResult>(`/${kind.api}/file`, { path: abs, overwrite });
  } finally {
    spinner.stop();
  }
  const artifactPath = result[kind.pathField] as string | null;
  if (!kind.createdStatus.includes(result.status) || !artifactPath) {
    await logInvocation(
      `${kindWord} file=${abs} outcome=${result.status} reason=${result.reason ?? ""} durationMs=${Date.now() - started}`,
    );
    const hint =
      result.status === "needs_setup"
        ? "\nOpen the Large File Bridge web app once to set up Personal storage, then retry."
        : "";
    fail(`Could not create the ${kind.noun} (${result.status}${result.reason ? `: ${result.reason}` : ""}).${hint}`);
  }
  // Re-read so --text prints the fresh content through the same view shape as the locate path.
  view = await apiGet<ArtifactView | null>(`/${kind.api}/file?path=${q}`);
  if (!view) fail(`The ${kind.noun} was written to ${artifactPath} but could not be read back.`);
  return finish(view, "created");
}

/**
 * Where the web app publishes the port it resolved on boot. `/tmp` verbatim on macOS and Linux; on
 * Windows there is no /tmp (Node reads it as `<drive>:\tmp`, which does not exist), so the platform's own
 * temp dir. Kept in lockstep BY HAND with scripts/dev/paths.mjs `runtimeDir()` — the authority — and with
 * the writer, packages/frontend/scripts/web-port.mjs `PORT_FILE`; this package compiles standalone and
 * cannot import either.
 */
function webPortFile(): string {
  const runtime = process.env.LFB_RUNTIME_DIR || (process.platform === "win32" ? os.tmpdir() : "/tmp");
  return path.join(runtime, "lfb.web.port");
}

async function cmdStatus(): Promise<void> {
  const healthy = await backendHealthy();
  process.stdout.write(`backend  :${backendPort()} ${healthy ? "UP (health OK)" : "DOWN"}\n`);
  try {
    const port = fs.readFileSync(webPortFile(), "utf8").trim();
    process.stdout.write(`web app  :${port} (last recorded port)\n`);
  } catch {
    process.stdout.write(`web app  port not recorded (${webPortFile()} absent)\n`);
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
    case "transcription":
    case "transcribe":
    case "description":
    case "describe":
    case "ocr":
      return cmdArtifact(cmd, rest);
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

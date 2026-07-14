// AI DESCRIPTION service (ai_description.mdx). Generates a hyper-detailed, searchable description of a
// local image/video by calling a vision provider (adapters.ts) with the kind's prompt (prompts.ts), and
// stores the result as a SIDECAR BESIDE the media — the media's own base name with its extension replaced
// by `.ai_description` (ai_description.mdx §2), mirrored under the owning storage's placement root (no
// .lfbridge/analysis/ directory). The storage file table's "description" indicator detects that same
// sidecar (tracking.service.analysisOutputs). The placement root is resolved exactly like transcription
// (nearest ancestor with storage.yaml / .lfbridge / .git, else dedicated repo, else storage root, else
// beside the media). Explicit-user-action only.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DescribeKind, DescribeResult, DescribeBatchResult, DescribeView, DescribeProvidersStatus, DescribeAiConfig, DescribeAiConfigPatch, AiCredentialsInfo, EnqueuePlan, PreviewPlan } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { expandHome } from "../fs/badges.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { appConfigPath } from "../../shared/store/scopes.js";
import { googleApiKeyFileInfo } from "../../config/google-apikey-file.js";
import { resolveArtifactPlacement, artifactPathForPlacement, AI_DESCRIPTION_EXT } from "../storage/artifact-placement.service.js";
import { markDurableArtifact } from "../storage/tracking-root.service.js";
import { repoArtifactPlacement } from "../store-model/units.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { getPrompt } from "./prompts.js";
import { selectAdapter, providerStatus, providerKeySources, providerMeta, mimeForMedia, type ProviderId } from "./adapters.js";
import { fitMediaUnderLimit } from "./fit-media.js";
import { log } from "../../shared/logging.js";

// Directories a "describe all" walk never descends into: the SAME hard-skip set as the discovery scan
// and FS browser (scan.mdx §4 invariant — build/, dist/, node_modules, … duplicate source media), plus
// the artifact dirs (mirrors transcribe's SKIP_DIRS).
const SKIP_DIRS = new Set([...HARD_SKIP, ".lfbridge", ".transcribe"]);

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** <root>/<rel-without-ext>.ai_description — the description sidecar beside the media, resolved by the
 *  shared ordered placement rule (Transcribe.mdx §3.4) so it routes to the owning storage's dedicated repo
 *  exactly like a transcript (Transcribe.mdx §3.1) — inside the committed `.lfbridge/`, path-mirrored, ext
 *  APPENDED. Carries the first-time-setup flag. Committed, so no `*.ai_description` gitignore nudge. */
export function resolveDescriptionPath(absFile: string): {
  root: string;
  rel: string;
  descriptionPath: string;
  needsSetup: boolean;
} {
  const p = resolveArtifactPlacement(absFile);
  // Honor the repo's AI-description placement radio (repo_settings.mdx §5) — the mirror of transcription.
  const placement = repoArtifactPlacement(p.root, "aiDescription");
  const descriptionPath = artifactPathForPlacement(p.root, p.rel, AI_DESCRIPTION_EXT, placement);
  return { root: p.root, rel: p.rel, descriptionPath, needsSetup: p.needsSetup };
}

/** Only image + video are describable here (audio → transcription covers it). */
function describeKindFor(name: string): DescribeKind | null {
  const k = mediaKindForName(name);
  return k === "image" || k === "video" ? k : null;
}

/** The existing generated description for a media file (text + model + when), or null if none/skeleton. */
export function readDescription(input: string): DescribeView | null {
  const abs = path.resolve(expandHome(input.trim()));
  const { descriptionPath } = resolveDescriptionPath(abs);
  if (!exists(descriptionPath)) return null;
  try {
    const doc = (YAML.parse(fs.readFileSync(descriptionPath, "utf8")) ?? {}) as {
      status?: string;
      engine?: string | null;
      generated?: string | null;
      description?: string | null;
    };
    if (!doc.description || typeof doc.description !== "string" || doc.status !== "done") return null;
    return { mediaPath: abs, descriptionPath, text: doc.description, model: doc.engine ?? null, generatedAt: doc.generated ?? null };
  } catch {
    return null;
  }
}

function result(
  p: string,
  status: DescribeResult["status"],
  descriptionPath: string | null,
  model: string | null,
  reason: string | null,
): DescribeResult {
  return { path: p, status, descriptionPath, model, reason };
}

/** Provider matrix + the default provider — drives the viewer/settings "which AIs are available" surface. */
export function describeProviders(): DescribeProvidersStatus {
  const providers = providerStatus();
  return { providers, defaultProvider: getAppConfig().ai.provider, anyAvailable: providers.some((p) => p.available) };
}

/** The editable AI config the Settings page reads — provider default + per-provider model + key SOURCE
 *  (config vs env), NEVER the raw key value (ai_description.mdx §6). */
export function getAiConfig(): DescribeAiConfig {
  const sources = providerKeySources();
  return {
    provider: getAppConfig().ai.provider,
    providers: providerMeta().map((m) => ({
      id: m.id,
      label: m.label,
      supports: m.supports,
      model: sources[m.id].model,
      hasConfigKey: sources[m.id].hasConfigKey,
      usingEnv: sources[m.id].usingEnv,
      usingFile: sources[m.id].usingFile,
      available: m.available,
    })),
  };
}

/** Everything the "AI credentials" instructions page needs (ai_credentials.mdx): where the shared
 *  Gemini key file lives + its placeholder schema, the app config.yaml path Settings writes to, and the
 *  env vars each provider honors. Never returns a raw key value. */
export function aiCredentialsInfo(): AiCredentialsInfo {
  return {
    anyAvailable: describeProviders().anyAvailable,
    file: googleApiKeyFileInfo(),
    appConfigPath: appConfigPath(),
    envVars: {
      gemini: ["GEMINI_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY"],
      grok: ["XAI_API_KEY", "GROK_API_KEY"],
      openai: ["OPENAI_API_KEY"],
    },
  };
}

/** Persist the AI config from the Settings editor. An `apiKey` of "" CLEARS the config key (falls back to
 *  env); a non-empty value sets it; `undefined` leaves it unchanged. Returns the fresh (masked) config. */
export async function setAiConfig(patch: DescribeAiConfigPatch): Promise<DescribeAiConfig> {
  await updateAppConfig((c) => {
    if (patch.provider) c.ai.provider = patch.provider;
    for (const id of ["gemini", "grok", "openai"] as ProviderId[]) {
      const p = patch[id];
      if (!p) continue;
      if (p.apiKey !== undefined) c.ai[id].api_key = !p.apiKey || p.apiKey.trim() === "" ? null : p.apiKey.trim();
      if (p.model !== undefined && p.model.trim() !== "") c.ai[id].model = p.model.trim();
    }
    return c;
  });
  return getAiConfig();
}

/**
 * Generate (or regenerate) the AI description for ONE media file. Uploads the file to the selected
 * provider and writes the result to the `.ai_description` sidecar. Never throws for the expected outcomes — those
 * come back as a status the UI reports truthfully.
 */
export async function describeOne(
  input: string,
  opts: { overwrite?: boolean; provider?: ProviderId | "auto" } = {},
): Promise<DescribeResult> {
  const abs = path.resolve(expandHome(input.trim()));
  const name = path.basename(abs);
  if (!exists(abs)) return result(abs, "failed", null, null, "file not found");

  const kind = describeKindFor(name);
  if (!kind) return result(abs, "unsupported", null, null, "only images and videos can be AI-described");

  const { root, descriptionPath, needsSetup } = resolveDescriptionPath(abs);
  // First-time gate (Transcribe.mdx §3.5): no Personal storage owns this file — route to the setup wizard
  // rather than writing a description in a surprising place.
  if (needsSetup) {
    return result(abs, "needs_setup", null, null, "no storage is set up for this file — configure Personal storage first");
  }
  if (!opts.overwrite && readDescription(abs)) {
    return result(abs, "skipped", descriptionPath, null, "already described");
  }

  const adapter = selectAdapter(kind, opts.provider);
  if (!adapter) {
    const need = kind === "video" ? "Gemini (only Gemini describes video)" : "Gemini, Grok, or OpenAI";
    const reason = `no AI provider configured for ${kind} — add an API key for ${need}`;
    log.error("describe", `describe skipped for ${abs}: ${reason}`);
    return result(abs, "no_provider", null, null, reason);
  }

  try {
    const prompt = getPrompt(kind);
    // Ensure the bytes we upload fit under the inline cap. Oversized videos/images are transcoded to a
    // TEMPORARY compressed copy (the original is never touched); we upload that copy and delete it after.
    // (ai_description.mdx §3.3 — compress-to-fit instead of hard-failing over the cap.) The whole run is
    // wrapped in a track("describe", …) progress-registry job so the dock shows a live card while it uploads
    // — including for a file the background queue started (job_queue.mdx §3).
    const { text, model } = await track("describe", name, async () => {
      const fit = fitMediaUnderLimit(abs, kind);
      try {
        const mimeType = mimeForMedia(fit.path, kind);
        return await adapter.describe({ absPath: fit.path, kind, mimeType, prompt });
      } finally {
        fit.cleanup();
      }
    });

    // The description lands in the COMMITTED .lfbridge/ area (Transcribe.mdx §3.1), so it travels with the
    // repo — no `*.ai_description` gitignore nudge; the media itself stays git-ignored and rides IPFS.
    fs.mkdirSync(path.dirname(descriptionPath), { recursive: true });
    fs.writeFileSync(
      descriptionPath,
      YAML.stringify({
        source: path.relative(root, abs),
        status: "done",
        engine: model,
        provider: adapter.id,
        generated: new Date().toISOString(),
        kind,
        description: text,
      }),
      "utf8",
    );
    // Cross the content threshold (artifact_placement_policy.mdx §2): an AI description ALONE is a durable
    // user artifact, so this repo's `.lfbridge/` tracking placement is justified from here on (one-way latch).
    markDurableArtifact(root);
    log.info("describe", `${abs} → ${descriptionPath} (${adapter.id}/${model}, ${text.length} chars)`);
    return result(abs, "described", descriptionPath, model, null);
  } catch (e) {
    const msg = (e as Error).message;
    // The complete fault trail lands in error.err (shared/logging.ts writes WARN/ERROR/FATAL there).
    log.error("describe", `describe failed for ${abs} [provider=${adapter.id}, kind=${kind}]: ${msg}`);
    return result(abs, "failed", null, null, msg);
  }
}

/** Describe a selected SET of image/video files (ai_description.mdx §5). Never throws — each file reports
 *  its own outcome. */
export async function describeMany(
  inputs: string[],
  opts: { overwrite?: boolean; provider?: ProviderId | "auto" } = {},
): Promise<DescribeBatchResult> {
  const results: DescribeResult[] = [];
  for (const p of inputs) {
    try {
      results.push(await describeOne(p, opts));
    } catch (e) {
      results.push(result(path.resolve(expandHome(p.trim())), "failed", null, null, (e as Error).message));
    }
  }
  return summarizeDescribe(results);
}

/** Describe ALL image/video under a directory or repo working tree (ai_description.mdx §5). */
export async function describeTree(
  input: string,
  opts: { overwrite?: boolean; provider?: ProviderId | "auto" } = {},
): Promise<DescribeBatchResult> {
  const abs = path.resolve(expandHome(input.trim()));
  if (!exists(abs)) return summarizeDescribe([result(abs, "failed", null, null, "path not found")]);
  const media = walkDescribable(abs);
  log.info("describe", `tree describe: ${media.length} image/video file(s) under ${abs}`);
  return describeMany(media, opts);
}

/**
 * The "Create AI descriptions" PAGE ACTION (page_actions.mdx §5) — plan + background-queue. Resolves the
 * set (checked `paths`, else the recursive `root`), drops files that already have a `done` description and
 * non-image/-video files (skip-already-done, page_actions.mdx §1.2), hands the eligible remainder to the
 * background queue ([job_queue.mdx](../jobqueue)), and returns the PLAN immediately — never the results.
 */
export function enqueueDescribe(opts: {
  paths?: string[];
  root?: string;
  overwrite?: boolean;
  provider?: ProviderId | "auto";
}): EnqueuePlan {
  const overwrite = opts.overwrite ?? false;
  const candidates = describeCandidates(opts);
  let alreadyDone = 0;
  let unsupported = 0;
  let needSetup = 0;
  const eligible: string[] = [];
  for (const abs of candidates) {
    if (!describeKindFor(path.basename(abs))) {
      unsupported++;
      continue;
    }
    const dp = resolveDescriptionPath(abs);
    // A file that needs first-time setup has no real destination yet — never counts as already-done.
    if (!overwrite && !dp.needsSetup && readDescription(abs)) {
      alreadyDone++;
      continue;
    }
    eligible.push(abs);
    if (dp.needsSetup) needSetup++;
  }
  // First-time gate (Transcribe.mdx §3.5): if EVERY eligible file needs setup (no Personal storage owns
  // them), queue nothing and tell the UI to open the wizard with a representative path.
  if (eligible.length > 0 && needSetup === eligible.length) {
    log.info("describe", `enqueue: ${eligible.length} eligible all need first-time setup — not queuing`);
    return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued: 0, willProcess: 0, needsSetup: true, setupPath: eligible[0] };
  }
  const { queued } = enqueue(eligible.map((p) => ({ op: "describe", path: p, overwrite, provider: opts.provider })));
  log.info("describe", `enqueue [${scopeLabel(opts)}]: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued, needsSetup: false, setupPath: null };
}

/**
 * PREVIEW the eligible AI-description candidates for a scope WITHOUT queuing anything (dialogs.mdx §5.2).
 * Same narrowing as `enqueueDescribe` (scope, drop unsupported + already-described) but returns the eligible
 * candidate FILE LIST (path + size) for the unified batch-confirm popup. Nothing is written or queued.
 */
export function previewDescribe(opts: { paths?: string[]; root?: string; overwrite?: boolean }): PreviewPlan {
  const overwrite = opts.overwrite ?? false;
  const candidates = describeCandidates(opts);
  let alreadyDone = 0;
  let unsupported = 0;
  const files: PreviewPlan["files"] = [];
  for (const abs of candidates) {
    if (!describeKindFor(path.basename(abs))) {
      unsupported++;
      continue;
    }
    const dp = resolveDescriptionPath(abs);
    if (!overwrite && !dp.needsSetup && readDescription(abs)) {
      alreadyDone++;
      continue;
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(abs).size;
    } catch {
      /* size unknown — leave 0 */
    }
    files.push({ path: abs, sizeBytes });
  }
  log.info("describe", `preview [${scopeLabel(opts)}]: ${candidates.length} considered → ${files.length} candidates (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { files, considered: candidates.length, alreadyDone, unsupported };
}

/** Checked `paths` used as-is, else the recursive `root` walked for image/video (page_actions.mdx §1.1). */
function describeCandidates(opts: { paths?: string[]; root?: string }): string[] {
  if (opts.paths && opts.paths.length > 0) {
    return opts.paths.map((p) => path.resolve(expandHome(p.trim())));
  }
  if (opts.root && opts.root.trim()) {
    return walkDescribable(path.resolve(expandHome(opts.root.trim())));
  }
  throw new Error("enqueue requires either paths[] (the checked set) or root (to walk recursively)");
}

/** The scope a page action asked for, for the enqueue log line — the walked root, or the checked-set size.
 *  Answers "which page queued these jobs?" when the queue is read back later. */
function scopeLabel(opts: { paths?: string[]; root?: string }): string {
  if (opts.paths && opts.paths.length > 0) return `${opts.paths.length} checked path(s)`;
  return opts.root ? `root ${path.resolve(expandHome(opts.root.trim()))}` : "no scope";
}

/** Recursively collect image/video file paths under `root`, skipping hidden/tracking/heavy dirs. */
function walkDescribable(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
        visit(path.join(dir, ent.name));
      } else if (ent.isFile() && describeKindFor(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  try {
    fs.statSync(root).isDirectory() ? visit(root) : describeKindFor(path.basename(root)) && out.push(root);
  } catch {
    /* unreadable root */
  }
  return out;
}

function summarizeDescribe(results: DescribeResult[]): DescribeBatchResult {
  return {
    results,
    described: results.filter((r) => r.status === "described").length,
    // needs_setup counts with skipped (nothing produced, not an error) so the counts still sum.
    skipped: results.filter((r) => r.status === "skipped" || r.status === "needs_setup").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "no_provider" || r.status === "unsupported").length,
  };
}

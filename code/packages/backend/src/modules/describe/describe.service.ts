// AI DESCRIPTION service (ai_description.mdx). Generates a hyper-detailed, searchable description of a
// local image/video by calling a vision provider (adapters.ts) with the kind's prompt (prompts.ts), and
// stores the result in the SAME place the storage-level media analysis uses (storages.mdx §6):
//   <storageRoot>/.lfbridge/analysis/<relpath>/description.yaml
// so the storage file table's "description" indicator and this viewer feature stay one source of truth.
// The owning storage root is resolved exactly like transcription (nearest ancestor with storage.yaml /
// .lfbridge / .git), so a description lands beside its media wherever it lives. Explicit-user-action only.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DescribeKind, DescribeResult, DescribeBatchResult, DescribeView, DescribeProvidersStatus, DescribeAiConfig, DescribeAiConfigPatch, AiCredentialsInfo, EnqueuePlan } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { appConfigPath } from "../../shared/store/scopes.js";
import { googleApiKeyFileInfo } from "../../config/google-apikey-file.js";
import { resolveStorageRoot } from "../transcribe/transcribe.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { getPrompt } from "./prompts.js";
import { selectAdapter, providerStatus, providerKeySources, providerMeta, mimeForMedia, type ProviderId } from "./adapters.js";
import { fitMediaUnderLimit } from "./fit-media.js";
import { log } from "../../shared/logging.js";

// Directories a "describe all" walk never descends into (mirrors transcribe's SKIP_DIRS).
const SKIP_DIRS = new Set([".lfbridge", ".transcribe", ".git", "node_modules"]);

const LFBRIDGE_DIR = ".lfbridge";
const ANALYSIS_DIR = "analysis";
const DESCRIPTION_YAML = "description.yaml";

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** <storageRoot>/.lfbridge/analysis/<relpath>/description.yaml — the canonical description location. */
export function resolveDescriptionPath(absFile: string): { root: string; rel: string; descriptionPath: string } {
  const root = resolveStorageRoot(absFile);
  const rel = path.relative(root, absFile);
  const descriptionPath = path.join(root, LFBRIDGE_DIR, ANALYSIS_DIR, rel, DESCRIPTION_YAML);
  return { root, rel, descriptionPath };
}

/** Keep the .lfbridge/ analysis tree out of Git in a plain repo (mirrors the transcribe .gitignore nudge). */
function ensureLfbridgeIgnored(root: string): void {
  if (!exists(path.join(root, ".git"))) return;
  const gi = path.join(root, ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* none yet */
  }
  if (/^\.lfbridge\/?\s*$/m.test(body)) return;
  const prefix = body && !body.endsWith("\n") ? `${body}\n` : body;
  try {
    fs.writeFileSync(gi, `${prefix}${LFBRIDGE_DIR}/\n`, "utf8");
  } catch (e) {
    log.warn("describe", `could not update .gitignore in ${root}: ${(e as Error).message}`);
  }
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
 * provider and writes the result to description.yaml. Never throws for the expected outcomes — those
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

  const { root, descriptionPath } = resolveDescriptionPath(abs);
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

    ensureLfbridgeIgnored(root);
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
  const eligible: string[] = [];
  for (const abs of candidates) {
    if (!describeKindFor(path.basename(abs))) {
      unsupported++;
      continue;
    }
    if (!overwrite && readDescription(abs)) {
      alreadyDone++;
      continue;
    }
    eligible.push(abs);
  }
  const { queued } = enqueue(eligible.map((p) => ({ op: "describe", path: p, overwrite, provider: opts.provider })));
  log.info("describe", `enqueue: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued };
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
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "no_provider" || r.status === "unsupported").length,
  };
}

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
import type { DescribeKind, DescribeResult, DescribeBatchResult, DescribeView, DescribeProvidersStatus, DescribeAiConfig, DescribeAiConfigPatch, AiCredentialsInfo, EnqueuePlan, PreviewPlan, ProviderHealthView, ProviderResumeResult } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { expandHome } from "../fs/badges.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { appConfigPath } from "../../shared/store/scopes.js";
import { googleApiKeyFileInfo } from "../../config/google-apikey-file.js";
import {
  resolveArtifactPlacement,
  artifactPathForPlacement,
  AI_DESCRIPTION_EXT,
  AI_DESCRIPTION_REJECTED_EXT,
} from "../storage/artifact-placement.service.js";
import { markDurableArtifact } from "../storage/tracking-root.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { repoArtifactPlacement } from "../store-model/units.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue, createBatch } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch } from "../jobqueue/batch-manifest.service.js";
import { getPrompt } from "./prompts.js";
import {
  selectAdapter,
  providerStatus,
  providerKeySources,
  providerMeta,
  mimeForMedia,
  withProviderRetry,
  rejectionOf,
  type ProviderId,
  type ProviderRejection,
} from "./adapters.js";
// The provider-account gate (to_fix.mdx §2): preflight before a batch, circuit breaker on an account fault.
import { preflightProvider, noteProviderFailure, noteProviderSuccess, circuitStatuses, resumeProvider } from "./provider-health.service.js";
import { fitMediaUnderLimit } from "./fit-media.js";
import { log } from "../../shared/logging.js";
import { txn, txnBegin, txnEnd, type TxnOutcome, type TxnFields } from "../../shared/transactions.js";

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
  /** Where a provider REFUSAL is recorded instead of a description (§2.3) — same root, same placement
   *  rule, same path mirror; only the appended extension differs. */
  rejectedPath: string;
  needsSetup: boolean;
} {
  const p = resolveArtifactPlacement(absFile);
  // Honor the repo's AI-description placement radio (repo_settings.mdx §5) — the mirror of transcription.
  // `p.owner` carries the already-resolved storage role, so an SDL gets NO `.lfbridge/` segment (§0).
  const placement = repoArtifactPlacement(p.root, "aiDescription");
  const descriptionPath = artifactPathForPlacement(p.root, p.rel, AI_DESCRIPTION_EXT, placement, p.owner);
  const rejectedPath = artifactPathForPlacement(p.root, p.rel, AI_DESCRIPTION_REJECTED_EXT, placement, p.owner);
  return { root: p.root, rel: p.rel, descriptionPath, rejectedPath, needsSetup: p.needsSetup };
}

/** True when the provider has already REFUSED this file and we recorded the verdict (§2.3). Existence IS
 *  the signal — the same rule the `.ai_description` / `.ocr` sidecars use — and it is what stops a batch
 *  from re-offering a refusal forever (§12.5, [ocr.mdx §2.3](./ocr.mdx)). Deliberately a bare file-exists
 *  test, never a parse: a hand-edited or truncated record must still count as "we already asked". */
export function isRejected(absFile: string): boolean {
  try {
    return exists(resolveDescriptionPath(path.resolve(expandHome(absFile.trim()))).rejectedPath);
  } catch {
    return false; // unresolvable placement → treat as not-yet-asked; the describe path re-checks anyway
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

/**
 * Record a provider's REFUSAL of one file (§2.3) — `<media>.ai_description_rejected`.
 *
 * The contract is "**any and all details** the provider responded with", so this keeps two layers: the
 * named fields a human reads first (`finish_reason`, and the `finish_message` that actually explains which
 * rule fired), and `provider_response` — the provider's **entire untouched response**, so a detail we never
 * thought to parse is still on disk. YAML like every other sidecar, and `status: rejected` states plainly
 * that this file has NO description and why.
 */
function writeRejection(p: {
  root: string;
  rejectedPath: string;
  abs: string;
  kind: DescribeKind;
  rejection: ProviderRejection;
  message: string;
}): void {
  const r = p.rejection;
  fs.mkdirSync(path.dirname(p.rejectedPath), { recursive: true });
  fs.writeFileSync(
    p.rejectedPath,
    YAML.stringify({
      source: path.relative(p.root, p.abs),
      status: "rejected",
      engine: r.model,
      provider: r.provider,
      generated: new Date().toISOString(),
      kind: p.kind,
      // Why there is no description — the fields a human reads first.
      rejected: {
        finish_reason: r.finishReason,
        finish_message: r.finishMessage, // Google's own prose: "…may contain material that resembles existing copyrighted works…"
        block_reason: r.blockReason,
        model_version: r.modelVersion,
        response_id: r.responseId, // quote this to Google when disputing a refusal
        error: p.message,
      },
      safety_ratings: r.safetyRatings ?? null,
      prompt_feedback: r.promptFeedback ?? null,
      usage: r.usageMetadata ?? null,
      // The whole answer, verbatim. Never contains the API key — that rides the URL's `?key=`, not the body.
      provider_response: r.raw ?? null,
    }, {
      // `usage` and `provider_response.usageMetadata` are the SAME object, so YAML's default aliasing emits
      // an `&a1` anchor and a `*a1` reference instead of the value. This file exists to be READ — by the
      // user, and by whoever they forward it to — so spell every value out rather than make them resolve a
      // pointer. (No cycles here; `raw` is parsed JSON.)
      aliasDuplicateObjects: false,
    }),
    "utf8",
  );
  // Same content-threshold latch as a description (artifact_placement_policy.mdx §2). A refusal record is a
  // durable artifact we intend to keep and to travel with the repo, so the tracking placement it was just
  // written to must STAY where it is — without the latch a later real description would move the base and
  // strand this file at the old path.
  markDurableArtifact(p.root);
}

/** The file's size for the ledger's `bytes=` — the single best predictor of both duration and heap
 *  (transactions_log.mdx §3.3). Best-effort: a stat that fails must never cost us the description. */
function sizeOf(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

/** A describe that produces NOTHING still gets a ledger pair (transactions_log.mdx §5.2). A file the user
 *  asked for that leaves no line is exactly the invisibility this ledger exists to end — "it did nothing"
 *  and "it never started" must never look the same on disk. These gates fire before any real work, so the
 *  pair is a short BEGIN/END with an outcome and a reason SLUG rather than a wrapped body. */
function ledgerNoWork(abs: string, fields: TxnFields, outcome: TxnOutcome, reason: string): void {
  const t = txnBegin("describe", { file: abs, ...fields });
  txnEnd(t, outcome, { reason });
}

/**
 * Per-provider ACCOUNT health for the Settings → AI surface (to_fix.mdx §2.6).
 *
 * `providerStatus()` answers "is a key configured" — which on 2026-07-15 said Gemini was perfectly fine for
 * the 106 minutes between the credits dying and the doomed batch being queued. A configured key on a dead
 * account is indistinguishable from a healthy one until somebody CALLS it. These rows carry what that
 * question can't: whether the circuit is open, why, and when the provider last actually served something.
 *
 * Free to call — it reads the in-memory circuit state written by real calls and probes, and never itself
 * calls a provider. That is what lets a Settings page poll it, so "why did nothing happen last night" is
 * answerable BEFORE the overnight run rather than after (§2.6).
 */
export function providerHealth(): ProviderHealthView[] {
  const statuses = circuitStatuses();
  return providerMeta().map((m) => {
    const s = statuses[m.id];
    return {
      id: m.id,
      open: s?.open ?? false,
      reason: s?.reason ?? null,
      openedAt: s?.openedAt ?? null,
      lastGoodAt: s?.lastGoodAt ?? null,
      lastCheckedAt: s?.lastCheckedAt ?? null,
    };
  });
}

/** The user fixed the account and pressed Resume (to_fix.mdx §2.4). Re-probes and closes the circuit ONLY on
 *  a success — see `resumeProvider`; a Resume that trusted the click would put the doomed batch straight
 *  back on the wire. Returns the resulting health row either way, so the banner can re-render from one call. */
export async function resumeDescribeProvider(provider: ProviderId): Promise<ProviderResumeResult> {
  const r = await resumeProvider(provider);
  const health = providerHealth().find((h) => h.id === provider)!;
  return { resumed: r.resumed, reason: r.reason, health };
}

/** Below this size a batch isn't worth a probe: a one-file describe from the viewer discovers the same fault
 *  just as fast by simply trying, and shouldn't wait on a probe first (to_fix.mdx §2.5). Shared by
 *  `enqueueDescribe` and `previewDescribe` so the popup's verdict and the enqueue's gate can never disagree. */
const PREFLIGHT_MIN_BATCH = 2;

/** Provider matrix + the default provider — drives the viewer/settings "which AIs are available" surface.
 *  Carries per-provider account health beside "available" (to_fix.mdx §2.6): configured ≠ working. */
export function describeProviders(): DescribeProvidersStatus {
  const providers = providerStatus();
  return { providers, defaultProvider: getAppConfig().ai.provider, anyAvailable: providers.some((p) => p.available), health: providerHealth() };
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
    // Health beside the key editor (to_fix.mdx §2.6) — the page where a user asks "why did nothing happen
    // last night" is the page that must answer it, with last-known-good rather than "a key is configured".
    health: providerHealth(),
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
  if (!exists(abs)) {
    ledgerNoWork(abs, {}, "failed", "file_not_found");
    return result(abs, "failed", null, null, "file not found");
  }
  const bytes = sizeOf(abs);

  const kind = describeKindFor(name);
  if (!kind) {
    ledgerNoWork(abs, { bytes }, "blocked", "unsupported_kind");
    return result(abs, "unsupported", null, null, "only images and videos can be AI-described");
  }

  const { root, descriptionPath, rejectedPath, needsSetup } = resolveDescriptionPath(abs);
  // First-time gate (Transcribe.mdx §3.5): no Personal storage owns this file — route to the setup wizard
  // rather than writing a description in a surprising place.
  if (needsSetup) {
    ledgerNoWork(abs, { bytes, kind }, "blocked", "needs_setup");
    return result(abs, "needs_setup", null, null, "no storage is set up for this file — configure Personal storage first");
  }
  if (!opts.overwrite && readDescription(abs)) {
    ledgerNoWork(abs, { bytes, kind }, "skipped", "already_described");
    return result(abs, "skipped", descriptionPath, null, "already described");
  }
  // The provider already REFUSED this file and we recorded the verdict (§2.3). Asking again without an
  // explicit overwrite would spend a real call to be told the same thing. The preview and the enqueue drop
  // these before they are ever queued (§12.5); this is the backstop for the paths that bypass the queue —
  // `describeMany` / `describeTree`, the CLI, a direct POST.
  if (!opts.overwrite && exists(rejectedPath)) {
    ledgerNoWork(abs, { bytes, kind }, "skipped", "already_rejected");
    return result(abs, "skipped", rejectedPath, null, `the AI provider refused this file — see ${path.basename(rejectedPath)}; re-describe with overwrite to ask again`);
  }

  const adapter = selectAdapter(kind, opts.provider);
  if (!adapter) {
    const need = kind === "video" ? "Gemini (only Gemini describes video)" : "Gemini, Grok, or OpenAI";
    const reason = `no AI provider configured for ${kind} — add an API key for ${need}`;
    ledgerNoWork(abs, { bytes, kind }, "blocked", "no_provider");
    log.error("describe", `describe skipped for ${abs}: ${reason}`);
    return result(abs, "no_provider", null, null, reason);
  }

  try {
    // The WORK LEDGER pair for this file (transactions_log.mdx §5.2). This BEGIN is the line whose absence
    // caused the 2026-07-15 incident: describeOne logged only terminal outcomes, so the 1,291 files still in
    // flight when V8 aborted at 4.1GB left no trace they had ever started, and "lost" was indistinguishable
    // from "finished". BEGIN lands here — BEFORE the fit-to-limit transcode and before a single byte is
    // uploaded — and the END fires from txn()'s `finally`, so the only thing that can suppress it is the
    // process dying, which is exactly the signal a missing END must carry.
    return await txn(
      "describe",
      { file: abs, bytes, provider: adapter.id, kind, overwrite: !!opts.overwrite },
      async (t, end) => {
        const prompt = getPrompt(kind);
        // Ensure the bytes we upload fit under the inline cap. Oversized videos/images are transcoded to a
        // TEMPORARY compressed copy (the original is never touched); we upload that copy and delete it after.
        // (ai_description.mdx §3.3 — compress-to-fit instead of hard-failing over the cap.) The whole run is
        // wrapped in a track("describe", …) progress-registry job so the dock shows a live card while it uploads
        // — including for a file the background queue started (job_queue.mdx §3).
        const { text, model } = await track("describe", name, async () => {
          // TODO(parent): fitMediaUnderLimit() takes no `parent` yet, so its child fit_media txn can't
          // parent to this describe (transactions_log.mdx §5.6 owns that seam — fit-media.ts).
          const fit = await fitMediaUnderLimit(abs, kind);
          try {
            const mimeType = mimeForMedia(fit.path, kind);
            // Bounded retry on TRANSIENT provider failures (ai_description.mdx §3.5) — a timeout, a 429/5xx, a
            // dropped socket, or an empty-200 must never permanently burn a file. Wrapped OUTSIDE the fit so a
            // retry re-sends the already-compressed copy instead of re-running the whole ffmpeg transcode.
            // `parent: t.id` hangs every attempt's provider_call pair off this file's txn (§4).
            return await withProviderRetry(`${adapter.id} describe ${name}`, () =>
              adapter.describe({ absPath: fit.path, kind, mimeType, prompt, parent: t.id }),
            );
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
        // A description SUPERSEDES an earlier refusal of the same file (§2.3): the provider changed its mind
        // — a new model, a re-encoded upload, an overwrite retry. Leaving the stale `.ai_description_rejected`
        // behind would have the tree assert both "described" and "refused" about one file, and would keep
        // every future batch dropping a file that is now perfectly described.
        try {
          if (exists(rejectedPath)) fs.unlinkSync(rejectedPath);
        } catch (e) {
          log.warn("describe", `described ${abs} but could not clear its old rejection record ${rejectedPath}: ${(e as Error).message}`);
        }
        // Cross the content threshold (artifact_placement_policy.mdx §2): an AI description ALONE is a durable
        // user artifact, so this repo's `.lfbridge/` tracking placement is justified from here on (one-way latch).
        markDurableArtifact(root);
        // THE WRITE IS THE TRIGGER (storage_personal.mdx §18.5.3.1 / AC-29): scheduling this storage's sync is
        // the final step of producing the artifact. Before this, an AI description reached the server only as a
        // STOWAWAY on the device worker's `git add -A` — so it sat uncommitted for 10-30 min, or forever if any
        // of the six §18.5.2 forever-cases applied. Fire-and-forget: the description IS written; a sync fault is
        // reportable (it warns inside), never a reason to fail the call the user is waiting on.
        noteArtifactWritten(descriptionPath, "AI descriptions");
        // The provider just SERVED a real call — date its last-known-good (to_fix.mdx §2.6). The mirror of the
        // `noteProviderFailure` in the catch below: every describe folds into health exactly once, so Settings
        // → AI can say "Gemini last worked at 19:47" instead of only "a key is configured".
        noteProviderSuccess(adapter.id);
        // `chars`, never the 1,877 chars themselves — the description text never enters a ledger line (§9).
        end({ chars: text.length, model });
        log.info("describe", `${abs} → ${descriptionPath} (${adapter.id}/${model}, ${text.length} chars)`);
        return result(abs, "described", descriptionPath, model, null);
      },
    );
  } catch (e) {
    const msg = (e as Error).message;
    // Fold the fault into the provider's circuit BEFORE reporting it (to_fix.mdx §2.4). If this was an
    // account-level fault — credits depleted, key revoked — the circuit opens here, and the queue halts the
    // rest of the batch at admission instead of letting 1,439 more files rediscover the same dead account
    // one doomed upload at a time. That rediscovery is what pinned 24 payloads in the heap on 2026-07-15.
    const fault = noteProviderFailure(adapter.id, e);
    // The provider REFUSED this file (§2.3) — that is an ANSWER, not a breakdown. Record everything it told
    // us in a `.ai_description_rejected` beside where the description would have gone, so the refusal is a
    // durable, readable artifact instead of one line in error.err that rotates away. Only a real refusal
    // carries `rejection`; a timeout or a dead account does not, and must never write one of these.
    const rejection = rejectionOf(e);
    if (rejection) {
      try {
        writeRejection({ root, rejectedPath, abs, kind, rejection, message: msg });
        log.warn("describe", `${adapter.id} REFUSED ${abs} (${rejection.finishReason ?? rejection.blockReason ?? "no reason given"}) → ${rejectedPath}`);
        return result(abs, "rejected", rejectedPath, rejection.model, msg);
      } catch (writeErr) {
        // Failing to RECORD the refusal must not masquerade as the refusal itself — say both things.
        log.error("describe", `could not write the rejection record for ${abs}: ${(writeErr as Error).message}`);
      }
    }
    // The complete fault trail lands in error.err (shared/logging.ts writes WARN/ERROR/FATAL there).
    log.error("describe", `describe failed for ${abs} [provider=${adapter.id}, kind=${kind}, fault=${fault}]: ${msg}`);
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
export async function enqueueDescribe(opts: {
  paths?: string[];
  root?: string;
  overwrite?: boolean;
  provider?: ProviderId | "auto";
}): Promise<EnqueuePlan> {
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
    // Resolving the placement must not be fatal to the whole enqueue (mirror of previewDescribe). On a
    // resolve/read failure, still queue the file — the per-file describe job records its own failure
    // gracefully — rather than 400-ing Confirm and dropping the entire batch.
    let needsSetupForThis = false;
    try {
      const dp = resolveDescriptionPath(abs);
      // A file that needs first-time setup has no real destination yet — never counts as already-done.
      // A REFUSED file counts as settled too (§2.3): the provider already answered, and re-queuing it would
      // spend a real call to be told the same thing — the failures that halted the batch on 2026-07-16.
      if (!overwrite && !dp.needsSetup && (readDescription(abs) || exists(dp.rejectedPath))) {
        alreadyDone++;
        continue;
      }
      needsSetupForThis = dp.needsSetup;
    } catch (e) {
      log.warn("describe", `enqueue: could not resolve description state for ${abs}: ${(e as Error).message}`);
    }
    eligible.push(abs);
    if (needsSetupForThis) needSetup++;
  }
  // First-time gate (Transcribe.mdx §3.5): if EVERY eligible file needs setup (no Personal storage owns
  // them), queue nothing and tell the UI to open the wizard with a representative path.
  if (eligible.length > 0 && needSetup === eligible.length) {
    log.info("describe", `enqueue: ${eligible.length} eligible all need first-time setup — not queuing`);
    return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued: 0, willProcess: 0, needsSetup: true, setupPath: eligible[0], blocked: false, blockedReason: null };
  }

  // ── PREFLIGHT the provider account (to_fix.mdx §2.5) ────────────────────────────────────────────────
  // ONE cheap call before we queue N. This is the whole fix for the 2026-07-15 incident: that batch was
  // queued 106 minutes after the Gemini credits died, and every one of its 1,440 files was doomed before
  // the first byte moved. A single probe here answers in about a second.
  //
  // Only worth paying for a real batch — a one-file describe from the viewer discovers the same fault just
  // as fast by simply trying, and shouldn't wait on a probe first.
  if (eligible.length >= PREFLIGHT_MIN_BATCH) {
    // Which provider will actually run? Resolve it the same way describeOne will, using a representative
    // eligible file — asking about a provider that would never be chosen would be a meaningless gate.
    const repKind = describeKindFor(path.basename(eligible[0]));
    const adapter = repKind ? selectAdapter(repKind, opts.provider) : null;
    if (adapter) {
      const health = await preflightProvider(adapter.id);
      if (!health.ok) {
        log.error(
          "describe",
          `enqueue [${scopeLabel(opts)}] BLOCKED before queuing ${eligible.length} file(s): ${health.reason} ` +
            `(to_fix.mdx §2.5 — the account cannot serve this batch, so nothing was queued).`,
        );
        return {
          considered: candidates.length,
          eligible: eligible.length,
          alreadyDone,
          unsupported,
          queued: 0,
          willProcess: 0,
          needsSetup: false,
          setupPath: null,
          blocked: true,
          blockedReason: health.reason,
        };
      }
    }
  }

  // ── The BATCH MANIFEST (to_fix.mdx §4.1, invariant §10.4) ───────────────────────────────────────────
  // Written BEFORE the enqueue, with the full file list. On 2026-07-15 this batch's contents were
  // unknowable after the crash; from here on, the click itself is a durable fact. The manifest's
  // batch_id then rides every task (C6) and, via runTask's withLogContext, every LOG LINE the batch
  // emits (C7) — so one grep on that id reconstructs the whole run across log.log and error.err.
  const manifest = writeManifest({
    op: "describe",
    scope: scopeLabel(opts),
    provider: opts.provider ?? "auto",
    providerPreflight: eligible.length >= PREFLIGHT_MIN_BATCH ? "ok" : "not_probed",
    counts: { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported },
    files: eligible.map((p) => ({ path: p, sizeBytes: safeSize(p) })),
  });
  const { queued } = enqueue(
    eligible.map((p) => ({ op: "describe", path: p, overwrite, provider: opts.provider, batchId: manifest.batchId })),
  );
  // Seed the outstanding count with what ACTUALLY entered the queue, not what was eligible — `enqueue`
  // dedups against in-flight work and can refuse at the journal ceiling, and a tally seeded too high
  // would never reach zero, leaving a finished batch's manifest permanently open (i.e. reading as a
  // crash). Count what happened, never what was intended.
  // Open the LIVE batch row (processing_batches.mdx §1) — ADOPTING the manifest's batchId, never minting a
  // second. Until this existed, only "Compress inside" ever created a row, so a 1,440-file describe run showed
  // ZERO batches on the Processing page. `total` is what ACTUALLY queued (never `eligible`): enqueue dedups
  // against in-flight work and can refuse at the journal ceiling, and a denominator seeded too high would
  // never be reached, leaving the row stuck "running" forever. Called synchronously after enqueue — no
  // `await` in between, so no task can settle before the row exists.
  createBatch({
    batchId: manifest.batchId,
    kind: "describe",
    label: `Describe · ${scopeLabel(opts)} · ${queued} files`,
    scope: scopeLabel(opts),
    provider: opts.provider ?? "auto",
    total: queued,
    manifestPath: manifest.file,
  });
  trackBatch(manifest.batchId, queued);
  log.info("describe", `enqueue [${scopeLabel(opts)}]: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { batchId: manifest.batchId, considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued, needsSetup: false, setupPath: null, blocked: false, blockedReason: null };
}

/**
 * PREVIEW the eligible AI-description candidates for a scope WITHOUT queuing anything (dialogs.mdx §5.2).
 * Same narrowing as `enqueueDescribe` (scope, drop unsupported + already-described) but returns the eligible
 * candidate FILE LIST (path + size) for the unified batch-confirm popup. Nothing is written or queued.
 *
 * Also carries the provider's PREFLIGHT verdict (to_fix.mdx §2.5, §2.7 A7). Without it the popup is a liar by
 * omission: it renders "1,440 files ready — Confirm" against a depleted account, the user confirms, and only
 * /enqueue's own preflight says no — after the click, in a place the user reads as an error rather than as
 * the answer to the question they were actually asking. The preflight is CACHED and single-flighted (~60s),
 * and the popup's Confirm hits /enqueue within that window, so surfacing health here costs ZERO extra probes
 * — the plan and the enqueue share the one call. Async purely for that probe.
 */
export async function previewDescribe(opts: { paths?: string[]; root?: string; overwrite?: boolean }): Promise<PreviewPlan> {
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
    // Resolving the AI-description placement (or reading an existing description) must NEVER be fatal to
    // the whole preview. A single un-resolvable candidate would otherwise throw, /describe/plan would
    // return 400, and the unified batch popup would never open (dialogs.mdx §6.4 — the reported "right-click
    // → Create AI descriptions does nothing" bug). Treat a resolve/read failure as "not yet described" so
    // the file is still OFFERED in the popup rather than silently dropping the whole scan.
    try {
      const dp = resolveDescriptionPath(abs);
      // Drop the already-described AND the already-REFUSED (§2.3) — a refusal is a settled answer, so the
      // popup must not offer it again. Overwrite remains the one way to ask the provider to reconsider.
      if (!overwrite && !dp.needsSetup && (readDescription(abs) || exists(dp.rejectedPath))) {
        alreadyDone++;
        continue;
      }
    } catch (e) {
      log.warn("describe", `preview: could not resolve description state for ${abs}: ${(e as Error).message}`);
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(abs).size;
    } catch {
      /* size unknown — leave 0 */
    }
    files.push({ path: abs, sizeBytes });
  }
  // ── PREFLIGHT for the popup (to_fix.mdx §2.5) ───────────────────────────────────────────────────────
  // Same gate `enqueueDescribe` applies, asked one step earlier so the answer lands where the user is still
  // deciding. Mirrors that path exactly — same PREFLIGHT_MIN_BATCH, same representative-file adapter
  // resolution — because a popup that green-lights a batch /enqueue then refuses is worse than no popup.
  // Never fatal: a preview that can't determine health still lists its candidates (health stays undefined,
  // and /enqueue's own preflight remains the real gate) — the §2.3 bias, applied to the plan itself.
  let health: PreviewPlan["health"];
  try {
    if (files.length >= PREFLIGHT_MIN_BATCH) {
      const repKind = describeKindFor(path.basename(files[0].path));
      const adapter = repKind ? selectAdapter(repKind, undefined) : null;
      if (adapter) {
        const r = await preflightProvider(adapter.id);
        health = { provider: adapter.id, ok: r.ok, reason: r.reason };
        if (!r.ok) {
          log.warn("describe", `preview [${scopeLabel(opts)}]: provider ${adapter.id} is not healthy — ${r.reason} (to_fix.mdx §2.5)`);
        }
      }
    }
  } catch (e) {
    log.warn("describe", `preview: preflight could not run: ${(e as Error).message} — listing candidates without a health verdict.`);
  }
  log.info("describe", `preview [${scopeLabel(opts)}]: ${candidates.length} considered → ${files.length} candidates (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { files, considered: candidates.length, alreadyDone, unsupported, health };
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

/** A file's size for the manifest, or undefined if it can't be read. The manifest is a record, not a
 *  gate: a file we cannot stat is still enqueued, it just carries no size. */
function safeSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
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

/** Exported for describe-counts.spec.ts — the sum invariant is the whole claim of the shape. */
export function summarizeDescribe(results: DescribeResult[]): DescribeBatchResult {
  return {
    results,
    described: results.filter((r) => r.status === "described").length,
    // A refusal gets its OWN count (processing_batches.mdx §4.2), not a fold. It briefly lived in `skipped`,
    // which kept the sum right but said something false: "skipped" means WE didn't ask, and this file was
    // asked and answered — so the one number the product owner asked for sat buried under "already done".
    rejected: results.filter((r) => r.status === "rejected").length,
    // needs_setup counts with skipped (nothing produced, not an error) so the counts still sum.
    skipped: results.filter((r) => r.status === "skipped" || r.status === "needs_setup").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "no_provider" || r.status === "unsupported").length,
  };
}

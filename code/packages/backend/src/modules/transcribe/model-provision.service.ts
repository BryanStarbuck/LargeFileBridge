// Heavyweight-model provisioning for the qwen engine (transcribe_engine.mdx §3). Detect readiness, estimate
// disk, and — only when the user approves — download + install + configure the mlx-qwen3-asr CLI and its
// Qwen/Qwen3-ASR-1.7B weights, each as its own progress job. Idempotent + self-healing (§3.4): a partial
// install re-does only what's missing. Everything runs on-machine; the ONE networked step is the weights
// download (open-source, content-free) which happens only with consent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { track } from "../progress/progress.registry.js";
import { commandExists, spawnAsync, macOSMajorVersion, speechAnalyzerSupported, speechAnalyzerNeedsOsUpdate } from "../../tools/transcribe/audio-prep.js";
import { QWEN_CLI, QWEN_MODEL } from "../../tools/transcribe/qwen-asr.js";
import { isAppleSilicon, pickEngine } from "../../tools/transcribe/engine.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { log } from "../../shared/logging.js";
import type { TranscribeEngineStatus, TranscribeModelReadiness, TranscribeProvisionResult } from "@lfb/shared";

// A fresh mlx-qwen3-asr install + the 1.7B weights: ~3.4 GB weights + ~1 GB of pipx/MLX deps. Used until a
// real install measures the actual size and stores it (§3.1), after which the exact figure is shown.
const DEFAULT_ESTIMATE_BYTES = Math.round(4.4 * 1024 * 1024 * 1024);
// Below this, a present snapshot dir is treated as a half-finished download (partial), not installed.
const MIN_WEIGHTS_BYTES = 500 * 1024 * 1024;

/** The Hugging Face hub cache dir for the Qwen weights (where the CLI downloads them on first run). */
function weightsDir(): string {
  const home = process.env.HOME || os.homedir();
  const hub = process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : path.join(home, ".cache", "huggingface", "hub");
  // HF encodes "Qwen/Qwen3-ASR-1.7B" as "models--Qwen--Qwen3-ASR-1.7B".
  return path.join(hub, `models--${QWEN_MODEL.replace(/\//g, "--")}`);
}

/** Recursive byte size of a directory (follows into HF's blobs/snapshots), capped so it can't run away. */
function dirSizeBytes(dir: string, cap = 100_000): number {
  let total = 0;
  let count = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++count > cap) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.lstatSync(p).size;
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function freeDiskBytes(): number {
  try {
    const st = fs.statfsSync(process.env.HOME || os.homedir());
    return st.bavail * st.bsize;
  } catch (e) {
    // Falls back to 0 (the consent dialog just omits the "X free" line) but this is a real failure worth a
    // trail — a broken statfs means the free-disk warning in the permission popup silently disappears.
    log.warn("transcribe", `freeDiskBytes: statfsSync failed — free-disk check disabled for this request: ${(e as Error).message}`);
    return 0;
  }
}

/** Are the weights present and big enough to be a real snapshot? */
function weightsInstalledBytes(): number {
  const dir = weightsDir();
  if (!fs.existsSync(dir)) return 0;
  return dirSizeBytes(dir);
}

/** Engine + heavyweight-model readiness (transcribe_engine.mdx §3.1) — drives the consent popup + Settings. */
export function describeReadiness(): TranscribeEngineStatus {
  const cfg = getAppConfig();
  const apple = isAppleSilicon();
  const cliInstalled = apple && commandExists(QWEN_CLI);
  const bytes = cliInstalled ? weightsInstalledBytes() : 0;

  let readiness: TranscribeModelReadiness;
  if (!apple) readiness = "unsupported";
  else if (!cliInstalled) readiness = "missing";
  else if (bytes >= MIN_WEIGHTS_BYTES) readiness = "installed";
  else readiness = "partial"; // CLI present but weights not (or only half) downloaded

  const estimate = cfg.transcribe.model_installed_bytes ?? DEFAULT_ESTIMATE_BYTES;

  return {
    active: pickEngine(cfg.transcribe.engine, cfg.transcribe.model_consent),
    configured: cfg.transcribe.engine,
    consent: cfg.transcribe.model_consent,
    appleSilicon: apple,
    // Apple SpeechAnalyzer (the NEW primary) needs no multi-GB download — its model ships in macOS 26+ and
    // per-locale assets auto-download in the Swift helper; only readiness/OS-update state is surfaced here.
    speech: {
      available: speechAnalyzerSupported(),
      osMajor: macOSMajorVersion(),
      needsOsUpdate: speechAnalyzerNeedsOsUpdate(),
      hardwarePossible: apple, // Apple-Silicon hardware can run SpeechAnalyzer once the OS is macOS 26+
    },
    qwen: {
      cliInstalled,
      readiness,
      installedBytes: bytes > 0 ? bytes : null,
      estimateBytes: estimate,
      freeDiskBytes: freeDiskBytes(),
      model: QWEN_MODEL,
    },
    whisper: { installed: commandExists("whisper") },
    ffmpeg: commandExists("ffmpeg"),
  };
}

/** Verify (don't trust) the qwen install (§3.4): CLI on PATH + weights snapshot of a non-trivial size. */
export function healthCheck(): { ok: boolean; readiness: TranscribeModelReadiness } {
  const s = describeReadiness();
  return { ok: s.qwen.readiness === "installed", readiness: s.qwen.readiness };
}

/** Ensure pipx exists (best-effort), then `pipx install mlx-qwen3-asr`. Streamed as an `install` job. */
async function installCli(): Promise<void> {
  if (!commandExists("pipx")) {
    if (commandExists("brew")) {
      await spawnAsync("brew", ["install", "pipx"], { allowFail: true });
      await spawnAsync("pipx", ["ensurepath"], { allowFail: true });
    } else if (commandExists("pip3")) {
      await spawnAsync("pip3", ["install", "--user", "pipx"], { allowFail: true });
    }
  }
  if (!commandExists("pipx")) throw new Error("pipx is required to install mlx-qwen3-asr (try: brew install pipx)");
  const r = await spawnAsync("pipx", ["install", QWEN_CLI], { allowFail: true });
  if (r.status !== 0 && !commandExists(QWEN_CLI)) {
    throw new Error(`pipx install ${QWEN_CLI} failed: ${(r.stderr || r.stdout).split("\n").slice(-2).join(" ").slice(0, 200)}`);
  }
}

/** Warm the weights: transcribe a 1-second synthesized silent clip, which forces the HF download AND
 *  smoke-tests the runtime (§3.3/§3.4). Best-effort — a failure here leaves readiness `partial` to retry. */
async function warmModel(): Promise<void> {
  if (!commandExists("ffmpeg")) {
    // Without ffmpeg we can't synthesize a clip; the weights will download on the user's first real run.
    log.warn("transcribe", "ffmpeg absent — skipping model warm-up; weights download on first transcription");
    return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-qwen-warm-"));
  try {
    const clip = path.join(scratch, "silence.wav");
    await spawnAsync("ffmpeg", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", clip, "-y"], { allowFail: true });
    if (fs.existsSync(clip)) {
      // This pulls the ~3.4 GB weights from Hugging Face on first run — the heavy step the user consented to.
      await spawnAsync(QWEN_CLI, [clip, "--model", QWEN_MODEL, "--language", "English", "-f", "txt", "-o", scratch, "--quiet"], { allowFail: true });
    }
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

let provisioning = false;

/**
 * Download → install → configure the qwen model, ONLY with the user's approval (transcribe_engine.mdx §3.2).
 * Registers an `install` job (pipx CLI) then a `download` job (weights + smoke test), returns immediately —
 * the work drains in the background, watchable on Processing. Idempotent: skips a step already satisfied.
 */
export function provision(): TranscribeProvisionResult {
  if (!isAppleSilicon()) {
    return { started: false, reason: "Qwen3-ASR needs an Apple Silicon Mac — the Whisper (Mac) engine is used instead" };
  }
  const before = describeReadiness();
  if (before.qwen.readiness === "installed") {
    return { started: false, reason: "already installed" };
  }
  if (provisioning) {
    return { started: false, reason: "provisioning already in progress" };
  }
  provisioning = true;

  // Fire-and-forget: two sequential progress jobs. The endpoint returns now; these run in the background.
  void (async () => {
    try {
      if (!commandExists(QWEN_CLI)) {
        await track("install", "Qwen3-ASR CLI (mlx-qwen3-asr)", async () => {
          await installCli();
          return { installed: true };
        });
      }
      await track("download", "Qwen3-ASR model (Qwen3-ASR-1.7B)", async () => {
        await warmModel();
        return { warmed: true };
      });
      // Store the MEASURED on-disk size so future estimates are exact (§3.1).
      const bytes = weightsInstalledBytes();
      if (bytes > 0) {
        await updateAppConfig((c) => {
          c.transcribe.model_installed_bytes = bytes;
          if (!c.transcribe.model_consent) c.transcribe.model_consent = "approved";
          return c;
        });
      }
      log.info("transcribe", `qwen model provisioned (${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB on disk)`);
    } catch (e) {
      log.error("transcribe", `qwen provisioning failed: ${(e as Error).message}`);
    } finally {
      provisioning = false;
    }
  })();

  return { started: true, reason: null };
}

/** Repair a partial/broken install (§3.4): re-do only what's missing (same idempotent flow as provision). */
export function repair(): TranscribeProvisionResult {
  return provision();
}

/** Remove the downloaded weights to free disk (Settings → Transcription §6). Leaves the CLI installed. */
export function removeModel(): { removed: boolean; freedBytes: number } {
  const dir = weightsDir();
  const freed = fs.existsSync(dir) ? dirSizeBytes(dir) : 0;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn("transcribe", `could not remove qwen weights: ${(e as Error).message}`);
    return { removed: false, freedBytes: 0 };
  }
  void updateAppConfig((c) => {
    c.transcribe.model_installed_bytes = null;
    return c;
  });
  return { removed: true, freedBytes: freed };
}

/** Persist the user's engine choice from Settings → Transcription (transcribe_engine.mdx §6). `auto` lets
 *  pickEngine resolve the best available for this machine; the others pin a specific engine. Returns fresh
 *  readiness so the panel's "active engine" reflects the new selection immediately. */
export async function setEngineChoice(
  engine: "auto" | "speech" | "qwen" | "mac",
): Promise<TranscribeEngineStatus> {
  await updateAppConfig((c) => {
    c.transcribe.engine = engine;
    return c;
  });
  return describeReadiness();
}

/** Persist the user's consent decision from the popup (§3.2) so it does not nag again. */
export async function recordConsent(decision: "approved" | "declined" | "use_fallback"): Promise<void> {
  try {
    await updateAppConfig((c) => {
      c.transcribe.model_consent = decision;
      return c;
    });
  } catch (e) {
    // A failure here means the popup will nag again next time — not silent data loss, but worth a trail.
    log.error("transcribe", `recordConsent(${decision}) failed to persist: ${(e as Error).message}`);
    throw e;
  }
}

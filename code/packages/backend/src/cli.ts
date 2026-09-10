// `lfb` CLI — operate the store without the web app (scan/pin/install/transcribe). tsx entry.
//
// WHY TRANSCRIPTION IS ON THE CLI AND NOT ONLY IN THE WEB APP: a transcription is minutes-to-hours of
// local CPU, and tying it to a long-lived HTTP server makes that server's uptime a precondition for
// getting any words at all. That is not hypothetical — the sibling We The Citizens run that prompted
// the rich pipeline lost a whole 20-video batch because its API process was restarted by a file
// watcher mid-job, three times, and its CLI is a thin HTTP client with nothing to fall back to. These
// verbs run the pipeline IN THIS PROCESS: no server, no port, no watcher, and the words are on disk
// before the process exits.
import fs from "node:fs";
import path from "node:path";
import { scanAll } from "./modules/scanner/scanner.service.js";
import { pinAll } from "./modules/pin/pin.service.js";
import { control } from "./modules/schedule/schedule.service.js";
import { log } from "./shared/logging.js";
import { formatRichStatus, transcribeRich, type RichTranscribeResult } from "./tools/transcribe/rich.js";
import { timedAsrAvailability } from "./tools/transcribe/timed-asr.js";
import { diarizeAvailability, modelSearchDirs } from "./tools/transcribe/diarize.js";
import { isTranscribableExt } from "./tools/transcribe/audio-prep.js";
import type { EnginePreference } from "./tools/transcribe/engine.js";

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

interface Flags {
  positional: string[];
  get(name: string): string | undefined;
  has(name: string): boolean;
}

/** `--key value` and `--key=value` both, plus bare `--flag`. No dependency, no surprises. */
function parseFlags(argv: string[]): Flags {
  const map = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      map.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(name, next);
      i++;
    } else {
      map.set(name, "true");
    }
  }
  return { positional, get: (n) => map.get(n), has: (n) => map.has(n) };
}

/** Report what the machine can actually do, so a caller never promises a layer it cannot produce. */
async function transcribeCapability(): Promise<void> {
  const timed = timedAsrAvailability();
  const diar = await diarizeAvailability();
  out("transcription capability on this machine");
  out("─".repeat(72));
  out(`  timed ASR      ${timed.ok ? `yes — whisper.cpp / ${path.basename(timed.model)}` : `NO — ${timed.detail}`}`);
  out(
    `  diarization    ${diar.ok ? `yes — ${diar.engine} / ${path.basename(diar.segModel)} + ${path.basename(diar.embModel)}` : `NO — ${diar.detail}`}`,
  );
  out(`  model search   ${modelSearchDirs().join("\n                 ")}`);
  out("");
  if (!timed.ok) {
    out("  Without timed ASR the words are still produced by the plain-text engine chain,");
    out("  but there are no timings, so no .srt/.vtt/.ctm can be written.");
  }
  if (!diar.ok) {
    out("  Without diarization the words and timings are complete; the speaker layer is");
    out("  absent and every script cue reads UNIDENTIFIED SPEAKER.");
  }
  // The JSON line is what a script reads, the same shape the sibling product's `capability` prints.
  out(
    JSON.stringify({
      timed_asr: timed.ok,
      timed_asr_detail: timed.ok ? path.basename(timed.model) : timed.detail,
      diarization: diar.ok,
      diarization_detail: diar.ok ? diar.engine : diar.detail,
    }),
  );
}

/**
 * `lfb transcribe <file…>` — the standalone pipeline.
 *
 * The status FILE is the point of this verb rather than a nicety: a batch of long files is exactly
 * the job a caller walks away from, and "what finished, what degraded and why" has to survive the
 * terminal scrollback. It is appended per file as each one completes, so an interrupted batch still
 * leaves an accurate record of everything that did finish.
 */
async function transcribeCmd(argv: string[]): Promise<number> {
  const f = parseFlags(argv);
  if (!f.positional.length) {
    out("lfb transcribe <file…> [--out DIR] [--key KEY] [--title T] [--recorded ISO_DATE]");
    out("                       [--max-speakers N] [--no-diarize] [--status FILE]");
    out("                       [--engine auto|speech|mac|qwen]");
    out("");
    out("  --out           where the files are written (default: beside the input)");
    out("  --key           output file stem and the RTTM/CTM id (default: input basename);");
    out("                  only meaningful for a single input");
    out("  --recorded      the date the MEDIA was recorded. Never inferred — omit if unknown.");
    out("  --max-speakers  constrain clustering to a KNOWN speaker count. Omit unless certain:");
    out("                  forcing 2 on a montage merges three voices into two.");
    out("  --status        status report file (default: <out>/transcribe_status.txt)");
    return 2;
  }

  const inputs = f.positional.filter((p) => {
    if (!fs.existsSync(p)) {
      out(`skipping (does not exist): ${p}`);
      return false;
    }
    if (!isTranscribableExt(p)) {
      out(`skipping (not transcribable): ${p}`);
      return false;
    }
    return true;
  });
  if (!inputs.length) return 3;

  const explicitKey = f.get("key");
  if (explicitKey && inputs.length > 1) {
    out("--key names ONE output stem and you passed several inputs — drop it, or run them one at a time.");
    return 2;
  }

  const results: RichTranscribeResult[] = [];
  for (const input of inputs) {
    const outDir = f.get("out") ?? path.dirname(path.resolve(input));
    const key = explicitKey ?? path.basename(input, path.extname(input));
    const rawMax = f.get("max-speakers");
    const maxSpeakers = rawMax ? Number.parseInt(rawMax, 10) : null;
    process.stderr.write(`transcribing ${key}…\n`);
    const r = await transcribeRich(path.resolve(input), {
      key,
      outDir: path.resolve(outDir),
      title: f.get("title") ?? null,
      recordedOn: f.get("recorded") ?? null,
      maxSpeakers: maxSpeakers !== null && Number.isFinite(maxSpeakers) ? maxSpeakers : null,
      noDiarize: f.has("no-diarize"),
      fallbackEngine: (f.get("engine") as EnginePreference) ?? "auto",
      onStage: (stage, detail) => process.stderr.write(`  ${stage}${detail ? ` ${detail}` : ""}\n`),
    });
    results.push(r);
    out(formatRichStatus(r));

    const statusFile = f.get("status") ?? path.join(path.resolve(outDir), "transcribe_status.txt");
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.appendFileSync(statusFile, `${new Date().toISOString()}\n${formatRichStatus(r)}\n\n`, "utf8");
    } catch (e) {
      process.stderr.write(`could not write status file ${statusFile}: ${(e as Error).message}\n`);
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const degraded = results.filter((r) => r.status === "ok" && r.notes.length > 0).length;
  out("");
  out(`${ok} of ${results.length} transcribed${degraded ? `, ${degraded} degraded (see the notes above)` : ""}`);
  // Non-zero when anything failed outright, so a shell loop can tell.
  return ok === results.length ? 0 : 1;
}

async function run(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const [a] = rest;
  switch (cmd) {
    case "scan":
      await scanAll("manual");
      break;
    case "pin":
      await pinAll();
      break;
    case "transcribe":
      process.exitCode = await transcribeCmd(rest);
      break;
    case "transcribe-capability":
    case "capability":
      await transcribeCapability();
      break;
    case "install-agent": {
      const worker = (a as "scan" | "pin") || "pin";
      await control(worker, "install");
      await control(worker, "enable");
      break;
    }
    case "uninstall-agent":
      await control((a as "scan" | "pin") || "pin", "uninstall");
      break;
    default:
      out("lfb <scan|pin|transcribe|capability|install-agent [scan|pin]|uninstall-agent [scan|pin]>");
      out("");
      out("  transcribe <file…>   words + timings + speakers + the seven standard formats");
      out("  capability           what this machine can actually produce right now");
  }
}

run().catch((e) => {
  log.error("cli", (e as Error).message);
  process.exit(1);
});

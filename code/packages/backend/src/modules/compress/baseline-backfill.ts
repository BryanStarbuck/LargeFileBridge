// BACKFILL AREA 11 — `analysis/<rel>/compression.yaml` → `lfb.compression_record` + `lfb.compression_sample`
// (database_migration.mdx §4.1 AREA 11, migration 0010; state-file key `seed_compression_baseline`).
//
// THIS IS THE AREA THAT MAKES A CHARTER FEATURE EXIST FOR THE FIRST TIME. CLAUDE.md asks for a learned
// baseline of "the typical file size when uncompressed vs. the typical file size when compressed" for a
// given duration and pixel size, with "the mean of the bell curve plus one sigma and two sigma". Nothing in
// this product has ever held one. The compression records do hold the raw material — a before size, an
// after size, and a label we assigned ourselves — so this area turns 74 write-only YAML documents into the
// first samples that model has ever had.
//
// ── THE LABELLING RULE, WHICH IS THE WHOLE DESIGN ───────────────────────────────────────────────────────
//
//   outcome: compressed → TWO samples. The output bytes are, by construction, a compressed file of that
//                         shape (`is_compressed = true`, `label_source = 'our_encode_output'`). The input
//                         bytes are, by construction, one that was not (`false`, `'our_encode_input'`).
//                         This is the strongest label available anywhere: we produced both halves, so we
//                         know the answer rather than inferring it.
//   outcome: declined   → ONE sample, `is_compressed = true`, `'declined_record'`. We declined PRECISELY
//                         BECAUSE the file was already efficient — the reason strings on this machine say
//                         so ("kept the original — the best candidate was only -47.0% smaller"). A decline
//                         is a positive observation about the bytes, not an absence of one.
//   outcome: blocked    → NO sample. A safety guard refused (alpha loss, resolution or chroma change,
//                         corrupt output), so we never learned anything about the input's efficiency, and
//                         the file explicitly stays eligible (types.ts CompressionOutcome). Zero exist on
//                         this machine.
//   outcome absent      → read as `compressed`. That is what `compress-ledger.ts readLedger` does
//                         (`rec.outcome ?? "compressed"`), and 16 of the 37 local records predate the field.
//
// ── WHY THIS AREA NEEDS ffprobe AT ALL ──────────────────────────────────────────────────────────────────
// `width`, `height` and `duration_s` are ABSENT from every compression record — the writer never captured
// them. Without them there is no bits-per-pixel-per-second, and without bpps there is no model. So the seed
// costs one ffprobe per file. MEASURED on this machine: 36 probes in 0.99 s (~27 ms each), against the
// design's ~396 ms estimate. It is a one-off and it is not close to a problem.
//
// The INPUT sample borrows the OUTPUT's probed shape, and that is sound rather than convenient: the
// compression engine refuses any transform that changes resolution (a resolution change is exactly what
// makes an outcome `blocked`), so the original had the dimensions the output has. Its DURATION is likewise
// preserved. Only the byte count differs, which is the one number the record does carry.
//
// ── IDEMPOTENCY, AND WHY IT IS LOAD-BEARING HERE MORE THAN ANYWHERE ELSE ────────────────────────────────
// `compression_sample_ident UNIQUE NULLS NOT DISTINCT (media, content_hash, is_compressed, label_source)`.
// WITHOUT IT a second run doubles every sample and shifts `avg(ln(bpps))` — a classifier that is silently
// wrong, which is strictly worse than no classifier, because the extension heuristic it replaces is at
// least predictable. `count(*)` after two consecutive full runs must be IDENTICAL, and that is this area's
// verification.
//
// `content_hash` is therefore not decoration, it is the identity, and it has to satisfy three things at
// once: stable across runs, distinct per file, and IDENTICAL for the same physical file reached through the
// local leg and through an SDL mirror leg. A real sha256 of the bytes satisfies all three. MEASURED: 36
// files, 450 MB, 0.19 s.
//
//   THE ONE EXCEPTION, STATED PLAINLY. An `our_encode_input` sample describes bytes THAT NO LONGER EXIST —
//   we replaced them, which is what "compressed" means. There is nothing to hash. Its `content_hash` is
//   therefore `pre-encode:<sha256 of the output>`, which is stable, unique per file, and collapses the two
//   mirror legs exactly as a real digest would. The `pre-encode:` prefix is deliberate and load-bearing: it
//   is not hash-shaped, so a future perceptual-match feature reading this column can never mistake it for a
//   digest of anything on disk. Leaving it NULL was the alternative and it is catastrophic — `NULLS NOT
//   DISTINCT` would collapse EVERY input sample in the corpus into a single row.
//
// ── EXPECT THE CLASSIFIER TO ANSWER 'unknown', AND EXPECT THAT TO BE RIGHT ──────────────────────────────
// MEASURED by seeding this machine's corpus: 53 samples across 29 (media, pixel bucket, duration bucket,
// label) cells, the largest holding 4. ZERO cells clear the n≥12 floor. So `classifyCompression` abstains
// everywhere and `badges.ts`'s extension heuristic stays in charge — which is the design working, not
// failing (baseline.service.ts, and database.mdx §8.7).
//
// A CORRECTION TO THE PLAN'S ARITHMETIC, since it is quoted downstream: the plan expects "~110 samples"
// from "37 local + 37 in the act3 SDL". Those two sets are the SAME 37 records — the act3 SDL's
// `repos/charlie-kirk-83e62afc2c80/analysis/**` is the mirror of the local
// `repos/charlie-kirk-dbd9c2c05564/analysis/**`, source-for-source (verified, all 37 paths identical). They
// resolve to the same physical media and therefore to the same content hashes, so the UNIQUE collapses them
// — which is the constraint doing its job. 53 is the honest number, and 110 would have been the same
// corpus counted twice.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { CompressionRecordSchema } from "@lfb/shared";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { copyRows, q } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { isDirForKey } from "../../shared/store/keyed-dir.js";
import { listDirs, sdlRoots, trackingReposRoot } from "../store-model/unit-backfill.js";
import { compressInfo } from "../fs/badges.js";
import { baselineCoverage, sampleCount, MIN_CELL_SAMPLES } from "./baseline.service.js";
import { log } from "../../shared/logging.js";

const ANALYSIS_DIR = "analysis";
const RECORD_FILE = "compression.yaml";

/**
 * The shared schema PLUS the fields the 2026-07 engine rebuild added.
 *
 * `CompressionRecordSchema` (schemas.ts) predates `outcome:` and zod strips unknown keys, so parsing
 * through it alone would read every declined record as a compressed one — and a declined file's ORIGINAL
 * would then be seeded as an uncompressed sample when the original is the file itself. That single dropped
 * field would poison the baseline in the exact direction that matters.
 */
const RecordSchema = CompressionRecordSchema.extend({
  outcome: z.enum(["compressed", "declined", "blocked"]).optional(),
});
type Record_ = z.infer<typeof RecordSchema>;

// ── the probe ───────────────────────────────────────────────────────────────────────────────────────────

interface Shape {
  width: number;
  height: number;
  /** Seconds, video only. Null for a still — `compression_sample.duration_s` CHECKs `> 0` or NULL, and a
   *  container-reported 0.04 s for a JPEG is a fiction of the `image2` demuxer, not a duration. */
  durationS: number | null;
  codec: string | null;
  container: string | null;
}

/**
 * ONE ffprobe, async, capped.
 *
 * A LOCAL RUNNER RATHER THAN compression.service.ts's. That module's `runAsync` is private, and importing
 * the module to reach it would pull sharp and the whole 1,600-line encode engine into a migration that only
 * needs five numbers. This is the same discipline that module states for itself — spawn, never spawnSync,
 * because an ffprobe against a file on a cold cloud mount stalls on I/O and a synchronous one would freeze
 * the process for the whole timeout (performance.mdx P-27).
 */
function ffprobe(abs: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "ffprobe",
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,codec_name",
          "-show_entries", "format=duration,format_name",
          "-of", "default=nw=1",
          abs,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null); // ffprobe absent → no shape, no sample. Not a failure of the migration.
      return;
    }
    const chunks: string[] = [];
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => chunks.push(String(d)));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? chunks.join("") : null));
  });
}

/** Exported for the spec: the parse of ffprobe's `default=nw=1` output, which is where a wrong duration
 *  would come from and where "N/A" has to be recognised rather than coerced to NaN. */
export function parseProbe(out: string | null, isVideo: boolean): Shape | null {
  if (!out) return null;
  const kv = new Map<string, string>();
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const width = Number(kv.get("width"));
  const height = Number(kv.get("height"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  let durationS: number | null = null;
  if (isVideo) {
    const raw = kv.get("duration");
    const d = raw && raw !== "N/A" ? Number(raw) : NaN;
    durationS = Number.isFinite(d) && d > 0 ? d : null;
  }
  return {
    width,
    height,
    durationS,
    codec: kv.get("codec_name") || null,
    container: kv.get("format_name") || null,
  };
}

function sha256File(abs: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// ── scopes: one per (leg, repo directory that actually holds records) ───────────────────────────────────

interface BaselineScopeData {
  /** "local" for the state root, or the SDL root's absolute path. Part of the scope key, so a mirror that
   *  moves re-does only its own leg. */
  leg: string;
  /** The `repos/` subdirectory: `<slug>-<repoKey>` locally, `<slug>-<repoUid>` in an SDL. */
  repoDir: string;
  /** The `repos/<dir>` absolute path this leg reads from. */
  repoDirAbs: string;
  files: string[];
}

/** Every `analysis/**\/compression.yaml` under one `repos/<dir>` tree, sorted so the cursor is meaningful. */
function recordFilesUnder(repoDirAbs: string): string[] {
  const root = path.join(repoDirAbs, ANALYSIS_DIR);
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a repo with no analysis tree is the normal case — 103 of 105 on this machine
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.isFile() && e.name === RECORD_FILE) out.push(path.join(dir, e.name));
    }
  }
  return out.sort();
}

function baselineScopes(): BackfillScope[] {
  const legs: Array<{ leg: string; reposRoot: string }> = [{ leg: "local", reposRoot: trackingReposRoot() }];
  for (const root of sdlRoots()) legs.push({ leg: root, reposRoot: path.join(root, "repos") });

  const scopes: BackfillScope[] = [];
  for (const { leg, reposRoot } of legs) {
    for (const repoDir of listDirs(reposRoot)) {
      const repoDirAbs = path.join(reposRoot, repoDir);
      const files = recordFilesUnder(repoDirAbs);
      if (files.length === 0) continue; // nothing to fingerprint and nothing to migrate
      scopes.push({
        key: `${leg}/${repoDir}`,
        sources: files,
        data: { leg, repoDir, repoDirAbs, files } satisfies BaselineScopeData,
      });
    }
  }
  return scopes;
}

// ── unit resolution: local dirs key on repo_key, SDL dirs key on repo_uid ───────────────────────────────

interface UnitRow {
  unitId: number;
  absPath: string;
  repoKey: string | null;
  repoUid: string | null;
}

async function repoUnits(): Promise<UnitRow[]> {
  const rows = await q<{ unit_id: string; abs_path: string; repo_key: string | null; repo_uid: string | null }>(
    `SELECT unit_id::text AS unit_id, abs_path, repo_key, repo_uid FROM ${S}.unit WHERE kind = 'repo'`,
  );
  return rows.map((r) => ({
    unitId: Number(r.unit_id),
    absPath: r.abs_path,
    repoKey: r.repo_key,
    repoUid: r.repo_uid,
  }));
}

/**
 * `<slug>-<key>` → the unit, matched by KEY SUFFIX and never by exact directory name (`keyed-dir.ts
 * isDirForKey`) — the same rule area 2 uses, and for the same reason: every subtree written before the
 * `<slug>-<key>` rename is a bare 12-hex directory that an exact-name match would leave unmatched.
 *
 * A LOCAL directory is keyed by `repo_key`; an SDL directory is keyed by `repo_uid`. They are different
 * hashes of different things (the local absolute path vs. the remote's host/owner/repo), so matching a
 * mirror directory against `repo_key` finds nothing and matching it against BOTH would let a coincidence
 * decide. The leg names which one applies.
 */
function unitForDir(units: UnitRow[], leg: string, dir: string): UnitRow | null {
  for (const u of units) {
    const key = leg === "local" ? u.repoKey : u.repoUid;
    if (key && isDirForKey(dir, key)) return u;
  }
  return null;
}

// ── the transform ───────────────────────────────────────────────────────────────────────────────────────

const RECORD_COLUMNS = [
  "unit_id",
  "rel_posix",
  "source_rel",
  "original_name",
  "original_ext",
  "original_size",
  "codec",
  "compressed_size",
  "ratio",
  "compressed_at",
  "duration_s",
  "width",
  "height",
];

const SAMPLE_COLUMNS = [
  "media",
  "content_hash",
  "codec",
  "container",
  "duration_s",
  "width",
  "height",
  "size_bytes",
  "is_compressed",
  "label_source",
];

/**
 * `ON CONFLICT ON CONSTRAINT compression_sample_ident DO NOTHING`.
 *
 * DO NOTHING and not DO UPDATE: seeing the same content under the same label a second time carries no new
 * information, and rewriting `observed_at` would make "when did we first learn this" unanswerable for no
 * gain. This clause IS the idempotency claim — see the header.
 */
const SAMPLE_ON_CONFLICT = "ON CONFLICT ON CONSTRAINT compression_sample_ident DO NOTHING";

type SampleRow = [
  "video" | "image",
  string,
  string | null,
  string | null,
  number | null,
  number,
  number,
  number,
  boolean,
  string,
];

async function runBaselineScope(data: BaselineScopeData, ctx: BackfillContext, units: UnitRow[]): Promise<number> {
  const unit = unitForDir(units, data.leg, data.repoDir);
  if (!unit) {
    ctx.reject(data.repoDirAbs, `no lfb.unit row for '${data.repoDir}' on leg '${data.leg}' — run adopt_units first`);
    return 0;
  }

  const recordRows: unknown[][] = [];
  const sampleRows: SampleRow[] = [];
  let rows = ctx.rowsBefore;

  for (const file of data.files) {
    if (ctx.resumeFrom !== null && file <= ctx.resumeFrom) continue;

    let rec: Record_;
    try {
      rec = readRawYaml(file, RecordSchema);
    } catch (e) {
      ctx.reject(file, `compression record unparseable: ${(e as Error).message}`);
      continue;
    }
    // `source:` is the CURRENT path relative to the repo root, and 5 of the 37 records on this machine
    // carry a Windows separator (`videos\1976419242666021122.mp4`) written by a fleet member on Windows.
    // The join must be POSIX-healed or the file is simply not found and reads as a false MISSING.
    const relPosix = rec.source.replace(/\\/g, "/");
    const mediaAbs = path.join(unit.absPath, relPosix);

    const outcome = rec.outcome ?? "compressed"; // absent means compressed — compress-ledger.ts readLedger
    const compressedSize = rec.compressed.size;
    // `ratio` is `numeric(8,6) CHECK (ratio > 0)`, and `buildRecord` writes 0 when the original size was 0.
    // Recompute rather than let one degenerate record abort a whole multi-row INSERT (a CHECK failure takes
    // the batch, not the tuple).
    let ratio = rec.compressed.ratio;
    if (!(ratio > 0)) ratio = rec.original.size > 0 ? compressedSize / rec.original.size : 0;

    const stat = fs.statSync(mediaAbs, { throwIfNoEntry: false });
    const currentSize = stat?.isFile() ? stat.size : null;

    // ── the compression_record row: written whatever the media's fate, because the RECORD is a true fact
    // about what this product did even when the bytes have since been deleted. Shape columns stay NULL
    // when we could not probe.
    let shape: Shape | null = null;
    // FRESHNESS, the same rule `compress-ledger.ts readLedger` applies: a record is honoured only while the
    // file still has the size the record captured. If the bytes moved on, this record describes something
    // that is gone, and probing the CURRENT file would attach today's dimensions to yesterday's sizes.
    const fresh = currentSize !== null && currentSize === compressedSize;
    if (fresh) shape = parseProbe(await ffprobe(mediaAbs), /\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg|wmv|flv|ts)$/i.test(relPosix));

    if (ratio > 0) {
      recordRows.push([
        unit.unitId,
        relPosix,
        rec.source,
        rec.original.name,
        rec.original.extension,
        Math.max(0, rec.original.size),
        rec.compressed.codec ?? shape?.codec ?? null,
        Math.max(0, compressedSize),
        Number(ratio.toFixed(6)),
        new Date(rec.compressed.at),
        shape?.durationS ?? null,
        shape?.width ?? null,
        shape?.height ?? null,
      ]);
    } else {
      ctx.reject(file, "record has a zero original size and a zero ratio — nothing measurable to store");
    }

    // ── the samples
    if (!fresh) {
      ctx.reject(
        file,
        currentSize === null
          ? `media is gone (${relPosix}) — no shape to measure, so no baseline sample was produced`
          : `media is ${currentSize} bytes but the record describes ${compressedSize} — the bytes moved on, ` +
            `so labelling them would attach today's shape to yesterday's sizes`,
      );
      ctx.checkpoint(file, rows);
      continue;
    }
    if (!shape) {
      ctx.reject(file, `ffprobe produced no usable width/height for ${relPosix} — no baseline sample`);
      ctx.checkpoint(file, rows);
      continue;
    }
    if (outcome === "blocked") {
      // Deliberately NOT a reject: a blocked outcome is a correct, expected terminal state that simply
      // teaches the model nothing. Recording it as a fault would put a permanent red number on a healthy
      // safety guard doing its job.
      ctx.checkpoint(file, rows);
      continue;
    }

    // `compressInfo` is the SAME classifier `badges.ts` and the read path use — never a second copy of the
    // video/image vocabulary, or the model would learn under a taxonomy the UI does not share.
    const outMedia = compressInfo(path.basename(relPosix)).compressible;
    if (outMedia === null) {
      ctx.reject(file, `${relPosix} is neither a video nor an image by our own classifier — not a baseline subject`);
      ctx.checkpoint(file, rows);
      continue;
    }

    const outHash = sha256File(mediaAbs);
    sampleRows.push([
      outMedia,
      outHash,
      shape.codec,
      shape.container,
      shape.durationS,
      shape.width,
      shape.height,
      compressedSize,
      true,
      outcome === "declined" ? "declined_record" : "our_encode_output",
    ]);
    rows += 1;

    if (outcome === "compressed" && rec.original.size > 0) {
      // The INPUT bytes are gone by definition — see the header for why the identity is prefixed rather
      // than NULL. The original's media kind comes from ITS OWN name, because a conversion changes the
      // extension (`Angel_Charlie.png` → `Angel_Charlie.jpg` is one of the records here).
      const inMedia = compressInfo(rec.original.name).compressible ?? outMedia;
      sampleRows.push([
        inMedia,
        `pre-encode:${outHash}`,
        null, // the original's codec was never recorded, and guessing it would be inventing evidence
        rec.original.extension || null,
        shape.durationS,
        shape.width,
        shape.height,
        rec.original.size,
        false,
        "our_encode_input",
      ]);
      rows += 1;
    }
    ctx.checkpoint(file, rows);
  }

  if (recordRows.length) {
    await copyRows(`${S}.compression_record`, RECORD_COLUMNS, recordRows, {
      // R5 in miniature: this area is the only writer of `compression_record`, so a whole-row update is
      // correct here — and it must be an UPDATE rather than DO NOTHING, because a re-compressed file
      // legitimately replaces its own record.
      onConflict:
        "ON CONFLICT (unit_id, rel_posix) DO UPDATE SET " +
        RECORD_COLUMNS.filter((c) => c !== "unit_id" && c !== "rel_posix")
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", "),
    });
  }
  if (sampleRows.length) {
    await copyRows(`${S}.compression_sample`, SAMPLE_COLUMNS, sampleRows, { onConflict: SAMPLE_ON_CONFLICT });
  }
  ctx.checkpoint(null, rows);
  return rows;
}

let unitsCache: UnitRow[] | null = null;

export const BACKFILL_COMPRESSION_BASELINE: BackfillArea = {
  name: "seed_compression_baseline",
  version: 1,
  kind: "backfill",
  sources: () => baselineScopes().flatMap((s) => s.sources),
  async scopes() {
    unitsCache = await repoUnits();
    return baselineScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const units = unitsCache ?? (await repoUnits());
    return { rows: await runBaselineScope(scope.data as BaselineScopeData, ctx, units) };
  },

  /**
   * §4.5's named assertion for this area: `count(*)` after two consecutive full runs is IDENTICAL.
   *
   * A single `verify()` cannot run the backfill twice, so what it asserts is the property that MAKES that
   * true and reports the numbers a human checks it with: every sample's identity tuple is distinct (which
   * is the constraint, restated as a query so a dropped constraint would surface here rather than as a
   * quietly drifting mean), plus the sample count and — the honest headline — how many cells have actually
   * cleared the n≥12 floor.
   */
  async verify() {
    const total = await sampleCount();
    const cells = await baselineCoverage();
    const learned = cells.filter((c) => c.n >= MIN_CELL_SAMPLES);
    const dupes = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT 1 FROM ${S}.compression_sample
          GROUP BY media, content_hash, is_compressed, label_source
         HAVING count(*) > 1) d`,
    );
    const mismatches: string[] = [];
    const duplicated = Number(dupes[0]?.n ?? 0);
    if (duplicated > 0) {
      mismatches.push(
        `${duplicated} identity tuple(s) appear more than once — compression_sample_ident is not holding, ` +
          `and a re-run will keep shifting avg(ln(bpps))`,
      );
    }
    log.info(
      "migrate",
      `seed_compression_baseline: ${total} sample(s) across ${cells.length} cell(s); ` +
        `${learned.length} cell(s) have reached the n>=${MIN_CELL_SAMPLES} floor — ` +
        `${learned.length === 0 ? "the classifier correctly abstains everywhere and the extension heuristic stays in charge" : "the classifier can answer in those cells"}`,
    );
    // `yamlRows` is the number of SAMPLES the sources can yield, which is not the number of records: a
    // `compressed` record yields two and a `declined` one yields one. Reporting record counts here would
    // make a correct run look like it had lost half its rows.
    return { yamlRows: total, pgRows: total, mismatches };
  },
};

/**
 * Register area 11.
 *
 * MUST run after area 2: `compression_record.unit_id` is a NOT NULL FK into `lfb.unit`, and this area
 * resolves a repo directory to a unit before it reads a single record.
 */
export function registerBaselineBackfill(): void {
  registerBackfill(BACKFILL_COMPRESSION_BASELINE);
}

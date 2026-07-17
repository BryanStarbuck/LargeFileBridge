// PDF PAGE RASTERIZATION for OCR (ocr.mdx §1.7.1 + §2.4). A PDF is a stack of PAGES; we render each page to a
// PNG and read it with the SAME engine an image uses (§16). A legal contract, a scanned agreement, or a slide
// export all become searchable text this way — the document analogue of the video path's frame sampling.
//
// THE TOOL IS POPPLER'S `pdftoppm`, detected on PATH — the SAME posture as the video path's ffmpeg (§6). PDF
// rasterization is not something we can do in pure JS without a heavyweight native/WASM renderer, so — exactly
// like video decoding — we lean on a proven external tool and STATE the asymmetry when it is missing (every
// image OCRs fine; PDFs need the tool). `pdfinfo` (shipped alongside `pdftoppm` in poppler) gives the true
// page count so a max-pages truncation can be reported honestly (rule 7 — no silent caps).
//
// Everything here is ASYNC (§10.4, LOCKED): `spawn`, awaited — never `spawnSync`, the rule whose violation
// made the Processing page unloadable during a mass run (performance.mdx P-27).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { registerChildProcess, unregisterChildProcess } from "../../shared/heap-watch.js";
import { acquireTranscodeSlot } from "../describe/fit-media.js";
import { toolOnPath } from "./frames.js";
import { log } from "../../shared/logging.js";

/** Render DPI. 150 keeps body text crisply legible for the recognizer while a letter page stays ~1275×1650 —
 *  well inside what Vision reads without paying 4× the pixels a 300-DPI render would cost per page. */
const RENDER_DPI = 150;

/** One rasterized page: the temp PNG and the 1-based page number it came from. */
export interface RenderedPage {
  file: string;
  page: number;
}

export interface PdfRender {
  pages: RenderedPage[];
  /** Total pages in the document (from `pdfinfo`), or null when it couldn't be read. */
  pageCount: number | null;
  /** True when max_pages bit and only the first N pages were rendered (§15.2 rule 7, applied to PDFs). */
  truncated: boolean;
  cleanup: () => Promise<void>;
}

/** Fold a child's multi-line stderr into ONE log line — the same one-fault-per-line discipline the video
 *  path uses (frames.ts `oneLineStderr`); a raw paste breaks every log reader and the repeat-collapser. */
function oneLineStderr(stderr: string, max = 300): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "(no stderr)";
  const tail = lines.slice(-3).join(" | ").replace(/\s+/g, " ");
  return tail.length > max ? `…${tail.slice(-max)}` : tail;
}

/** Run a child process to completion, capturing stdout/stderr. Async (§10.4). `label` attributes the child's
 *  RSS in a heap warning so a runaway pdftoppm is identifiable as OCR's, not anonymous. */
async function runAsync(cmd: string, args: string[], label: string, timeoutMs = 30 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerChildProcess(child.pid, label);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      unregisterChildProcess(child.pid);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregisterChildProcess(child.pid);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** The tool the PDF path needs: poppler's `pdftoppm`. Images need NO external tool at all (§6) — state the
 *  asymmetry rather than papering over it, exactly as the video path does for ffmpeg. */
export function pdfToolsPresent(): boolean {
  return toolOnPath("pdftoppm");
}

/** Total pages via `pdfinfo`, or null when it can't be read (a missing count is not fatal — we simply can't
 *  detect truncation, and the render still emits what it emits). */
export async function pdfPageCount(abs: string): Promise<number | null> {
  if (!toolOnPath("pdfinfo")) return null;
  try {
    const { code, stdout } = await runAsync("pdfinfo", [abs], `ocr-pdfinfo:${path.basename(abs)}`, 60_000);
    if (code !== 0) return null;
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Render up to `maxPages` pages of a PDF to temp PNGs and return them in page order.
 *
 * Holds the SHARED transcode slot for the render pass only (§10.3) — the same semaphore the video frame
 * extraction and describe's compress-to-fit draw from, so a PDF render, an OCR frame extraction, and a
 * describe transcode compete for ONE core budget instead of each believing it owns the machine. Released
 * BEFORE the caller recognizes: holding it across recognition would serialize the reads behind the render's
 * budget.
 */
export async function renderPdfPages(abs: string, opts: { maxPages: number }): Promise<PdfRender> {
  const dir = path.join(resolveStateDir(), "ocr-pdf", randomUUID());
  ensureDir(dir);
  const cleanup = async (): Promise<void> => {
    // A 200-page render is real disk; best-effort so a failed cleanup never fails the OCR that succeeded.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const pageCount = await pdfPageCount(abs);
    const lastPage = pageCount != null ? Math.min(pageCount, opts.maxPages) : opts.maxPages;

    const release = await acquireTranscodeSlot();
    try {
      // `-png` output, `-r` DPI, `-f 1 -l lastPage` bounds the range. Files land as `<prefix>-<n>.png` with
      // the page number zero-padded to the document's width, so a lexical sort is also a page-number sort.
      const { code, stderr } = await runAsync(
        "pdftoppm",
        ["-png", "-r", String(RENDER_DPI), "-f", "1", "-l", String(lastPage), abs, path.join(dir, "page")],
        `ocr-pdf:${path.basename(abs)}`,
      );
      if (code !== 0) {
        throw new Error(`pdftoppm failed (exit ${code}) rendering ${path.basename(abs)}: ${oneLineStderr(stderr)}`);
      }
    } finally {
      // Release BEFORE the caller recognizes (§10.3) — the slot covers the render pass only.
      release();
    }

    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    // pdftoppm names files `page-<n>.png`; recover the true page number from the name rather than assuming a
    // dense 1..N (a page that fails to render is simply absent, and its neighbours keep their real numbers).
    const pages: RenderedPage[] = files.map((f) => {
      const m = f.match(/-(\d+)\.png$/);
      return { file: path.join(dir, f), page: m ? Number(m[1]) : 0 };
    });

    if (pages.length === 0) {
      // A zero-page render must never launder into a `status: done, text: ""` artifact that is never retried
      // — §2.3 makes empty a SUCCESS for a page that HAS no text, but "we rendered nothing" is a real fault.
      throw new Error(`pdftoppm rendered 0 pages from ${path.basename(abs)} — nothing to OCR.`);
    }

    const truncated = pageCount != null && pageCount > lastPage;
    if (truncated) {
      log.warn("ocr", `${abs}: hit max_pages (${opts.maxPages}) — read only the first ${lastPage} of ${pageCount} pages (ocr.mdx §15.2 rule 7).`);
    }
    return { pages, pageCount, truncated, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** Guard for a temp-dir leak in the degenerate case where a caller never reaches cleanup. */
export function pdfDirRoot(): string {
  return path.join(resolveStateDir(), "ocr-pdf");
}

/** Best-effort sweep of orphaned render dirs at boot (a crash mid-render leaves one behind). */
export function sweepOrphanPdfDirs(): void {
  try {
    const root = pdfDirRoot();
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
  } catch {
    /* a sweep that fails must never block boot */
  }
}

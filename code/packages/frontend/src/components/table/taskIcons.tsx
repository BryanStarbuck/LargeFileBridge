// The icon control-column kit (tables.mdx icon-columns). ONE place defines the five leading icon columns
// every file table shares — Pin, Ignore, Transcribe, AI description, OCR — so they look and explain the
// same on View-One-Repo, the Storage file table, and the IPFS pins table (the File System page is the one
// exclusion). Each kind owns a glyph, a UNIQUE "done" color, a readable label, and a plain-English
// explanation. People often don't know what these icons mean, so hovering the header OR any cell fills the
// left-bar hover-info panel (setHoverInfo, forwarded by HoverInfoBridge) with that explanation — in addition to the
// native title tooltip.
import type { ReactNode } from "react";
import { Pin, CircleSlash, Captions, ScanText, TextSelect } from "lucide-react";
import type { TaskStatus } from "@lfb/shared";
import { mediaKindForName, isPdfName } from "@lfb/shared";
import { StatusActionIcon } from "../StatusActionIcon.js";
import { setHoverInfo } from "../../pages/repos/HoverInfoRegion.js";

export type TaskIconKind = "pin" | "ignore" | "transcribe" | "describe" | "ocr";

interface TaskIconDef {
  /** Readable column name — used by the Sort/Filter/Columns dropdowns and as the icon's aria-label. */
  label: string;
  /** The unique color for the "done"/"on" state (colored glyph — NO box; product owner 2026-07-19). */
  doneColor: string;
  /** Pin only: draw the "done" glyph as a SOLID FILL (the dark-blue / red filled pin the owner described).
   *  The other kinds keep a colored stroke so their inner detail stays legible. */
  fillDone?: boolean;
  /** The glyph, drawn as a bare ~15px icon (no surrounding rounded rectangle). */
  glyph: ReactNode;
  /** The plain-English explanation shown in the hover-info region on hover (header or cell). */
  explain: string;
}

// Bare glyph size — larger than the old 10px because there is no longer a 16px box around it to fill.
const GLYPH = "h-[15px] w-[15px]";

export const TASK_ICON: Record<TaskIconKind, TaskIconDef> = {
  pin: {
    label: "Pin",
    doneColor: "var(--lfb-pin, #1e40af)",
    fillDone: true,
    glyph: <Pin className={GLYPH} strokeWidth={2.25} />,
    explain:
      "IPFS pin — sync this file across your own computers over IPFS. Blue filled = synced (pinned) on THIS computer; red filled = set to sync but this computer doesn't have it yet (it will pull it); green filled = pinned locally on this computer by other IPFS software (click to have Large File Bridge sync it too); grey outline = not set to sync (click to add).",
  },
  ignore: {
    label: "Ignore",
    doneColor: "var(--lfb-decision-on, #c2410c)",
    glyph: <CircleSlash className={GLYPH} strokeWidth={2.5} />,
    explain:
      "Git-ignore — keep this large file out of git and sync it over IPFS instead. Filled = git-ignored; outline = tracked by git (click to ignore).",
  },
  transcribe: {
    label: "Transcribe",
    doneColor: "var(--lfb-transcribe-done, #4338ca)",
    glyph: <Captions className={GLYPH} strokeWidth={2.5} />,
    explain:
      "Transcription — speech-to-text for audio and video. Filled = a transcript exists (click to view); outline = could be transcribed (click); grey = not audio/video.",
  },
  describe: {
    label: "AI description",
    doneColor: "var(--lfb-describe-done, #0d9488)",
    glyph: <ScanText className={GLYPH} strokeWidth={2.5} />,
    explain:
      "AI description — a written description of what's visible in an image or video. Filled = a description exists (click to view); outline = could be described (click); grey = not image/video.",
  },
  ocr: {
    label: "OCR",
    doneColor: "var(--lfb-ocr-done, #7c3aed)",
    glyph: <TextSelect className={GLYPH} strokeWidth={2.5} />,
    explain:
      "OCR — the on-screen text read out of an image, video, or PDF. Filled = the text has been read (click to view); outline = could be read (click); grey = nothing to read.",
  },
};

/** Derive the Transcribe / AI-description / OCR status for a file that carries only a list of which analysis
 *  artifacts already exist (the Storage file index's `analysis[]`, and the IPFS pin row's). "done" when the
 *  artifact exists; "could" when the file's KIND could have it but doesn't yet; "na" otherwise. This is the
 *  shared derivation used by the Storage detail table and the IPFS pins table, which don't carry the repo's
 *  precomputed TaskStatus fields (tables.mdx icon-columns). */
export function analysisTaskStatuses(
  name: string,
  analysis: string[],
): { transcribe: TaskStatus; describe: TaskStatus; ocr: TaskStatus } {
  const kind = mediaKindForName(name); // "video" | "image" | "audio" | null
  const pdf = isPdfName(name);
  const has = (k: string) => analysis.includes(k);
  return {
    transcribe: has("transcript") ? "done" : kind === "audio" || kind === "video" ? "could" : "na",
    describe: has("description") ? "done" : kind === "image" || kind === "video" ? "could" : "na",
    ocr: has("ocr") ? "done" : kind === "image" || kind === "video" || pdf ? "could" : "na",
  };
}

/** Map a boolean toggle (Pin/Ignore) onto the shared three-state grammar: on → done, off → the settable
 *  "could" (a light-grey outline that invites the click). "na" is for a kind the file can't have. */
export function boolStatus(on: boolean): TaskStatus {
  return on ? "done" : "could";
}

/** The icon-only column header (tables.mdx icon-columns). Shows the same glyph as the cells, carries the
 *  native title tooltip, and — like the cells — publishes the kind's explanation to the hover-info region
 *  on hover so the docked text explains what the column is. */
export function TaskIconHeader({ kind }: { kind: TaskIconKind }) {
  const def = TASK_ICON[kind];
  return (
    <span
      title={def.explain}
      aria-label={def.label}
      className="inline-flex text-black/55"
      onMouseEnter={() => setHoverInfo(def.explain)}
      onMouseLeave={() => setHoverInfo(null)}
    >
      {def.glyph}
    </span>
  );
}

/** One icon control cell. Wraps the shared StatusActionIcon in the kind's color + glyph, and wires the
 *  hover-info region to the kind's explanation (a caller can pass extraHover to append a per-row summary). */
export function TaskIconCell({
  kind,
  state,
  onActivate,
  disabled,
  title,
  extraHover,
  doneColor,
}: {
  kind: TaskIconKind;
  state: TaskStatus;
  onActivate?: () => void;
  disabled?: boolean;
  /** Override the native tooltip (defaults to the kind's explanation). */
  title?: string;
  /** Extra per-row line appended under the explanation in the hover-info region. */
  extraHover?: string;
  /** Override the "done" color for this one cell — the three-state Pin passes red when a file is set to
   *  sync but not yet on this computer (one_repo.mdx §4.9). Defaults to the kind's own unique color. */
  doneColor?: string;
}) {
  const def = TASK_ICON[kind];
  const hover = extraHover ? `${def.explain}\n${extraHover}` : def.explain;
  return (
    <StatusActionIcon
      state={state}
      doneColor={doneColor ?? def.doneColor}
      fillWhenDone={def.fillDone}
      title={title ?? def.explain}
      glyph={def.glyph}
      onActivate={onActivate}
      disabled={disabled}
      onMouseEnter={() => setHoverInfo(hover)}
      onMouseLeave={() => setHoverInfo(null)}
    />
  );
}

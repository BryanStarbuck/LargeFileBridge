// The metric catalog for the task-tab MetricsStrip (task_tabs.mdx §2). One entry per "what could be done"
// metric: its terse panel label, the hover-region hint (the prose that stays OUT of the panel), and the
// health tint it takes when its count is > 0. Counts are resolved from the RepoDetail the screen already
// loads (taskMetrics + missingPinned) — no extra fetch.
import type { RepoDetail } from "@lfb/shared";
import type { Health } from "../../components/ui/health.js";

export type MetricId =
  // The two DECISION metrics (one_repo.mdx §1). These replace the single "Undecided" tile: a decision has
  // always been TWO independent axes (add to IPFS · git-ignore) and the triage popup always set both, so
  // one number could never say which axis was outstanding. Now each axis has its own tile and its own
  // scoped popup. There is no "Undecided" metric any more.
  | "addToIpfs"
  | "gitIgnore"
  | "pullDown"
  | "notBackedUp"
  | "pending"
  | "compressibleVideos"
  | "compressibleImages"
  | "alreadyCompressed"
  | "transcribable"
  | "transcribed"
  | "describable"
  | "described"
  | "ocrable"
  | "ocred";

export interface MetricDef {
  label: string;
  hint: string;
  /** Tint when the count is > 0. At 0 the panel is always the light-green "all clear" state. */
  positive: Health;
}

export const METRIC_CATALOG: Record<MetricId, MetricDef> = {
  addToIpfs: {
    label: "Add to IPFS",
    hint: "Large files that aren't set to sync over IPFS yet. Add them so every one of your computers keeps a copy — if this machine dies, they're still safe.",
    positive: "warn",
  },
  gitIgnore: {
    label: "Git Ignore",
    hint: "Large files that Git is still allowed to commit. Git-ignore them so the repo never swallows big binaries — they sync over IPFS instead.",
    positive: "warn",
  },
  pullDown: {
    label: "Pull down",
    hint: "Files another of your computers pinned that aren't on this computer yet. Pull them down so this machine is a real second copy.",
    positive: "bad",
  },
  notBackedUp: {
    label: "Not backed up",
    hint: "Pinned files that live only on this computer — no other machine has a copy yet. Open Large File Bridge on another computer so it can pull them.",
    positive: "bad",
  },
  pending: {
    label: "Pending",
    hint: "Files marked Add to IPFS (pin) that are queued to transfer. They move on the next pin pass, or Pin now.",
    positive: "warn",
  },
  compressibleVideos: {
    label: "Compressible videos",
    hint: "Videos that look uncompressed. Large File Bridge can compress them to reclaim space — nothing is changed until you ask.",
    positive: "warn",
  },
  compressibleImages: {
    label: "Compressible images",
    hint: "Images that look uncompressed or convertible (e.g. PNG, HEIC). Compress or convert them to reclaim space — only when you ask.",
    positive: "warn",
  },
  alreadyCompressed: {
    label: "Compressed",
    hint: "Media that already looks compressed. Nothing to do — shown so you can see the whole picture.",
    positive: "ok",
  },
  transcribable: {
    label: "Transcribable",
    hint: "Audio and video files with no transcript yet. Large File Bridge can transcribe them locally — nothing runs until you ask.",
    positive: "warn",
  },
  transcribed: {
    label: "Transcribed",
    hint: "Audio and video files that already have a transcript. Nothing to do.",
    positive: "ok",
  },
  describable: {
    // "AI Describable" spelled out — the label must say WHO does the describing, so it is never read as
    // "files that have a description" (one_repo.mdx §3.2.1). Both letters of AI upper-case.
    label: "AI Describable",
    hint: "Images and videos with no AI description yet. Large File Bridge can describe them with your AI provider — nothing runs until you ask.",
    positive: "warn",
  },
  described: {
    label: "Described",
    hint: "Images and videos that already have an AI description. Nothing to do.",
    positive: "ok",
  },
  ocrable: {
    label: "OCRable",
    hint: "Images and videos whose on-screen text hasn't been read yet. Large File Bridge can read it on this computer — nothing is uploaded, and nothing runs until you ask.",
    positive: "warn",
  },
  ocred: {
    label: "OCRed",
    hint: "Images and videos whose text has already been read. Files with no text on screen count here too — that is a finished answer, not a to-do.",
    positive: "ok",
  },
};

/**
 * The files the "Git Ignore" tile counts AND the files its popup offers to fix — ONE predicate, so the
 * number on the tile and the length of the list in the popup can never disagree (one_repo.mdx §3.2.2).
 *
 * A row qualifies when Git is still allowed to commit it: not already git-ignored, not owned by a rule we
 * refuse to rewrite (a pattern / a non-root .gitignore — git_ignore.mdx §5.5), not one of the small
 * analysis-only media admitted by scan rule 5 (those are never a checked-in-size problem), and NOT a
 * remote-only row (storage_company.mdx §8.5) — there are no bytes on this computer for git to ignore, so
 * offering to write a .gitignore line for a path this working tree does not contain is a no-op the user
 * would have to understand to dismiss. The backend metric already excludes them; without this the tile and
 * the table's own disabled toggle contradicted each other.
 */
export function gitIgnoreCandidates(detail: RepoDetail) {
  return detail.files.filter(
    (f) => !f.gitignore && !f.gitignoreLocked && !f.analysisOnly && f.presence !== "remote-only",
  );
}

/** Resolve a metric's count from the RepoDetail the screen already holds. */
export function metricCount(id: MetricId, detail: RepoDetail): number {
  if (id === "pullDown") return detail.missingPinned?.length ?? 0;
  if (id === "gitIgnore") return gitIgnoreCandidates(detail).length;
  const m = detail.taskMetrics;
  if (!m) return 0;
  switch (id) {
    case "addToIpfs":
      // The same number the old "Undecided" tile showed: files with no pin decision, excluding rows whose
      // bytes another IPFS tool already pinned on this node (foreign_pin_discovery.mdx §6).
      return m.undecided;
    case "notBackedUp":
      return m.notBackedUp;
    case "pending":
      return m.pending;
    case "compressibleVideos":
      return m.compressibleVideos;
    case "compressibleImages":
      return m.compressibleImages;
    case "alreadyCompressed":
      return m.alreadyCompressed;
    case "transcribable":
      return m.transcribable;
    case "transcribed":
      return m.transcribed;
    case "describable":
      return m.describable;
    case "described":
      return m.described;
    case "ocrable":
      return m.ocrable;
    case "ocred":
      return m.ocred;
    default:
      return 0;
  }
}

// The metric catalog for the task-tab MetricsStrip (task_tabs.mdx §2). One entry per "what could be done"
// metric: its terse panel label, the hover-region hint (the prose that stays OUT of the panel), and the
// health tint it takes when its count is > 0. Counts are resolved from the RepoDetail the screen already
// loads (taskMetrics + missingPinned) — no extra fetch.
import type { RepoDetail } from "@lfb/shared";
import type { Health } from "../../components/ui/health.js";

export type MetricId =
  | "undecided"
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
  | "bigNotIgnored";

export interface MetricDef {
  label: string;
  hint: string;
  /** Tint when the count is > 0. At 0 the panel is always the light-green "all clear" state. */
  positive: Health;
}

export const METRIC_CATALOG: Record<MetricId, MetricDef> = {
  undecided: {
    label: "Undecided",
    hint: "Files Large File Bridge found that you haven't decided on yet. Open to Add to IPFS (pin), git-ignore, or leave as-is.",
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
    label: "Describable",
    hint: "Images and videos with no AI description yet. Large File Bridge can describe them with your AI provider — nothing runs until you ask.",
    positive: "warn",
  },
  described: {
    label: "Described",
    hint: "Images and videos that already have an AI description. Nothing to do.",
    positive: "ok",
  },
  bigNotIgnored: {
    label: "Big, not git-ignored",
    hint: "Large files that aren't git-ignored yet. Git-ignore them so Git never commits the big binaries (they sync over IPFS instead).",
    positive: "warn",
  },
};

/** Resolve a metric's count from the RepoDetail the screen already holds. */
export function metricCount(id: MetricId, detail: RepoDetail): number {
  if (id === "pullDown") return detail.missingPinned?.length ?? 0;
  const m = detail.taskMetrics;
  if (!m) return 0;
  switch (id) {
    case "undecided":
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
    case "bigNotIgnored":
      return m.bigNotIgnored;
    default:
      return 0;
  }
}

// The task-tab definitions (task_tabs.mdx §7). One entry per tab drives, in ONE place, what selecting a
// tab re-tunes: which columns show (by id, in order), the default sort ("most interesting for this task,
// first"), which files the table shows (rowFilter), which metric panels the strip shows, and the
// hover-region default hint. OneRepoPage reads TASK_TABS[activeTab] and projects its table + strip.
import type { SortingState } from "@tanstack/react-table";
import { LayoutGrid, Pin, Archive, Captions, ScanText, type LucideIcon } from "lucide-react";
import { mediaKindForName, type FileRow } from "@lfb/shared";
import type { MetricId } from "./metricWarnings.js";

export type TaskTabId = "all" | "ipfs" | "compress" | "transcribe" | "ai-descriptions";

export interface TaskTabDef {
  id: TaskTabId;
  label: string;
  icon: LucideIcon;
  /** Column ids (from OneRepoPage's full column union) to show, in this order. */
  columnIds: string[];
  /** The tab's "most interesting first" default sort. */
  defaultSort: SortingState;
  /** Which files belong to this task (applied before the table's own search/filter). */
  rowFilter: (f: FileRow) => boolean;
  /** Which metric panels the strip renders for this tab. */
  metrics: MetricId[];
  /** The hover-region text when nothing is hovered. */
  defaultHint: string;
}

const BIG = 100 * 1024 * 1024; // 100 MB — the "large file" cut for the IPFS tab's large-or-media filter.
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export const TASK_TABS: Record<TaskTabId, TaskTabDef> = {
  // All — the overview. Every file, the full column set, most-recently-changed first. The metrics strip
  // shows everything actionable (mostly green zeros on a healthy repo).
  all: {
    id: "all",
    label: "All",
    icon: LayoutGrid,
    columnIds: ["pinned", "gitignore", "path", "size", "decision", "decidedBy", "decidedAt", "status", "peers", "cid", "changed"],
    defaultSort: [{ id: "changed", desc: true }],
    rowFilter: () => true,
    metrics: ["undecided", "pullDown", "notBackedUp", "compressibleVideos", "compressibleImages", "transcribable", "describable", "bigNotIgnored"],
    defaultHint: "All large files in this repo. Hover a file for details, or pick a task tab to focus.",
  },
  // IPFS — pinning across your computers. Large or media files; sort by fewest peers (not-backed-up on
  // top), then biggest first.
  ipfs: {
    id: "ipfs",
    label: "IPFS",
    icon: Pin,
    columnIds: ["pinned", "gitignore", "path", "size", "status", "peers", "cid", "changed"],
    defaultSort: [
      { id: "peers", desc: false },
      { id: "size", desc: true },
    ],
    rowFilter: (f) => mediaKindForName(basename(f.path)) !== null || f.sizeBytes >= BIG,
    metrics: ["undecided", "pullDown", "notBackedUp", "pending"],
    defaultHint: "IPFS: which large files are pinned across your computers. Fewest-peers files are on top.",
  },
  // Compress — reclaim space. Compressible videos/images (na files hidden). "could" sorts before "done"
  // (alphabetical could/done/na), then biggest first — the biggest reclaimable file leads.
  compress: {
    id: "compress",
    label: "Compress",
    // The Compress status icon is the LEADING, header-less control column — to the LEFT of File, the same
    // slot Pin/IPFS occupy (task_tabs.mdx §4.3/§6). A compact Pin is kept after it so the user can still pin.
    icon: Archive,
    columnIds: ["compress", "pinned", "path", "size", "kind", "changed"],
    defaultSort: [
      { id: "compress", desc: false },
      { id: "size", desc: true },
    ],
    rowFilter: (f) => f.compress === "could" || f.compress === "done",
    metrics: ["compressibleVideos", "compressibleImages", "alreadyCompressed"],
    defaultHint: "Compress: videos and images that could be compressed. Biggest could-compress file is on top.",
  },
  // Transcribe — get transcripts. Audio/video only; "could" (no transcript) sorts first, then biggest.
  transcribe: {
    id: "transcribe",
    label: "Transcribe",
    // The Transcribe status icon is the LEADING, header-less control column — to the LEFT of File, like the
    // Pin/IPFS icons (task_tabs.mdx §4.4/§5; the product owner: "move it left of the file icon, drop the title").
    icon: Captions,
    columnIds: ["transcribe", "path", "size", "kind", "changed"],
    defaultSort: [
      { id: "transcribe", desc: false },
      { id: "size", desc: true },
    ],
    rowFilter: (f) => f.transcribe === "could" || f.transcribe === "done",
    metrics: ["transcribable", "transcribed"],
    defaultHint: "Transcribe: audio and video files. Files with no transcript yet are on top.",
  },
  // AI descriptions — the mirror of Transcribe for the OTHER media axis (images + video). Its status icon is
  // the LEADING, header-less control column (like Transcribe/Compress). "could" (no description) sorts first,
  // then biggest. Audio never appears here (transcription covers it).
  "ai-descriptions": {
    id: "ai-descriptions",
    label: "AI descriptions",
    icon: ScanText,
    columnIds: ["describe", "path", "size", "kind", "changed"],
    defaultSort: [
      { id: "describe", desc: false },
      { id: "size", desc: true },
    ],
    rowFilter: (f) => f.describe === "could" || f.describe === "done",
    metrics: ["describable", "described"],
    defaultHint: "AI descriptions: images and videos. Files with no AI description yet are on top.",
  },
};

export const TASK_TAB_ORDER: TaskTabId[] = ["all", "ipfs", "compress", "transcribe", "ai-descriptions"];

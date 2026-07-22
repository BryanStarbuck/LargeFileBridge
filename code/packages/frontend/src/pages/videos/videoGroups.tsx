// Shared row/group model for the two Videos review tables (duplicates.mdx §3, subsets.mdx §3).
//
// ONE ROW PER GROUP (revised 2026-07-22). The table used to interleave a slim group-header row with one
// row per member, so a 9-file group ate 10 rows and a screen of results showed three groups. A group is
// the unit the user actually reviews — they pick a GROUP and then compare its files in the right column —
// so the table lists groups, one line each, labelled with a REPRESENTATIVE member's file name. The
// per-file detail (and the per-file icon control columns) moved to the right review column, where the
// files themselves are.
import type { DuplicateMemberRow, SubsetMemberRow, TaskStatus } from "@lfb/shared";
import { fileTypeForName, formatBytes } from "@lfb/shared";
import type { LfbColumn } from "../../components/table/types.js";
import { analysisTaskStatuses, boolStatus, type TaskIconKind } from "../../components/table/taskIcons.js";
import { setHoverInfo } from "../repos/HoverInfoRegion.js";

/** The member fields both review screens share — DuplicateMemberRow and SubsetMemberRow satisfy it. */
export interface VideoMember {
  group: string;
  fullPath: string;
  name: string;
  sizeBytes: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  sha256: string;
  fingerprint: string;
  matchBasis: string;
  decision: string | null;
  gitIgnored: boolean;
  hasTranscription: boolean;
  hasDescription: boolean;
  hasOcr: boolean;
  /** Subsets only. */
  role?: "superset" | "subset";
  startOffsetS?: number | null;
  endOffsetS?: number | null;
}

export interface VideoGroup<M extends VideoMember> {
  id: string;
  /** Display order: duplicates keep CSV order; subsets put the superset first, then by containment start. */
  members: M[];
  /** Drives the default sort — duplicates: sum − largest member; subsets: sum of subset sizes. */
  reclaimableBytes: number;
  /**
   * The ONE file name the group's single table row shows (§3.1). Any member's name is a truthful label —
   * every member is the same content — so this is simply the first member in display order (for subsets
   * that is deliberately the SUPERSET, the file the group is named after).
   */
  representativeName: string;
  /** Group-level File-sort key so sorting by File orders groups by that same shown name. */
  sortName: string;
  /** Group-level search text: any member's name/path keeps the group's row visible. */
  searchText: string;
  /** File-type facet value (first member's class — a group is homogeneous). */
  fileType: string;
  /** Match-basis facet value (duplicates.mdx §3.2 / subsets.mdx §3). */
  matchBasis: string;
}

export function buildDuplicateGroups(rows: DuplicateMemberRow[]): VideoGroup<DuplicateMemberRow>[] {
  const byId = new Map<string, DuplicateMemberRow[]>();
  for (const r of rows) {
    const list = byId.get(r.group);
    if (list) list.push(r);
    else byId.set(r.group, [r]);
  }
  const groups: VideoGroup<DuplicateMemberRow>[] = [];
  for (const [id, members] of byId) {
    const total = members.reduce((s, m) => s + m.sizeBytes, 0);
    const largest = members.reduce((s, m) => Math.max(s, m.sizeBytes), 0);
    const rep = members[0]?.name ?? "";
    groups.push({
      id,
      members,
      reclaimableBytes: total - largest,
      representativeName: rep,
      sortName: rep.toLowerCase(),
      searchText: members.map((m) => `${m.name} ${m.fullPath}`).join(" "),
      fileType: fileTypeForName(members[0]?.name ?? ""),
      matchBasis: members[0]?.matchBasis ?? "",
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  return groups;
}

export function buildSubsetGroups(rows: SubsetMemberRow[]): VideoGroup<SubsetMemberRow>[] {
  const byId = new Map<string, SubsetMemberRow[]>();
  for (const r of rows) {
    const list = byId.get(r.group);
    if (list) list.push(r);
    else byId.set(r.group, [r]);
  }
  const groups: VideoGroup<SubsetMemberRow>[] = [];
  for (const [id, unordered] of byId) {
    // Superset row first, then subsets by containment start time (subsets.mdx §3).
    const members = [...unordered].sort((a, b) => {
      if (a.role !== b.role) return a.role === "superset" ? -1 : 1;
      return (a.startOffsetS ?? 0) - (b.startOffsetS ?? 0);
    });
    const superset = members.find((m) => m.role === "superset");
    const subsets = members.filter((m) => m.role === "subset");
    // A subset group is NAMED for its superset — that is the file the whole group hangs off.
    const rep = superset?.name ?? members[0]?.name ?? "";
    groups.push({
      id,
      members,
      // What deleting the clips would free (subsets.mdx §3).
      reclaimableBytes: subsets.reduce((s, m) => s + m.sizeBytes, 0),
      representativeName: rep,
      sortName: rep.toLowerCase(),
      searchText: members.map((m) => `${m.name} ${m.fullPath}`).join(" "),
      fileType: fileTypeForName(members[0]?.name ?? ""),
      // The superset row leads after the sort above, and its basis is the group-level basis.
      matchBasis: members[0]?.matchBasis ?? "",
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  return groups;
}

// ── Per-file icon state, best-effort from the row's tracking fields (tables.mdx §4c) ───────────────
// These render in the RIGHT REVIEW COLUMN now (duplicates.mdx §4.3), left of each file's name — the table
// has no per-file rows to hang them on any more.
export function memberTaskState(m: VideoMember, kind: TaskIconKind): TaskStatus {
  if (kind === "pin") return boolStatus(m.decision === "sync"); // intent, not reality (decisions.mdx)
  if (kind === "ignore") return boolStatus(m.gitIgnored);
  const analysis = [
    ...(m.hasTranscription ? ["transcript"] : []),
    ...(m.hasDescription ? ["description"] : []),
    ...(m.hasOcr ? ["ocr"] : []),
  ];
  return analysisTaskStatuses(m.name, analysis)[kind];
}

/** The locked icon order, shared by every surface that shows the five (tables.mdx §4c / ocr.mdx §8.2). */
export const ICON_KINDS: TaskIconKind[] = ["pin", "ignore", "transcribe", "describe", "ocr"];

/**
 * The group table's deliberately small column set (duplicates.mdx §3.1, LOCKED): **File** (the
 * representative member's basename — no path), **Files** (how many are in the group), **Size** (the
 * reclaimable bytes). No icon columns (they moved to the right column with the files), no leading
 * checkbox, no bookmark, no path column.
 */
export function buildVideoColumns<M extends VideoMember>(): LfbColumn<VideoGroup<M>>[] {
  return [
    {
      id: "file",
      header: "File",
      kind: "text",
      accessor: (g) => g.sortName,
      cell: (g) => (
        <span
          className="block max-w-full truncate"
          title={g.members[0]?.fullPath}
          // The full path is NOT a column — it publishes to the left-bar hover-info panel
          // (duplicates.mdx §3.1 / non_intrusive_tooltip.mdx).
          onMouseEnter={() => setHoverInfo(g.members[0]?.fullPath ?? null)}
          onMouseLeave={() => setHoverInfo(null)}
        >
          {g.representativeName}
        </span>
      ),
    },
    {
      id: "count",
      header: "Files",
      kind: "int",
      align: "right",
      minWidth: 64,
      priority: 20, // the first column to drop on a narrow split (tables.mdx §4a)
      accessor: (g) => g.members.length,
    },
    {
      id: "size",
      header: "Size",
      kind: "bytes",
      align: "right",
      // Reclaimable bytes, so the default sort (and any Size sort) ranks the most disk-winning groups
      // first (duplicates.mdx §3.2).
      accessor: (g) => g.reclaimableBytes,
      cell: (g) => formatBytes(g.reclaimableBytes),
    },
  ];
}

// ── Time formatting (subsets.mdx §4): mm:ss, or h:mm:ss past an hour ───────────────────────────────
/** Duration print — "3:02", "10:04", "1:02:33" (minutes unpadded below an hour). */
export function formatClock(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Containment-offset print — zero-padded minutes below an hour: "03:10", "06:12", "1:02:33". */
export function formatOffset(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

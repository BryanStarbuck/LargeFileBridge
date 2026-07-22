// Shared row/group model for the two Videos review tables (duplicates.mdx §3, subsets.mdx §3).
//
// Both pages show a house DataTable whose rows are GROUPED under slim group-header rows. DataTable is
// flat, so the grouping is modeled here: each table row is either a group HEADER or a MEMBER, and every
// sortable column's accessor returns a GROUP-LEVEL value — so any sort the user applies reorders whole
// groups while the members (and the header, inserted first) keep their in-group order via the stable
// sort. Default order: groups by reclaimable bytes descending (duplicates.mdx §3.2).
import type { ReactNode } from "react";
import type { DuplicateMemberRow, SubsetMemberRow, TaskStatus } from "@lfb/shared";
import { fileTypeForName, formatBytes } from "@lfb/shared";
import type { LfbColumn } from "../../components/table/types.js";
import {
  TASK_ICON,
  TaskIconCell,
  TaskIconHeader,
  analysisTaskStatuses,
  boolStatus,
  type TaskIconKind,
} from "../../components/table/taskIcons.js";
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
  headerText: string;
  /** Group-level File-sort key so sorting by File keeps groups contiguous. */
  sortName: string;
  /** Group-level search text: any member's name/path keeps the header row visible. */
  searchText: string;
  /** File-type facet value (first member's class — a group is homogeneous). */
  fileType: string;
  /** Match-basis facet value (duplicates.mdx §3.2 / subsets.mdx §3) — the group-level basis, so
   *  filtering keeps whole groups (header + members) together. */
  matchBasis: string;
}

export type VideoTableRow<M extends VideoMember> =
  | { kind: "header"; group: VideoGroup<M> }
  | { kind: "member"; member: M; group: VideoGroup<M> };

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
    groups.push({
      id,
      members,
      reclaimableBytes: total - largest,
      headerText: `Group ${id} · ${members.length} files · same content (${members[0]?.matchBasis ?? ""})`,
      sortName: (members[0]?.name ?? "").toLowerCase(),
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
    groups.push({
      id,
      members,
      // What deleting the clips would free (subsets.mdx §3).
      reclaimableBytes: subsets.reduce((s, m) => s + m.sizeBytes, 0),
      headerText: `Group ${id} · ${superset?.name ?? "?"} · ${subsets.length} subset${subsets.length === 1 ? "" : "s"} · ${members[0]?.matchBasis ?? ""}`,
      sortName: (superset?.name ?? members[0]?.name ?? "").toLowerCase(),
      searchText: members.map((m) => `${m.name} ${m.fullPath}`).join(" "),
      fileType: fileTypeForName(members[0]?.name ?? ""),
      // The superset row leads after the sort above, and its basis is the group-level basis.
      matchBasis: members[0]?.matchBasis ?? "",
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  return groups;
}

/** Interleave the slim group-header rows with their member rows, in group order. */
export function interleaveRows<M extends VideoMember>(groups: VideoGroup<M>[]): VideoTableRow<M>[] {
  const out: VideoTableRow<M>[] = [];
  for (const group of groups) {
    out.push({ kind: "header", group });
    for (const member of group.members) out.push({ kind: "member", member, group });
  }
  return out;
}

// ── Icon control-column state, best-effort from the row's tracking fields (tables.mdx §4c) ─────────
function memberTaskState(m: VideoMember, kind: TaskIconKind): TaskStatus {
  if (kind === "pin") return boolStatus(m.decision === "sync"); // intent, not reality (decisions.mdx)
  if (kind === "ignore") return boolStatus(m.gitIgnored);
  const analysis = [
    ...(m.hasTranscription ? ["transcript"] : []),
    ...(m.hasDescription ? ["description"] : []),
    ...(m.hasOcr ? ["ocr"] : []),
  ];
  return analysisTaskStatuses(m.name, analysis)[kind];
}

const ICON_KINDS: TaskIconKind[] = ["pin", "ignore", "transcribe", "describe", "ocr"];

/**
 * The deliberately small column set (duplicates.mdx §3.1, LOCKED): the five icon control columns +
 * File (basename only) + Size. No leading checkbox, no bookmark, no path column. Icon columns NEVER
 * set `width` and their `header` stays a readable string (tables.mdx §4c).
 */
export function buildVideoColumns<M extends VideoMember>(): LfbColumn<VideoTableRow<M>>[] {
  const iconCols: LfbColumn<VideoTableRow<M>>[] = ICON_KINDS.map((kind) => ({
    id: kind,
    header: TASK_ICON[kind].label,
    headerCell: <TaskIconHeader kind={kind} />,
    tight: true,
    kind: "enum",
    sortable: false,
    filterable: false,
    accessor: (r) => (r.kind === "member" ? memberTaskState(r.member, kind) : ""),
    cell: (r) =>
      r.kind === "member" ? <TaskIconCell kind={kind} state={memberTaskState(r.member, kind)} /> : null,
  }));
  return [
    ...iconCols,
    {
      id: "file",
      header: "File",
      kind: "text",
      // Group-level sort key: sorting by File reorders GROUPS (stable sort keeps each group's
      // header-then-members order intact).
      accessor: (r) => r.group.sortName,
      cell: (r) =>
        r.kind === "header" ? (
          <span className="block truncate text-xs font-medium text-black/50">{r.group.headerText}</span>
        ) : (
          <span
            className="block max-w-full truncate"
            title={r.member.fullPath}
            // The full path is NOT a column — it publishes to the left-bar hover-info panel
            // (duplicates.mdx §3.1 / non_intrusive_tooltip.mdx).
            onMouseEnter={() => setHoverInfo(r.member.fullPath)}
            onMouseLeave={() => setHoverInfo(null)}
          >
            {r.member.name}
          </span>
        ),
    },
    {
      id: "size",
      header: "Size",
      kind: "bytes",
      align: "right",
      // Group-level value = reclaimable bytes, so the default sort (and any Size sort) ranks the most
      // disk-winning groups first while keeping groups contiguous (duplicates.mdx §3.2).
      accessor: (r) => r.group.reclaimableBytes,
      cell: (r): ReactNode => (r.kind === "member" ? formatBytes(r.member.sizeBytes) : null),
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

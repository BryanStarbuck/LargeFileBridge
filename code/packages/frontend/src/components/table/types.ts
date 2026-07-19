import type { ReactNode } from "react";

export type ColumnKind = "text" | "int" | "bytes" | "timestamp" | "enum";

export interface LfbColumn<T> {
  id: string;
  // The plain-text column name. ALWAYS a string — it is what the Sort / Filter / Columns dropdowns show
  // and what screen-reader users hear. For an icon-only column (Pin/Ignore/Transcribe/AI description/OCR)
  // the VISIBLE table header is `headerCell` (an icon), while `header` stays the readable label the
  // dropdowns use (tables.mdx icon-columns).
  header: string;
  // Optional custom header rendered in the table's <thead> INSTEAD of the text `header` — used by the icon
  // control columns to show the same glyph as their cells (with a hover tooltip + hover-region wiring). The
  // dropdowns keep using the text `header`, so nothing icon-only ever loses its readable name.
  headerCell?: ReactNode;
  // Tight control column (tables.mdx icon-columns): halve the horizontal cell padding (px-1 not px-2) so a
  // narrow icon column takes as little width as possible. Pair with a small `width` / `minWidth`.
  tight?: boolean;
  kind: ColumnKind;
  accessor: (row: T) => string | number | null;
  cell?: (row: T) => ReactNode;
  align?: "left" | "right";
  sortable?: boolean;
  filterable?: boolean;
  filterOptions?: string[]; // for enum columns
  // Optional fixed column width (any CSS length, e.g. "12rem" / "160px"). When ANY column sets one the
  // table switches to a fixed layout and emits a <colgroup> so columns don't get squeezed (tables.mdx).
  // Columns without a width share the remaining space.
  width?: string;
  // Responsive column priority (repos.mdx §3.2.1 / tables.mdx §4a). LOWER number = MORE important
  // (kept longest); HIGHER = hidden first as the table narrows. UNDEFINED = pinned (never auto-hidden —
  // the identity/verdict columns). Hiding is presentation-only: a hidden column still appears in the
  // Sort/Filter dropdowns.
  priority?: number;
  // Minimum on-screen width (px) this column needs to render on one line. Drives the responsive budget:
  // while the sum of visible columns' minWidths (+ leading select + trailing kebab) exceeds the
  // container, the lowest-priority column is dropped. Sensible defaults by kind when omitted.
  minWidth?: number;
}

import type { ReactNode } from "react";

export type ColumnKind = "text" | "int" | "bytes" | "timestamp" | "enum";

export interface LfbColumn<T> {
  id: string;
  header: string;
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

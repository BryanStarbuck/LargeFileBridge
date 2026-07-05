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
}

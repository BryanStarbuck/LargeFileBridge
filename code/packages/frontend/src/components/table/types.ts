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
}

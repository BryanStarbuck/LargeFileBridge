// The §2.11 file-filter panel (tables.mdx §2.11 — product-owner revision 2026-07-21): a TWO-COLUMN
// grid of labelled segmented controls (All · Not yet · Done — one segment highlighted, click another
// to move it; no dropdown-in-a-dropdown). The editable BOOLEAN CLAUSE BAR is a separate component
// (FileFilterClauseBar) so the popover can render it at the very BOTTOM of the whole dropdown, right
// above "Clear filters". Rendered inside the Filter ⛛ popover by DataTable, and by the Full-paths
// page's own popover — both drive the ONE expression string these components display.
import { ALL, FILE_FILTER_FIELDS, type FileFilterFieldId, type FileFilterSelections } from "./fileFilter.js";

export function FileFilterPanel({
  fields,
  selections,
  onSelect,
}: {
  /** The surface's field subset, in display order (tables.mdx §2.11.6). */
  fields: FileFilterFieldId[];
  /** field → selected option value ("all" when absent) — derived from the last PARSEABLE text. */
  selections: FileFilterSelections;
  /** A segmented click — rewrites only that field's clause (§2.11.4). */
  onSelect: (field: FileFilterFieldId, value: string) => void;
}) {
  return (
    <div className="px-3 py-1">
      {/* Two columns wide — "wider, not taller" (tables.mdx §2.11.3). */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {fields.map((id) => (
          <SegmentedField
            key={id}
            field={id}
            value={selections[id] ?? ALL}
            onSelect={(v) => onSelect(id, v)}
          />
        ))}
      </div>
    </div>
  );
}

// The boolean clause bar (tables.mdx §2.11.4): the whole filter as an editable expression. Default
// ORs between task clauses, AND for size, parentheses supported. Invalid text shows its reason; the
// table keeps filtering on the last valid expression. Sits at the very BOTTOM of the Filter dropdown,
// directly above "Clear filters" (§2.11.3).
export function FileFilterClauseBar({
  text,
  error,
  onText,
}: {
  /** The raw expression text, exactly as typed. */
  text: string;
  /** Parse error of the current text, or null. The last valid expression stays applied (§2.11.4). */
  error: string | null;
  /** The user typed in the clause bar. */
  onText: (text: string) => void;
}) {
  return (
    <div className="px-3 py-1">
      <input
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="e.g. (transcribe = not_yet OR ocr = not_yet) AND size = only_large"
        spellCheck={false}
        aria-label="Filter clause"
        aria-invalid={!!error}
        className={`w-full rounded border px-2 py-1 font-mono text-xs outline-none ${
          error
            ? "border-red-400 bg-red-50 text-red-800 focus:border-red-500"
            : "border-[var(--lfb-border)] focus:border-[var(--lfb-primary)]"
        }`}
      />
      {error && <div className="mt-0.5 text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

// One labelled row: the field name on the left, the left-to-right segmented run on the right with
// exactly ONE segment highlighted (tables.mdx §2.11.1).
function SegmentedField({
  field,
  value,
  onSelect,
}: {
  field: FileFilterFieldId;
  value: string;
  onSelect: (value: string) => void;
}) {
  const def = FILE_FILTER_FIELDS[field];
  const options = [{ value: ALL, label: "All" }, ...def.options];
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-sm">
      <span className="shrink-0 truncate text-black/70">{def.label}</span>
      <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--lfb-border)]" role="radiogroup" aria-label={def.label}>
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              role="radio"
              aria-checked={active}
              onClick={() => onSelect(o.value)}
              className={`px-2 py-0.5 text-xs whitespace-nowrap ${
                active ? "bg-[var(--lfb-primary)] text-white" : "bg-white text-black/60 hover:bg-slate-100"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

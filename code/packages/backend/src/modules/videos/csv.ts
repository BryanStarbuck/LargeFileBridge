// Minimal CSV encode/decode for the two Videos stores (duplicates.mdx §9, subsets.mdx §9). Zero
// dependencies on purpose — the column sets are LOCKED and tiny, and file paths are the only fields
// that can carry commas/quotes/newlines. RFC-4180 quoting: a field containing `,` `"` `\r` or `\n`
// is wrapped in double quotes with inner quotes doubled. The parser is tolerant (it never throws on a
// malformed line — it yields what it can), because a half-understood CSV must degrade to fewer rows,
// never to a crashed list endpoint.

/** Encode one field. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Encode one row (no trailing newline). */
export function csvLine(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvField).join(",");
}

/**
 * Parse a whole CSV document into rows of string fields. Handles quoted fields (embedded commas,
 * doubled quotes, embedded newlines) and both LF / CRLF line endings. Empty trailing line is dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue; // CRLF → the \n below ends the row
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Final field/row (no trailing newline). A completely empty tail is not a row.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** "" → null, else Number (NaN → null). For the numeric CSV columns whose empties mean "not applicable". */
export function numOrNull(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

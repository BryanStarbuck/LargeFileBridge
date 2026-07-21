// The §2.11 file filter (tables.mdx §2.11 — product-owner revision 2026-07-21): the segmented
// All/Not-yet/Done controls in the Filter ⛛ dropdown and the editable boolean clause bar are two views
// of ONE expression string. This module owns that expression: the field vocabulary, the tokenizer/
// parser, the row evaluator, the canonical builder (ORs between task clauses, AND for size), and the
// clause-level rewrite a segmented-control click performs. Pure TS — no React, unit-tested in
// fileFilter.spec.ts.

export type FileFilterFieldId =
  | "transcribe"
  | "ai_description"
  | "ocr"
  | "pull_down"
  | "add_to_ipfs"
  | "git_ignore"
  | "compressible_videos"
  | "compressible_images"
  | "compressible_audio"
  | "size";

// What a ROW answers for a field. Task fields answer the three-state task grammar; boolean fields
// answer yes/no; size answers large/small. "na" matches ONLY All (tables.mdx §2.11.1 — N/A is retired
// as an OPTION; a row where the axis doesn't apply is hidden by any non-All selection).
export type FileFilterRowValue = "not_yet" | "done" | "na" | "yes" | "no" | "large" | "small";

interface FieldOption {
  /** The canonical clause token (what the serializer writes). */
  value: string;
  /** The segment label. */
  label: string;
  /** The row value this option matches (defaults to `value`). */
  rowValue?: FileFilterRowValue;
}

export interface FileFilterFieldDef {
  id: FileFilterFieldId;
  /** The label on the segmented row (user-facing English — spell things out). */
  label: string;
  /** The non-All options, in segment order. "All" is implicit and always first. */
  options: FieldOption[];
  /** Size joins the expression with AND; every other field joins its OR group (tables.mdx §2.11.4). */
  joiner: "or" | "and";
}

const TASK_OPTIONS: FieldOption[] = [
  { value: "not_yet", label: "Not yet" },
  { value: "done", label: "Done" },
];
const BOOL_OPTIONS: FieldOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

export const FILE_FILTER_FIELDS: Record<FileFilterFieldId, FileFilterFieldDef> = {
  transcribe: { id: "transcribe", label: "Transcribe", options: TASK_OPTIONS, joiner: "or" },
  ai_description: { id: "ai_description", label: "AI description", options: TASK_OPTIONS, joiner: "or" },
  ocr: { id: "ocr", label: "OCR", options: TASK_OPTIONS, joiner: "or" },
  pull_down: { id: "pull_down", label: "Pull down", options: TASK_OPTIONS, joiner: "or" },
  add_to_ipfs: { id: "add_to_ipfs", label: "Add to IPFS", options: TASK_OPTIONS, joiner: "or" },
  git_ignore: { id: "git_ignore", label: "Git ignore", options: TASK_OPTIONS, joiner: "or" },
  // No bare "compressible" field — the per-kind trio below covers it (product owner, 2026-07-21).
  compressible_videos: { id: "compressible_videos", label: "Compressible videos", options: BOOL_OPTIONS, joiner: "or" },
  compressible_images: { id: "compressible_images", label: "Compressible images", options: BOOL_OPTIONS, joiner: "or" },
  compressible_audio: { id: "compressible_audio", label: "Compressible audio", options: BOOL_OPTIONS, joiner: "or" },
  size: {
    id: "size",
    label: "Size",
    options: [
      { value: "only_large", label: "Only large", rowValue: "large" },
      { value: "not_large", label: "Not large", rowValue: "small" },
    ],
    joiner: "and",
  },
};

export const ALL = "all"; // the resting segment — emits no clause (tables.mdx §2.11.1)

/** Map the three-state TaskStatus grammar ("could"/"done"/"na" — task_tabs.mdx) onto the filter's row
 *  values: could → not_yet, done → done, na/absent → na (matches only All — §2.11.1). */
export function taskRowValue(status: "could" | "done" | "na" | undefined): FileFilterRowValue {
  return status === "done" ? "done" : status === "could" ? "not_yet" : "na";
}

// ── AST ─────────────────────────────────────────────────────────────────────────
export type FilterNode =
  | { kind: "group"; op: "and" | "or"; kids: FilterNode[] }
  | { kind: "clause"; field: FileFilterFieldId; value: string };

export type ParseResult =
  | { ok: true; ast: FilterNode | null } // null = empty expression (no filter)
  | { ok: false; error: string };

// ── Tokenizer ───────────────────────────────────────────────────────────────────
type Token = { t: "word" | "eq" | "lparen" | "rparen"; v: string };

function tokenize(text: string): Token[] | string {
  const out: Token[] = [];
  const re = /\s*(=|==|\(|\)|[A-Za-z0-9_]+|\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1];
    if (v === "=" || v === "==") out.push({ t: "eq", v: "=" });
    else if (v === "(") out.push({ t: "lparen", v });
    else if (v === ")") out.push({ t: "rparen", v });
    else if (/^[A-Za-z0-9_]+$/.test(v)) out.push({ t: "word", v });
    else return `Unexpected character "${v}"`;
  }
  return out;
}

// ── Parser (recursive descent: OR lowest, then AND, then clause / parens) ───────
// Multi-word names are joined with "_" so "not yet" ⇔ "not_yet" and "ai description" ⇔
// "ai_description" (tables.mdx §2.11.4 — spaces are fine in tokens).
export function parseFileFilter(text: string, knownFields?: FileFilterFieldId[]): ParseResult {
  const toks = tokenize(text);
  if (typeof toks === "string") return { ok: false, error: toks };
  if (toks.length === 0) return { ok: true, ast: null };
  let i = 0;

  const peek = () => toks[i];
  const isKeyword = (w: string) => w === "and" || w === "or";

  // A run of words that stops before AND/OR/=/parens, joined with "_".
  const words = (): string | null => {
    const parts: string[] = [];
    while (i < toks.length && toks[i].t === "word" && !isKeyword(toks[i].v.toLowerCase())) {
      parts.push(toks[i].v.toLowerCase());
      i++;
    }
    return parts.length ? parts.join("_") : null;
  };

  const clause = (): FilterNode | string => {
    if (peek()?.t === "lparen") {
      i++;
      const inner = orExpr();
      if (typeof inner === "string") return inner;
      if (peek()?.t !== "rparen") return "Missing closing parenthesis";
      i++;
      return inner;
    }
    const field = words();
    if (!field) return `Expected a field name${peek() ? ` before "${peek().v}"` : ""}`;
    if (peek()?.t !== "eq") return `Expected "=" after "${field.replace(/_/g, " ")}"`;
    i++;
    const value = words();
    if (!value) return `Expected a value after "${field.replace(/_/g, " ")} ="`;
    const known = knownFields ?? (Object.keys(FILE_FILTER_FIELDS) as FileFilterFieldId[]);
    if (!known.includes(field as FileFilterFieldId))
      return `Unknown field "${field.replace(/_/g, " ")}"`;
    const def = FILE_FILTER_FIELDS[field as FileFilterFieldId];
    if (value !== ALL && !def.options.some((o) => o.value === value))
      return `"${value.replace(/_/g, " ")}" is not a value of ${def.label} (use ${[ALL, ...def.options.map((o) => o.value)].join(" / ")})`;
    return { kind: "clause", field: field as FileFilterFieldId, value };
  };

  const andExpr = (): FilterNode | string => {
    const first = clause();
    if (typeof first === "string") return first;
    const kids = [first];
    while (peek()?.t === "word" && peek().v.toLowerCase() === "and") {
      i++;
      const next = clause();
      if (typeof next === "string") return next;
      kids.push(next);
    }
    return kids.length === 1 ? kids[0] : { kind: "group", op: "and", kids };
  };

  const orExpr = (): FilterNode | string => {
    const first = andExpr();
    if (typeof first === "string") return first;
    const kids = [first];
    while (peek()?.t === "word" && peek().v.toLowerCase() === "or") {
      i++;
      const next = andExpr();
      if (typeof next === "string") return next;
      kids.push(next);
    }
    return kids.length === 1 ? kids[0] : { kind: "group", op: "or", kids };
  };

  const ast = orExpr();
  if (typeof ast === "string") return { ok: false, error: ast };
  if (i < toks.length) return { ok: false, error: `Unexpected "${toks[i].v}"` };
  return { ok: true, ast };
}

// ── Evaluator ───────────────────────────────────────────────────────────────────
// A clause matches when the row's value for the field equals the option's row value; "field = all" is
// always true. An "na" row value matches nothing but All (tables.mdx §2.11.1).
export function evalFileFilter(
  ast: FilterNode | null,
  rowValue: (field: FileFilterFieldId) => FileFilterRowValue,
): boolean {
  if (!ast) return true;
  if (ast.kind === "clause") {
    if (ast.value === ALL) return true;
    const opt = FILE_FILTER_FIELDS[ast.field].options.find((o) => o.value === ast.value);
    if (!opt) return true; // unknown value survived validation — never hide rows on it
    return rowValue(ast.field) === (opt.rowValue ?? (opt.value as FileFilterRowValue));
  }
  return ast.op === "and"
    ? ast.kids.every((k) => evalFileFilter(k, rowValue))
    : ast.kids.some((k) => evalFileFilter(k, rowValue));
}

// ── Serializer ──────────────────────────────────────────────────────────────────
export function serializeFilter(node: FilterNode | null): string {
  if (!node) return "";
  if (node.kind === "clause") return `${node.field} = ${node.value}`;
  const sep = node.op === "and" ? " AND " : " OR ";
  return node.kids
    .map((k) => (k.kind === "group" ? `(${serializeFilter(k)})` : serializeFilter(k)))
    .join(sep);
}

// ── Selections (field → value map; "all" when the field has no clause) ──────────
export type FileFilterSelections = Partial<Record<FileFilterFieldId, string>>;

export function selectionsFromAst(ast: FilterNode | null): FileFilterSelections {
  const sel: FileFilterSelections = {};
  const walk = (n: FilterNode) => {
    if (n.kind === "clause") {
      if (sel[n.field] === undefined) sel[n.field] = n.value; // first clause per field drives the control
    } else n.kids.forEach(walk);
  };
  if (ast) walk(ast);
  return sel;
}

// ── Canonical builder (tables.mdx §2.11.4) ──────────────────────────────────────
// Task/status clauses OR together inside ONE paren group (parens only when ≥ 2); size ANDs on.
export function canonicalExpr(selections: FileFilterSelections): string {
  const orClauses: string[] = [];
  let sizeClause: string | null = null;
  for (const id of Object.keys(FILE_FILTER_FIELDS) as FileFilterFieldId[]) {
    const v = selections[id];
    if (!v || v === ALL) continue;
    const text = `${id} = ${v}`;
    if (FILE_FILTER_FIELDS[id].joiner === "and") sizeClause = text;
    else orClauses.push(text);
  }
  const orPart = orClauses.length === 0 ? "" : orClauses.length === 1 ? orClauses[0] : `(${orClauses.join(" OR ")})`;
  if (orPart && sizeClause) return `${orPart} AND ${sizeClause}`;
  return orPart || sizeClause || "";
}

/** True when `text` parses and is structurally identical to the canonical rendering of its own
 *  selections — i.e. the user has not hand-shaped it (whitespace/case/`==` don't count as shaping). */
export function isCanonical(text: string, knownFields?: FileFilterFieldId[]): boolean {
  const p = parseFileFilter(text, knownFields);
  if (!p.ok) return false;
  const canon = parseFileFilter(canonicalExpr(selectionsFromAst(p.ast)), knownFields);
  return canon.ok && serializeFilter(p.ast) === serializeFilter(canon.ast);
}

// ── The segmented-control write path (tables.mdx §2.11.4, control → text) ───────
// While the text is canonical, regenerate canonically. Once the user hand-edited it, the edit is
// SURGICAL: replace that field's clause value in place, drop the clause when set back to All, append
// a newly-activated field (task fields join the first OR group holding a task clause; size ANDs on).
export function setFieldInExpr(
  text: string,
  field: FileFilterFieldId,
  value: string,
  knownFields?: FileFilterFieldId[],
): string {
  const parsed = parseFileFilter(text, knownFields);
  // Unparseable current text (mid-edit) — fall back to a clean canonical of just this change.
  if (!parsed.ok) return canonicalExpr({ [field]: value });
  if (isCanonical(text, knownFields)) {
    const sel = selectionsFromAst(parsed.ast);
    sel[field] = value;
    return canonicalExpr(sel);
  }
  // Surgical path on a hand-edited expression.
  let ast = parsed.ast;
  if (value === ALL) {
    ast = removeField(ast, field);
    return serializeFilter(ast);
  }
  if (hasField(ast, field)) {
    ast = rewriteField(ast, field, value);
    return serializeFilter(ast);
  }
  // Append a field the expression doesn't mention yet.
  const clause: FilterNode = { kind: "clause", field, value };
  if (!ast) return serializeFilter(clause);
  if (FILE_FILTER_FIELDS[field].joiner === "and") {
    const kids = ast.kind === "group" && ast.op === "and" ? [...ast.kids, clause] : [ast, clause];
    return serializeFilter({ kind: "group", op: "and", kids });
  }
  const joined = appendToTaskGroup(ast, clause);
  return serializeFilter(joined ?? { kind: "group", op: "or", kids: [ast, clause] });
}

function hasField(n: FilterNode | null, field: FileFilterFieldId): boolean {
  if (!n) return false;
  if (n.kind === "clause") return n.field === field;
  return n.kids.some((k) => hasField(k, field));
}

function rewriteField(n: FilterNode | null, field: FileFilterFieldId, value: string): FilterNode | null {
  if (!n) return n;
  if (n.kind === "clause") return n.field === field ? { ...n, value } : n;
  return { ...n, kids: n.kids.map((k) => rewriteField(k, field, value)!) };
}

function removeField(n: FilterNode | null, field: FileFilterFieldId): FilterNode | null {
  if (!n) return null;
  if (n.kind === "clause") return n.field === field ? null : n;
  const kids = n.kids.map((k) => removeField(k, field)).filter((k): k is FilterNode => k !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...n, kids };
}

// Insert into the FIRST OR group that already holds a non-size clause; on success returns the new
// root, else null (caller falls back to a top-level OR).
function appendToTaskGroup(root: FilterNode, clause: FilterNode): FilterNode | null {
  let done = false;
  const walk = (n: FilterNode): FilterNode => {
    if (done || n.kind === "clause") return n;
    if (n.op === "or" && n.kids.some((k) => k.kind === "clause" && FILE_FILTER_FIELDS[k.field].joiner === "or")) {
      done = true;
      return { ...n, kids: [...n.kids, clause] };
    }
    return { ...n, kids: n.kids.map(walk) };
  };
  const next = walk(root);
  return done ? next : null;
}

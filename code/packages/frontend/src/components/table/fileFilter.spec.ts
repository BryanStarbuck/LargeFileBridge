// The §2.11 file-filter expression model (tables.mdx §2.11.4) — parser, evaluator, canonical builder,
// and the segmented-control clause rewrite.
import { describe, it, expect } from "vitest";
import {
  parseFileFilter,
  evalFileFilter,
  serializeFilter,
  selectionsFromAst,
  canonicalExpr,
  isCanonical,
  setFieldInExpr,
  type FileFilterFieldId,
  type FileFilterRowValue,
} from "./fileFilter.js";

const row =
  (vals: Partial<Record<FileFilterFieldId, FileFilterRowValue>>) =>
  (f: FileFilterFieldId): FileFilterRowValue =>
    vals[f] ?? "na";

const parse = (text: string) => {
  const p = parseFileFilter(text);
  if (!p.ok) throw new Error(p.error);
  return p.ast;
};

describe("parseFileFilter", () => {
  it("parses the empty expression as no filter", () => {
    expect(parseFileFilter("")).toEqual({ ok: true, ast: null });
    expect(parseFileFilter("   ")).toEqual({ ok: true, ast: null });
  });

  it("parses a single clause", () => {
    expect(parse("transcribe = not_yet")).toEqual({ kind: "clause", field: "transcribe", value: "not_yet" });
  });

  it("accepts spaces inside tokens and is case-insensitive", () => {
    expect(serializeFilter(parse("Transcribe = Not Yet OR AI Description = done"))).toBe(
      "transcribe = not_yet OR ai_description = done",
    );
  });

  it("parses the canonical shape — paren OR group ANDed with size", () => {
    const ast = parse("(transcribe = not_yet OR ocr = not_yet) AND size = only_large");
    expect(serializeFilter(ast)).toBe("(transcribe = not_yet OR ocr = not_yet) AND size = only_large");
  });

  it("honors AND over OR precedence and explicit parens", () => {
    const flat = parse("transcribe = done OR ocr = done AND size = only_large");
    // AND binds tighter: OR(transcribe, AND(ocr, size))
    expect(flat).toMatchObject({ kind: "group", op: "or" });
    const grouped = parse("(transcribe = done OR ocr = done) AND size = only_large");
    expect(grouped).toMatchObject({ kind: "group", op: "and" });
  });

  it("rejects unknown fields and unknown values with a reason", () => {
    expect(parseFileFilter("bogus = done")).toMatchObject({ ok: false });
    expect(parseFileFilter("transcribe = sideways")).toMatchObject({ ok: false });
    expect(parseFileFilter("transcribe = ")).toMatchObject({ ok: false });
    expect(parseFileFilter("(transcribe = done")).toMatchObject({ ok: false });
  });

  it("restricts to a surface's field subset when given one", () => {
    expect(parseFileFilter("transcribe = done", ["ocr"])).toMatchObject({ ok: false });
    expect(parseFileFilter("ocr = done", ["ocr"])).toMatchObject({ ok: true });
  });
});

describe("evalFileFilter", () => {
  it("matches equality per clause; 'all' clauses match everything", () => {
    const ast = parse("transcribe = not_yet");
    expect(evalFileFilter(ast, row({ transcribe: "not_yet" }))).toBe(true);
    expect(evalFileFilter(ast, row({ transcribe: "done" }))).toBe(false);
    expect(evalFileFilter(parse("transcribe = all"), row({ transcribe: "done" }))).toBe(true);
  });

  it("an NA row matches only All (N/A is retired as an option)", () => {
    expect(evalFileFilter(parse("transcribe = not_yet"), row({}))).toBe(false);
    expect(evalFileFilter(parse("transcribe = done"), row({}))).toBe(false);
    expect(evalFileFilter(null, row({}))).toBe(true);
  });

  it("size options map onto large/small row values", () => {
    const only = parse("size = only_large");
    expect(evalFileFilter(only, row({ size: "large" }))).toBe(true);
    expect(evalFileFilter(only, row({ size: "small" }))).toBe(false);
    const not = parse("size = not_large");
    expect(evalFileFilter(not, row({ size: "small" }))).toBe(true);
    expect(evalFileFilter(not, row({ size: "large" }))).toBe(false);
  });

  it("evaluates OR / AND / parens", () => {
    const ast = parse("(transcribe = not_yet OR ocr = not_yet) AND size = only_large");
    expect(evalFileFilter(ast, row({ transcribe: "not_yet", ocr: "done", size: "large" }))).toBe(true);
    expect(evalFileFilter(ast, row({ transcribe: "done", ocr: "done", size: "large" }))).toBe(false);
    expect(evalFileFilter(ast, row({ transcribe: "not_yet", ocr: "done", size: "small" }))).toBe(false);
  });
});

describe("canonicalExpr", () => {
  it("ORs task clauses in one paren group and ANDs size (the §2.11.4 default)", () => {
    expect(canonicalExpr({ transcribe: "not_yet", ocr: "not_yet", size: "only_large" })).toBe(
      "(transcribe = not_yet OR ocr = not_yet) AND size = only_large",
    );
  });

  it("skips parens for a single task clause; emits size alone; all-only emits nothing", () => {
    expect(canonicalExpr({ transcribe: "done", size: "only_large" })).toBe("transcribe = done AND size = only_large");
    expect(canonicalExpr({ size: "only_large" })).toBe("size = only_large");
    expect(canonicalExpr({ transcribe: "all" })).toBe("");
    expect(canonicalExpr({})).toBe("");
  });
});

describe("selections / isCanonical", () => {
  it("reads a field's first clause into the segmented selection", () => {
    const sel = selectionsFromAst(parse("(transcribe = not_yet OR ocr = done) AND size = only_large"));
    expect(sel).toEqual({ transcribe: "not_yet", ocr: "done", size: "only_large" });
  });

  it("recognizes canonical text regardless of case/spacing, and hand-shaped text as non-canonical", () => {
    expect(isCanonical("( transcribe = NOT YET or OCR = not_yet ) AND size = only_large")).toBe(true);
    expect(isCanonical("transcribe = not_yet AND ocr = not_yet")).toBe(false); // ANDed tasks = hand-shaped
    expect(isCanonical("")).toBe(true);
  });
});

describe("setFieldInExpr", () => {
  it("regenerates canonically while the text is canonical", () => {
    let t = "";
    t = setFieldInExpr(t, "transcribe", "not_yet");
    expect(t).toBe("transcribe = not_yet");
    t = setFieldInExpr(t, "ocr", "not_yet");
    expect(t).toBe("(transcribe = not_yet OR ocr = not_yet)");
    t = setFieldInExpr(t, "size", "only_large");
    expect(t).toBe("(transcribe = not_yet OR ocr = not_yet) AND size = only_large");
    t = setFieldInExpr(t, "transcribe", "all");
    expect(t).toBe("ocr = not_yet AND size = only_large");
  });

  it("surgically rewrites just the clause once the user hand-edited the expression", () => {
    const custom = "transcribe = not_yet AND ocr = not_yet"; // user chose AND — must be preserved
    expect(setFieldInExpr(custom, "transcribe", "done")).toBe("transcribe = done AND ocr = not_yet");
  });

  it("surgically removes a clause set back to All, preserving the rest", () => {
    const custom = "transcribe = not_yet AND ocr = not_yet";
    expect(setFieldInExpr(custom, "transcribe", "all")).toBe("ocr = not_yet");
  });

  it("appends a new task field into the existing OR group; ANDs a new size clause on", () => {
    const custom = "(transcribe = not_yet OR ocr = done) AND git_ignore = done"; // hand-shaped (OR group + AND)
    expect(setFieldInExpr(custom, "ai_description", "not_yet")).toBe(
      "(transcribe = not_yet OR ocr = done OR ai_description = not_yet) AND git_ignore = done",
    );
    const noSize = "transcribe = not_yet OR ocr = not_yet OR ocr = done"; // duplicate clause = hand-shaped
    expect(setFieldInExpr(noSize, "size", "only_large")).toBe(
      "(transcribe = not_yet OR ocr = not_yet OR ocr = done) AND size = only_large",
    );
  });

  it("falls back to a clean canonical clause when the current text is unparseable", () => {
    expect(setFieldInExpr("transcribe = ???", "ocr", "done")).toBe("ocr = done");
  });
});

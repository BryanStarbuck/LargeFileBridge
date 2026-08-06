// The column-width allocator (DataTable). These assert the two properties the table's correctness rests
// on and that no amount of eyeballing reliably catches:
//   1. the widths NEVER sum past the container — that overflow is the horizontal scrollbar;
//   2. every column keeps at least the px it needs to render on ONE line — non-uniform row heights break
//      the row windowing (useWindowedRows measures a single row) and surface as an infinite render loop.
import { describe, it, expect } from "vitest";
import { allocateColumnWidths } from "./DataTable.js";
import type { LfbColumn } from "./types.js";

type Row = Record<string, unknown>;
const col = (id: string, kind: LfbColumn<Row>["kind"], extra: Partial<LfbColumn<Row>> = {}) =>
  ({ id, header: id, kind, accessor: () => "", ...extra }) as LfbColumn<Row>;

// The charlie-kirk file table: six icon columns, the File identity column, and four short ones.
const FILE_TABLE: LfbColumn<Row>[] = [
  ...["pin", "ignore", "transcribe", "describe", "ocr", "compress"].map((id) =>
    col(id, "enum", { tight: true, minWidth: 30 }),
  ),
  col("file", "text"),
  col("size", "bytes", { align: "right" }),
  col("peers", "int", { align: "right" }),
  col("cid", "text"),
  col("changed", "timestamp"),
];

// KIND_MIN + the leading/trailing overhead the allocator reserves.
const MINS = [30, 30, 30, 30, 30, 30, 140, 84, 72, 140, 96];
const OVERHEAD_NO_SELECT = 56 + 14;
const OVERHEAD_SELECT = OVERHEAD_NO_SELECT + 32;

describe("allocateColumnWidths", () => {
  it("returns null before the container is measured", () => {
    expect(allocateColumnWidths(FILE_TABLE, 0, false)).toBeNull();
    expect(allocateColumnWidths(FILE_TABLE, Number.NaN, false)).toBeNull();
  });

  it("defers to a caller that declared its own widths", () => {
    const declared = [col("a", "text", { width: "12rem" }), col("b", "int")];
    expect(allocateColumnWidths(declared, 1000, false)).toBeNull();
  });

  it("never exceeds the container — the horizontal-scrollbar guarantee", () => {
    // 700 is narrower than the sum of every column's comfortable minimum, so it exercises the squeeze
    // path; the rest exercise the surplus path. Neither may overflow.
    for (const w of [700, 820, 1000, 1280, 1600, 2560]) {
      for (const sel of [false, true]) {
        const out = allocateColumnWidths(FILE_TABLE, w, sel)!;
        const total = out.reduce((a, b) => a + b, 0) + (sel ? OVERHEAD_SELECT : OVERHEAD_NO_SELECT);
        expect(total, `container=${w} selection=${sel}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("fills the container exactly once there is slack — no phantom remainder", () => {
    for (const w of [1000, 1101, 1237, 1600]) {
      const out = allocateColumnWidths(FILE_TABLE, w, false)!;
      const total = out.reduce((a, b) => a + b, 0) + OVERHEAD_NO_SELECT;
      expect(total, `container=${w}`).toBe(w);
    }
  });

  it("holds every column at its one-line minimum whenever the container has room", () => {
    for (const w of [820, 1000, 1600, 2560]) {
      const out = allocateColumnWidths(FILE_TABLE, w, false)!;
      out.forEach((got, i) => expect(got, `container=${w} col=${i}`).toBeGreaterThanOrEqual(MINS[i]));
    }
  });

  it("never squeezes a column below the legibility floor", () => {
    for (const w of [200, 300, 500, 700]) {
      const out = allocateColumnWidths(FILE_TABLE, w, false)!;
      out.forEach((got) => expect(got, `container=${w}`).toBeGreaterThanOrEqual(30));
      // Only the text columns ever give way; they stop at the floor.
      expect(out[6]).toBeGreaterThanOrEqual(64);
      expect(out[9]).toBeGreaterThanOrEqual(64);
    }
  });

  it("gives the slack to the text columns, not the numeric ones", () => {
    const out = allocateColumnWidths(FILE_TABLE, 1400, false)!;
    expect(out[7]).toBe(84); // size  — untouched
    expect(out[8]).toBe(72); // peers — untouched
    expect(out[10]).toBe(96); // changed — untouched
    expect(out[6]).toBeGreaterThan(140); // file grew
    expect(out[9]).toBeGreaterThan(140); // cid grew
    // Split in proportion to the base, and File and CID share a base, so they stay comparable.
    expect(out[6]).toBe(out[9]);
  });

  it("gives a bounded text column none of the slack", () => {
    // The CID column renders a middle-truncated fixed-length string, so width past its minimum is padding.
    const withBoundedCid = FILE_TABLE.map((c) =>
      c.id === "cid" ? ({ ...c, bounded: true, minWidth: 112 } as LfbColumn<Row>) : c,
    );
    const out = allocateColumnWidths(withBoundedCid, 1400, false)!;
    expect(out[9]).toBe(112); // cid pinned at what it needs
    expect(out[6]).toBeGreaterThan(allocateColumnWidths(FILE_TABLE, 1400, false)![6]); // file got the rest
    expect(out.reduce((a, b) => a + b, 0) + OVERHEAD_NO_SELECT).toBe(1400);
  });

  it("keeps the icon columns tight no matter how wide the window gets", () => {
    const out = allocateColumnWidths(FILE_TABLE, 3000, false)!;
    for (let i = 0; i < 6; i++) expect(out[i]).toBe(30);
  });

  it("squeezes the text columns before overflowing when the window is narrow", () => {
    const out = allocateColumnWidths(FILE_TABLE, 700, false)!;
    // Text columns give way…
    expect(out[6]).toBeLessThan(140);
    expect(out[9]).toBeLessThan(140);
    // …the short ones and the icons do not.
    expect(out[7]).toBe(84);
    expect(out[8]).toBe(72);
    expect(out[10]).toBe(96);
    for (let i = 0; i < 6; i++) expect(out[i]).toBe(30);
  });

  it("stops squeezing at the legibility floor and only then overflows", () => {
    const out = allocateColumnWidths(FILE_TABLE, 300, false)!;
    expect(out[6]).toBe(64);
    expect(out[9]).toBe(64);
    // The numeric/icon columns are never sacrificed, so at this width the row genuinely cannot fit —
    // an honest horizontal scroll rather than columns collapsed to nothing.
    expect(out.reduce((a, b) => a + b, 0) + OVERHEAD_NO_SELECT).toBeGreaterThan(300);
  });

  it("widens the last column when no text column can absorb the slack", () => {
    const numeric = [col("a", "int"), col("b", "bytes")];
    const out = allocateColumnWidths(numeric, 600, false)!;
    expect(out[0]).toBe(72);
    expect(out.reduce((a, b) => a + b, 0) + OVERHEAD_NO_SELECT).toBe(600);
  });
});

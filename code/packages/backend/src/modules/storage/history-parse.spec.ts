// THE HISTORY PARSER — the only non-trivial thing area 8 owns, and the branches this machine's corpus
// cannot reach.
//
// Measured on the real 18 files: 12,599 entry lines, all three verbs (PULL / CONVERT / COMPRESS), three
// field keys (`by`, `cid`, `size`), and ZERO indented per-file blocks. So the per-file branch, the
// malformed-line branch and the summary-containing-an-`=` branch have no live coverage at all — and a
// branch nothing reaches is a branch that is not known to work. Everything below is built by hand for
// exactly that reason.
import { describe, it, expect } from "vitest";
import { parseHistory } from "./history-backfill.js";

/** The literal header `appendHistory` writes into a brand-new log, byte for byte. */
const HEADER =
  '# Large File Bridge — history log for computer "pc-4-pc-4" · repo charlie-kirk\n' +
  "# All timestamps UTC. Append-only. One line per event; indented block when files differ.\n";

const INDENT = " ".repeat(24);

describe("parseHistory", () => {
  it("parses the real line shape and keeps the PHYSICAL line number", () => {
    const text =
      HEADER +
      "2026-08-12T07:32:17.800Z  PULL  by=bikash@act3ai.com  cid=bafkreifrsx  size=50095  Pulled charlie.jpg down over IPFS\n";
    const rows = parseHistory(text, 0, () => expect.unreachable("no line should be rejected"));
    expect(rows).toHaveLength(1);
    // Line 3, not line 1: the two header comments consume line numbers, because `line_no` is the resume
    // cursor and "ingest from N+1" is only exact if N counts every physical line.
    expect(rows[0]!.lineNo).toBe(3);
    expect(rows[0]!.verb).toBe("PULL");
    expect(rows[0]!.actor).toBe("bikash@act3ai.com");
    expect(rows[0]!.fields).toEqual({ cid: "bafkreifrsx", size: "50095" });
    expect(rows[0]!.summary).toBe("Pulled charlie.jpg down over IPFS");
    expect(rows[0]!.at.toISOString()).toBe("2026-08-12T07:32:17.800Z");
  });

  it("resumes from N+1 and re-parses nothing before it — the append-only guarantee", () => {
    const text =
      HEADER +
      "2026-08-01T00:00:00.000Z  PULL  a.mp4\n" +
      "2026-08-02T00:00:00.000Z  PULL  b.mp4\n" +
      "2026-08-03T00:00:00.000Z  PULL  c.mp4\n";
    const rows = parseHistory(text, 4, () => {});
    expect(rows.map((r) => r.lineNo)).toEqual([5]);
    expect(rows[0]!.summary).toBe("c.mp4");
  });

  it("attaches an indented per-file block to the entry above it", () => {
    const text =
      HEADER +
      "2026-08-05T10:00:00.000Z  DECISION  by=bryan@x.com  Decided 2 files\n" +
      `${INDENT}pin=yes  videos/a.mp4\n` +
      `${INDENT}gitignore=no  videos/b with spaces.mp4\n` +
      "2026-08-05T10:00:01.000Z  SCAN  Scanned\n";
    const rows = parseHistory(text, 0, () => expect.unreachable("nothing here is malformed"));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.perFile).toEqual([
      { axis: "pin", value: "yes", path: "videos/a.mp4" },
      // The path is rejoined on the two-space separator, so a filename containing two spaces survives.
      { axis: "gitignore", value: "no", path: "videos/b with spaces.mp4" },
    ]);
    // The block belongs to the entry ABOVE it and must not leak onto the next one.
    expect(rows[1]!.perFile).toBeNull();
  });

  it("does not mistake an `=` inside a SUMMARY for a field", () => {
    // This is the real shape of a COMPRESS summary: `compress-ledger.ts buildRecord` writes reasons like
    // "kept the original — the best candidate was only -47.0% smaller (needs 20%)", and a looser field
    // rule would swallow a summary segment and lose it.
    const text = HEADER + "2026-08-05T10:00:00.000Z  COMPRESS  by=b@x.com  a=1  ratio was 0.83=fine, kept it\n";
    const rows = parseHistory(text, 0, () => {});
    expect(rows[0]!.fields).toEqual({ a: "1" });
    expect(rows[0]!.summary).toBe("ratio was 0.83=fine, kept it");
  });

  it("REPORTS a malformed line and keeps going — mechanic (c) at line granularity", () => {
    const bad: Array<{ lineNo: number; reason: string }> = [];
    const text =
      HEADER +
      "not a history line at all\n" +
      "2026-08-05T10:00:00.000Z  SCAN  fine\n";
    const rows = parseHistory(text, 0, (lineNo, reason) => bad.push({ lineNo, reason }));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.lineNo).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lineNo).toBe(4);
  });

  it("skips blanks and comments without consuming them as entries", () => {
    const text = HEADER + "\n" + "# a later comment\n" + "2026-08-05T10:00:00.000Z  SCAN  ok\n";
    const rows = parseHistory(text, 0, () => expect.unreachable("a blank or comment is not malformed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lineNo).toBe(5);
  });

  it("returns nothing for an empty or header-only file", () => {
    expect(parseHistory("", 0, () => {})).toEqual([]);
    expect(parseHistory(HEADER, 0, () => {})).toEqual([]);
  });
});

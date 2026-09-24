import { test, expect } from "vitest";
import type { Fingerprint } from "@lfb/shared";
import { isValid, parseFrames, serializeFrames } from "./fingerprint.store.js";
import { csvCell, resultsToCsv } from "./fingerprint.csv.js";

const fp: Fingerprint = {
  path: "/x/a.jpg",
  kind: "image",
  algo: "pdq",
  algo_version: "v1 image:edge=512",
  size_bytes: 100,
  mtime_ms: 1_700_000_000_123.5,
  value: "a".repeat(64),
  value_alt: null,
  quality: 90,
  frame_count: null,
  duration_s: null,
  strategy: null,
  compute_ms: 3,
  computed_at: "2026-09-24T00:00:00.000Z",
};

test("a stored fingerprint is valid only for the same size, mtime and engine version", () => {
  expect(isValid(fp, 100, 1_700_000_000_123.5, "v1 image:edge=512")).toBe(true);
  expect(isValid(fp, 101, 1_700_000_000_123.5, "v1 image:edge=512")).toBe(false); // resized/rewritten
  expect(isValid(fp, 100, 1_700_000_005_000, "v1 image:edge=512")).toBe(false); // modified after computing
  expect(isValid(fp, 100, 1_700_000_000_123.5, "v2 image:edge=512")).toBe(false); // engine changed
});

test("frame lists round-trip through the stored text form, and junk lines are skipped", () => {
  const frames = [
    { n: 0, h: "0".repeat(64), q: 100, ts: 0 },
    { n: 1, h: "f".repeat(64), q: 12, ts: 1.066 },
  ];
  expect(parseFrames(serializeFrames(frames))).toEqual(frames);
  expect(parseFrames("garbage\n2,nothex,1,1\n")).toEqual([]);
});

test("CSV cells are quoted and guarded against spreadsheet formula injection", () => {
  expect(csvCell('a,"b"')).toBe('"a,""b"""');
  expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
  expect(csvCell("-12.5")).toBe("-12.5");
  expect(csvCell(null)).toBe("");
  const csv = resultsToCsv([{ path: "/x/a.jpg", ok: true, fingerprint: fp, source: "computed", stored: false }]);
  const [header, row] = csv.trim().split("\n");
  expect(header.split(",")[0]).toBe("path");
  expect(row).toContain("a".repeat(64));
});

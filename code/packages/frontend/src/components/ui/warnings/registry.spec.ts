// The popup's File types filter and visible set (warnings.mdx §4.5.4) — the derivation behind "only the
// videos open checked" and "Apply acts on exactly what is visible and checked".
import { describe, it, expect } from "vitest";
import {
  fileTypeOptions,
  filterVisibleTargets,
  hasFileTypeFilter,
  initialFileTypesOn,
  summarizeFileTypes,
  type WarningTarget,
} from "./registry.js";

const t = (path: string, extra: Partial<WarningTarget> = {}): WarningTarget => ({
  id: `/repo/${path}`,
  label: path,
  name: path.slice(path.lastIndexOf("/") + 1),
  pathText: path,
  ...extra,
});

const mixed = [
  t("clips/a.mp4"),
  t("clips/B.MP4"),
  t("clips/c.webm"),
  t("audio/d.mp3"),
  t("photos/e.jpg"),
  t("photos/f.png"),
  t("docs/g.pdf"),
  t("misc/README"),
];

const ids = (ts: WarningTarget[]) => ts.map((x) => x.name);

describe("fileTypeOptions", () => {
  it("lists one entry per extension (case-folded), videos first, then by count", () => {
    const opts = fileTypeOptions(mixed);
    expect(opts.map((o) => [o.ext, o.group, o.count])).toEqual([
      [".mp4", "video", 2],
      [".webm", "video", 1],
      [".mp3", "audio", 1],
      [".jpg", "image", 1],
      [".png", "image", 1],
      [".pdf", "pdf", 1],
      ["", "other", 1],
    ]);
    expect(opts[0].label).toBe("MP4");
    expect(opts[6].label).toBe("(no extension)");
  });

  it("falls back to the id's last segment when a target has no name", () => {
    expect(fileTypeOptions([{ id: "/x/y/movie.mov", label: "movie" }])[0].ext).toBe(".mov");
  });

  it("is only shown when the subjects span two or more types", () => {
    expect(hasFileTypeFilter(fileTypeOptions([t("a.mp4"), t("b.mp4")]))).toBe(false);
    expect(hasFileTypeFilter(fileTypeOptions([t("a.mp4"), t("b.jpg")]))).toBe(true);
  });
});

describe("initialFileTypesOn", () => {
  it("opens with ONLY the video (and audio) types checked", () => {
    expect([...initialFileTypesOn(fileTypeOptions(mixed))].sort()).toEqual([".mp3", ".mp4", ".webm"]);
  });

  it("opens with every type checked when there is no video or audio at all", () => {
    const images = fileTypeOptions([t("a.jpg"), t("b.png"), t("c.webp")]);
    expect([...initialFileTypesOn(images)].sort()).toEqual([".jpg", ".png", ".webp"]);
  });
});

describe("filterVisibleTargets — the apply gate", () => {
  it("hides every row whose type is unchecked", () => {
    const on = initialFileTypesOn(fileTypeOptions(mixed));
    expect(ids(filterVisibleTargets(mixed, on, ""))).toEqual(["a.mp4", "B.MP4", "c.webm", "d.mp3"]);
  });

  it("narrows by the search box too — a searched-away row is not visible, so it is not applied", () => {
    const on = initialFileTypesOn(fileTypeOptions(mixed));
    expect(ids(filterVisibleTargets(mixed, on, "clips/B"))).toEqual(["B.MP4"]);
    // a row the search matches but the type filter hides stays hidden
    expect(ids(filterVisibleTargets(mixed, on, "photos"))).toEqual([]);
  });

  it("with no type filter, only the search narrows (matching name, path, or size)", () => {
    expect(ids(filterVisibleTargets(mixed, null, ""))).toHaveLength(mixed.length);
    expect(ids(filterVisibleTargets(mixed, null, "DOCS"))).toEqual(["g.pdf"]);
    expect(ids(filterVisibleTargets([t("a.mp4", { sizeText: "128 MB" })], null, "128"))).toEqual(["a.mp4"]);
  });

  it("an empty type set hides everything (Apply is then disabled, never a silent no-op)", () => {
    expect(filterVisibleTargets(mixed, new Set(), "")).toEqual([]);
  });
});

describe("summarizeFileTypes", () => {
  const opts = fileTypeOptions(mixed);
  it("names the checked types, collapsing a long list", () => {
    expect(summarizeFileTypes(opts, new Set([".mp4", ".webm"]))).toBe("MP4, WEBM");
    expect(summarizeFileTypes(opts, new Set([".mp4", ".webm", ".mp3", ".jpg", ".png"]))).toBe("MP4, WEBM, MP3 +2 more");
  });
  it("says All types / None at the extremes", () => {
    expect(summarizeFileTypes(opts, new Set(opts.map((o) => o.ext)))).toBe("All types");
    expect(summarizeFileTypes(opts, new Set())).toBe("None");
  });
});

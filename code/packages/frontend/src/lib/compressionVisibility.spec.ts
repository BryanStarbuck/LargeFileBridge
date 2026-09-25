// The "Show compression features" rules (compression_visibility.mdx §2). Locks what counts as compression
// on each shared surface, and that turning the setting ON is a pure pass-through (same references back).
import { describe, it, expect } from "vitest";
import type { TodoBatchDetail } from "@lfb/shared";
import type { WarningPopupSpec } from "../components/ui/warnings/registry.js";
import {
  isCompressionMetric,
  stripCompressionFromPopup,
  todoBatchWithoutCompression,
  visibleBadges,
  withoutCompressionFields,
} from "./compressionVisibility.js";

describe("compression metrics + filter fields + badges", () => {
  it("flags only the three compression tiles", () => {
    expect(isCompressionMetric("compressibleVideos")).toBe(true);
    expect(isCompressionMetric("alreadyCompressed")).toBe(true);
    expect(isCompressionMetric("transcribable")).toBe(false);
  });

  it("drops the compressible filter fields when off, passes through when on", () => {
    const ids = ["add_to_ipfs", "compressible_videos", "compressible_images", "compressible_audio", "size"] as const;
    expect(withoutCompressionFields([...ids], false)).toEqual(["add_to_ipfs", "size"]);
    const specs = [{ id: "ocr" as const }, { id: "compressible_images" as const }];
    expect(withoutCompressionFields(specs, false)).toEqual([{ id: "ocr" }]);
    expect(withoutCompressionFields(specs, true)).toBe(specs);
  });

  it("hides the C / c badges only", () => {
    expect(visibleBadges(["repo_descendant", "compress", "pin", "compressed"], false)).toEqual(["repo_descendant", "pin"]);
    const none = ["pin" as const];
    expect(visibleBadges(none, false)).toBe(none); // stable reference — memoized rows don't re-render
    const withC = ["compress" as const];
    expect(visibleBadges(withC, true)).toBe(withC);
  });
});

describe("stripCompressionFromPopup", () => {
  const popup: WarningPopupSpec = {
    whatThisIs: "x",
    whyItMatters: "y",
    actionLabel: "Apply",
    apply: async () => {},
    options: [
      { kind: "checkbox", name: "ipfs", label: "Add to IPFS" },
      { kind: "checkbox", name: "compress", label: "Compress" },
    ],
    targets: [
      { id: "a", label: "a", axes: { ipfs: "on", compress: "on" } },
      { id: "b", label: "b", axes: { compress: "on" } }, // compress-only → dropped
      { id: "c", label: "c" }, // single-checkbox row → untouched
    ],
  };

  it("removes the Compress axis, compress-only rows, and the Compress option", () => {
    const out = stripCompressionFromPopup(popup, false);
    expect(out.targets?.map((t) => t.id)).toEqual(["a", "c"]);
    expect(out.targets?.[0].axes).toEqual({ ipfs: "on" });
    expect(out.options?.map((o) => (o.kind === "checkbox" ? o.name : o.value))).toEqual(["ipfs"]);
  });

  it("is a pass-through when on, or when nothing is about compression", () => {
    expect(stripCompressionFromPopup(popup, true)).toBe(popup);
    const plain: WarningPopupSpec = { whatThisIs: "", whyItMatters: "", actionLabel: "Go", apply: async () => {}, targets: [{ id: "a", label: "a" }] };
    expect(stripCompressionFromPopup(plain, false)).toBe(plain);
  });
});

describe("todoBatchWithoutCompression", () => {
  const base = {
    id: "repo:x",
    scope: "repo" as const,
    storageName: "x",
    storageRoot: "/x",
    kind: "todo" as const,
    dismissed: false,
    computedAt: "",
  };

  it("hides a compress-only batch entirely", () => {
    const b: TodoBatchDetail = {
      ...base,
      pattern: "compress",
      totals: { compress_video: { count: 3, reclaimableBytes: 10 } },
      items: [{ path: "v.mov", sizeBytes: 1, category: "compress_video", recommend: { compress: true } }],
    };
    expect(todoBatchWithoutCompression(b, false)).toBeNull();
    expect(todoBatchWithoutCompression(b, true)).toBe(b);
  });

  it("keeps the rest of a mixed batch and re-derives a compress pattern", () => {
    const b: TodoBatchDetail = {
      ...base,
      pattern: "compress",
      totals: { compress_image: { count: 9 }, git_ignore: { count: 2 } },
      items: [
        { path: "a.png", sizeBytes: 1, category: "compress_image", recommend: { compress: true } },
        { path: "b.mov", sizeBytes: 1, category: "git_ignore", recommend: { gitignore: true, compress: true } },
      ],
    };
    const out = todoBatchWithoutCompression(b, false)!;
    expect(out.pattern).toBe("git_ignore");
    expect(Object.keys(out.totals)).toEqual(["git_ignore"]);
    expect(out.items).toEqual([{ path: "b.mov", sizeBytes: 1, category: "git_ignore", recommend: { gitignore: true } }]);
  });

  it("leaves a batch with no compress work untouched", () => {
    const b = { ...base, pattern: "pin" as const, totals: { pin: { count: 1 } } };
    expect(todoBatchWithoutCompression(b, false)).toBe(b);
  });
});

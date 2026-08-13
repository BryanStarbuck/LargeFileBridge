// The CONTINUOUS heal (repo__list_syns.mdx §6.1b). The one-time migration is not enough on its own: it is
// marker-guarded and runs once, while the mirror/reconcile run every cycle. On the live repo the strays
// were deleted at 14:23, a peer on an older build re-added them to the shared sync repo at 15:36, and the
// reconcile had them back on disk at 15:38. These tests pin the boundary that stops that bounce.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  isStrayPathName,
  healedTarget,
  copyHealed,
  mergeSidecarFiles,
  caseIndex,
  resolveCasing,
} from "./sidecar-heal.js";

let tmp: string;
let src: string;
let dst: string;

const STRAY = String.raw`jfk\videos\clip.mp4.yaml`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-sidecar-heal-"));
  src = path.join(tmp, "src");
  dst = path.join(tmp, "dst");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sidecar(events: Array<{ at: string; kind: string; on_device: string }>, extra = ""): string {
  return [
    "file:",
    "  path: jfk/videos/clip.mp4",
    extra,
    "  events:",
    ...events.flatMap((e) => [`    - at: ${e.at}`, `      kind: ${e.kind}`, `      on_device: ${e.on_device}`]),
  ]
    .filter(Boolean)
    .join("\n");
}

describe("isStrayPathName / healedTarget", () => {
  it("recognizes a name that is really a whole relative path", () => {
    expect(isStrayPathName(STRAY)).toBe(true);
    expect(isStrayPathName("clip.mp4.yaml")).toBe(false);
  });

  it("maps the name back to the directories it always meant", () => {
    expect(healedTarget(dst, STRAY)).toBe(path.join(dst, "jfk", "videos", "clip.mp4.yaml"));
  });
});

describe("copyHealed — the ingress boundary", () => {
  it("lands a peer's `\\`-named sidecar at its real path, never under the flat name", () => {
    fs.writeFileSync(path.join(src, STRAY), sidecar([{ at: "2026-08-04T04:52:56Z", kind: "pull", on_device: "rafin" }]));
    expect(copyHealed(path.join(src, STRAY), dst, STRAY)).toBe(true);

    expect(fs.existsSync(path.join(dst, "jfk", "videos", "clip.mp4.yaml"))).toBe(true);
    expect(fs.readdirSync(dst).some((n) => n.includes("\\"))).toBe(false);
  });

  it("MERGES rather than clobbers when the real sidecar is already there", () => {
    fs.mkdirSync(path.join(dst, "jfk", "videos"), { recursive: true });
    fs.writeFileSync(
      path.join(dst, "jfk", "videos", "clip.mp4.yaml"),
      sidecar([{ at: "2026-08-03T12:59:41Z", kind: "pull", on_device: "lenovo" }], "  size: 45006721"),
    );
    fs.writeFileSync(path.join(src, STRAY), sidecar([{ at: "2026-08-04T04:52:56Z", kind: "pull", on_device: "rafin" }]));
    expect(copyHealed(path.join(src, STRAY), dst, STRAY)).toBe(true);

    const doc = parse(fs.readFileSync(path.join(dst, "jfk", "videos", "clip.mp4.yaml"), "utf8"));
    expect(doc.file.events.map((e: { on_device: string }) => e.on_device)).toEqual(["lenovo", "rafin"]);
    expect(doc.file.size).toBe(45006721); // the correctly-spelled file's identity survives
  });

  it("is idempotent — re-copying the same stray does not duplicate its events", () => {
    fs.writeFileSync(path.join(src, STRAY), sidecar([{ at: "2026-08-04T04:52:56Z", kind: "pull", on_device: "rafin" }]));
    copyHealed(path.join(src, STRAY), dst, STRAY);
    copyHealed(path.join(src, STRAY), dst, STRAY);
    copyHealed(path.join(src, STRAY), dst, STRAY);

    const doc = parse(fs.readFileSync(path.join(dst, "jfk", "videos", "clip.mp4.yaml"), "utf8"));
    expect(doc.file.events).toHaveLength(1);
  });

  it("never overwrites a colliding NON-sidecar it cannot merge", () => {
    const stray = String.raw`a\b.mp4`;
    fs.mkdirSync(path.join(dst, "a"), { recursive: true });
    fs.writeFileSync(path.join(dst, "a", "b.mp4"), "REAL");
    fs.writeFileSync(path.join(src, stray), "STRAY");
    expect(copyHealed(path.join(src, stray), dst, stray)).toBe(false);
    expect(fs.readFileSync(path.join(dst, "a", "b.mp4"), "utf8")).toBe("REAL");
  });
});

describe("mergeSidecarFiles", () => {
  it("keeps every event from both halves of a forked history, ordered by time", () => {
    const a = path.join(tmp, "a.yaml");
    const b = path.join(tmp, "b.yaml");
    fs.writeFileSync(a, sidecar([{ at: "2026-08-04T04:52:56Z", kind: "ipfs_pin", on_device: "rafin" }]));
    fs.writeFileSync(
      b,
      sidecar([
        { at: "2026-08-03T12:59:41Z", kind: "pull", on_device: "lenovo" },
        { at: "2026-08-05T01:00:00Z", kind: "observed", on_device: "rafin" },
      ]),
    );
    expect(mergeSidecarFiles(a, b)).toBe(true);
    const doc = parse(fs.readFileSync(b, "utf8"));
    expect(doc.file.events.map((e: { kind: string }) => e.kind)).toEqual(["pull", "ipfs_pin", "observed"]);
  });

  it("refuses when the survivor is unreadable — never lose the half we cannot merge into", () => {
    const a = path.join(tmp, "a.yaml");
    const b = path.join(tmp, "b.yaml");
    fs.writeFileSync(a, sidecar([{ at: "2026-08-04T04:52:56Z", kind: "pull", on_device: "rafin" }]));
    fs.writeFileSync(b, ":\n  not: [valid");
    expect(mergeSidecarFiles(a, b)).toBe(false);
  });
});

// The CASE heal. A case-sensitive peer can hold `nano_banana/` and `Nano_Banana/` at once and mirrors both;
// a Mac or Windows clone cannot, and git ends up tracking two paths for one file. Observed on the live act3
// repo: `git add` bound to the wrong index entry and silently updated it, so the file `git status` showed as
// modified could not be committed from the Mac at all. These tests pin the boundary that stops that.
describe("caseIndex / resolveCasing — the case heal", () => {
  it("defers to the spelling already on disk", () => {
    fs.mkdirSync(path.join(dst, "Nano_Banana"));
    expect(resolveCasing(caseIndex(dst), "nano_banana")).toBe("Nano_Banana");
  });

  it("leaves a name alone when it already matches exactly", () => {
    fs.mkdirSync(path.join(dst, "Nano_Banana"));
    expect(resolveCasing(caseIndex(dst), "Nano_Banana")).toBe("Nano_Banana");
  });

  it("leaves a genuinely new name alone", () => {
    fs.mkdirSync(path.join(dst, "Nano_Banana"));
    expect(resolveCasing(caseIndex(dst), "jenny_movie")).toBe("jenny_movie");
  });

  it("is stable: whichever spelling landed first keeps winning", () => {
    fs.mkdirSync(path.join(dst, "Nano_Banana"));
    const index = caseIndex(dst);
    expect(resolveCasing(index, "NANO_BANANA")).toBe("Nano_Banana");
    expect(resolveCasing(index, "nano_banana")).toBe("Nano_Banana");
  });

  it("treats an absent destination as having no established spelling", () => {
    expect(resolveCasing(caseIndex(path.join(tmp, "nope")), "nano_banana")).toBe("nano_banana");
  });
});

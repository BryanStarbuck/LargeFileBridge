// Behavioural cover for the bounded `sameBytes` rewrite (memory.mdx — resident memory).
//
// The old implementation read BOTH files fully into memory. The replacement streams a fixed 1 MiB window,
// which is a real behaviour change on the boundary cases — chunk-aligned sizes, a difference in the final
// partial chunk, empty files, a missing file. `sameBytes` is not exported (it is an internal detail of the
// merge), so this drives it through `copyTrackedFile`, whose plain-copy fallback returns TRUE exactly
// when it decided the files differed and copied.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTrackedFile } from "./tracked-file-merge.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-samebytes-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write src+dst as a plain (non-sidecar, non-history) tracked file and return "did it copy?". */
function copied(srcBuf: Buffer, dstBuf: Buffer | null): boolean {
  const rel = "media/clip.bin"; // not a sidecar, not history -> the plain-copy fallback under test
  const src = path.join(dir, "src", rel);
  const dst = path.join(dir, "dst", rel);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(src, srcBuf);
  if (dstBuf !== null) fs.writeFileSync(dst, dstBuf);
  return copyTrackedFile(src, dst, rel);
}

const CHUNK = 1024 * 1024;

describe("sameBytes (bounded compare)", () => {
  it("identical small files are not copied", () => {
    expect(copied(Buffer.from("hello"), Buffer.from("hello"))).toBe(false);
  });

  it("same-length files differing in one byte ARE copied", () => {
    // The size fast-path cannot settle this one, so it exercises the streaming comparison.
    expect(copied(Buffer.from("hello"), Buffer.from("hellO"))).toBe(true);
  });

  it("different-length files are copied", () => {
    expect(copied(Buffer.from("hello"), Buffer.from("hello!"))).toBe(true);
  });

  it("two empty files are identical", () => {
    expect(copied(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });

  it("a missing destination is copied", () => {
    expect(copied(Buffer.from("hello"), null)).toBe(true);
  });

  it("files larger than one chunk, identical, are not copied", () => {
    const big = Buffer.alloc(CHUNK * 2 + 12345, 0xab);
    expect(copied(big, Buffer.from(big))).toBe(false);
  });

  it("detects a difference in the FINAL partial chunk", () => {
    // The regression this guards: an off-by-one in the tail read would silently report "identical" and
    // skip a copy, losing the user's newer bytes — a data-loss bug, not a performance one.
    const a = Buffer.alloc(CHUNK * 2 + 500, 0xab);
    const b = Buffer.from(a);
    b[b.length - 1] = 0x00;
    expect(copied(a, b)).toBe(true);
  });

  it("detects a difference exactly on a chunk boundary", () => {
    const a = Buffer.alloc(CHUNK * 2, 0xab);
    const b = Buffer.from(a);
    b[CHUNK] = 0x00; // first byte of the second chunk
    expect(copied(a, b)).toBe(true);
  });

  it("an exactly chunk-sized identical pair is not copied", () => {
    const a = Buffer.alloc(CHUNK, 0x7f);
    expect(copied(a, Buffer.from(a))).toBe(false);
  });
});

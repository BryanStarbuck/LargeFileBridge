// The streaming JSON reader backfill area 9 reads its 7 MB source through (raw-json.ts).
//
// Every test here uses a TINY chunk size on purpose. The whole reason this module exists rather than a
// `JSON.parse` is that it must not hold the file, and the only interesting bugs in a chunked scanner are at
// the chunk boundaries: a string split mid-escape, a multi-byte codepoint split across a read, a member
// larger than one chunk. A 16-byte chunk puts a boundary inside nearly every value in these fixtures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamJsonMembers } from "./raw-json.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-rawjson-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

describe("streamJsonMembers — top-level objects", () => {
  it("yields every key/value pair in the file's own order", () => {
    const src = { a: { cid: null, at: "x" }, b: { cid: "Qm1", at: "y" }, c: 3 };
    const out = [...streamJsonMembers(write("o.json", JSON.stringify(src)), 16)];
    expect(out.map((m) => m.key)).toEqual(["a", "b", "c"]);
    expect(out[1]!.value).toEqual({ cid: "Qm1", at: "y" });
    expect(out[2]!.value).toBe(3);
  });

  it("keeps NULL values intact — the negative cache is 91.8% of the real file", () => {
    const out = [...streamJsonMembers(write("n.json", JSON.stringify({ k: { cid: null } })), 16)];
    expect((out[0]!.value as { cid: unknown }).cid).toBeNull();
  });

  it("survives a chunk boundary inside a key, a value and an escape sequence", () => {
    // The key carries a quote-escape and a backslash-escape; a naive scanner stops on the escaped quote and
    // then mis-reads the rest of the file as structure.
    const key = 'a"b\\c'.repeat(8);
    const src = { [key]: { note: 'he said "hi"\\' } };
    const out = [...streamJsonMembers(write("e.json", JSON.stringify(src)), 8)];
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe(key);
    expect((out[0]!.value as { note: string }).note).toBe('he said "hi"\\');
  });

  it("does not corrupt a multi-byte codepoint split across a read", () => {
    // Read in raw bytes this file splits an emoji; a `Buffer.toString` per chunk would yield U+FFFD. The
    // StringDecoder is what stops that, and file paths on this machine really do carry emoji.
    const key = `/Users/x/vidéo-🎬-${"ü".repeat(40)}.mp4`;
    const out = [...streamJsonMembers(write("u.json", JSON.stringify({ [key]: 1 })), 8)];
    expect(out[0]!.key).toBe(key);
  });

  it("yields an empty object as nothing at all", () => {
    expect([...streamJsonMembers(write("z.json", "{}"), 8)]).toHaveLength(0);
  });
});

describe("streamJsonMembers — top-level arrays", () => {
  it("yields elements with a null key", () => {
    const src = [{ absPath: "/a" }, { absPath: "/b" }];
    const out = [...streamJsonMembers(write("a.json", JSON.stringify(src, null, 2)), 16)];
    expect(out.map((m) => m.key)).toEqual([null, null]);
    expect(out.map((m) => (m.value as { absPath: string }).absPath)).toEqual(["/a", "/b"]);
  });

  it("handles nested containers inside an element without trying to stream them", () => {
    const src = [{ a: [1, 2, { b: "}" }], c: { d: "]" } }];
    const out = [...streamJsonMembers(write("nest.json", JSON.stringify(src)), 4)];
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toEqual(src[0]);
  });
});

describe("streamJsonMembers — refusing to migrate a prefix", () => {
  it("throws on a truncated file rather than yielding what it managed to read", () => {
    // A silent partial read is the worst outcome available: the run would report success having migrated an
    // arbitrary prefix, and the watermark would record that as complete.
    const p = write("t.json", '{"a":{"cid":null},"b":{"cid"');
    expect(() => [...streamJsonMembers(p, 8)]).toThrow(/truncated JSON/);
  });

  it("throws when the top level is neither an object nor an array", () => {
    expect(() => [...streamJsonMembers(write("s.json", '"hello"'), 8)]).toThrow(/object or array/);
  });
});

describe("streamJsonMembers — it does not hold the file", () => {
  it("reads in bounded chunks instead of slurping the file", () => {
    // 20,000 members with path-shaped keys — several MB on disk, the shape of the real
    // `foreign-pin-cache.json`. The assertion is on the READ PATTERN rather than on `heapUsed`, because
    // `heapUsed` between GCs measures garbage as well as live data and would answer a different question
    // (that is precisely the trap that made the 4 GB incident look healthy — rssMB=4103 with heapUsedMB=78,
    // memory.mdx). What must stay true is that no single read pulls in the file: a future "simplification"
    // to `JSON.parse(readFileSync(...))` fails here immediately.
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) {
      obj[`/Users/bryanstarbuck/BGit/some/deep/directory/path/number/${i}/file_${i}.mp4::${i}:1770591751762`] = {
        cid: null,
        at: "2026-08-24T18:02:18.725Z",
      };
    }
    const p = write("big.json", JSON.stringify(obj));
    const bytes = fs.statSync(p).size;
    expect(bytes).toBeGreaterThan(2_000_000);

    const CHUNK = 65_536;
    const readSync = fs.readSync.bind(fs);
    const reads: number[] = [];
    const spy = vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const n = readSync(...args);
      reads.push(n);
      return n;
    }) as typeof fs.readSync);
    try {
      let n = 0;
      let sawNull = 0;
      for (const member of streamJsonMembers(p, CHUNK)) {
        n += 1;
        if ((member.value as { cid: unknown }).cid === null) sawNull += 1;
      }
      expect(n).toBe(20_000);
      expect(sawNull).toBe(20_000); // every negative survived the trip
    } finally {
      spy.mockRestore();
    }

    expect(Math.max(...reads)).toBeLessThanOrEqual(CHUNK);
    expect(reads.length).toBeGreaterThanOrEqual(Math.floor(bytes / CHUNK));
  });
});

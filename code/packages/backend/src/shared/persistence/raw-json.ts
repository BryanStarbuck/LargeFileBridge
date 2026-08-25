// THE BACKFILL'S JSON READER — a streaming one, and the streaming is the whole point.
//
// The companion to `raw-yaml.ts`, for the areas whose source is a JSON store rather than a YAML document.
// It exists because of ONE file: `foreign-pin-cache.json` is 7,198,446 B holding 36,103 members
// (database_migration.mdx §4.1 area 9). `JSON.parse` of that produces the whole object graph at once —
// measured at roughly 40 MB of live heap for this file, every byte of it garbage the moment the last row is
// inserted — and this module's entire history is a memory incident caused by exactly that shape (the 4 GB
// RSS event of 2026-07-20, memory.mdx). A migration that fixes a memory problem by allocating a 40 MB
// object graph has not fixed anything.
//
// So the file is read in 256 KiB chunks and yielded one member at a time. Peak live data is one chunk plus
// one member, which for this corpus is a path string and a four-key object.
//
// THIS IS NOT A GENERAL JSON PARSER. It handles exactly what a store written by `JSON.stringify` looks like:
// one top-level array or object whose members are complete JSON values. It does not stream NESTED
// containers — a member's own value is parsed with `JSON.parse` once its extent is known, which is correct
// here because the members are small and is the reason the scanner stays under a hundred lines.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface JsonMember {
  /** The property name for a top-level object; `null` for a top-level array's elements. */
  key: string | null;
  value: unknown;
}

const WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * Yield the members of the top-level container in `file`, in the file's own iteration order.
 *
 * THAT ORDER IS THE CURSOR. A byte offset means nothing to a resuming run once the source has been
 * rewritten, so area 9's watermark is "the last key I inserted" and resume means "stream again, skipping
 * until I see it" (database_migration.mdx §4.1 area 9, RESUME). That only works because `JSON.stringify`
 * and this reader agree on order, which they do: both walk the object's own property order.
 *
 * Throws on a truncated or malformed file. That is deliberate — the caller turns it into a reject or a
 * failed scope with a real message, rather than silently migrating a prefix of the data.
 */
export function* streamJsonMembers(file: string, chunkBytes = 262_144): Generator<JsonMember> {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let buf = "";
  let pos = 0;
  let eof = false;

  /** Pull another chunk in. False once the file is exhausted. */
  const fill = (): boolean => {
    if (eof) return false;
    const n = fs.readSync(fd, chunk, 0, chunkBytes, null);
    if (n === 0) {
      // `decoder.end()` flushes a trailing partial sequence; without it a file ending mid-codepoint would
      // silently drop its last character rather than reporting the truncation.
      buf += decoder.end();
      eof = true;
      return false;
    }
    buf += decoder.write(chunk.subarray(0, n));
    return true;
  };

  /** Run `fn` against the current buffer, pulling more input while it answers "incomplete" (-1). */
  const need = (fn: () => number): number => {
    for (;;) {
      const r = fn();
      if (r >= 0) return r;
      if (!fill()) throw new Error(`${file}: truncated JSON (unterminated value at byte ~${pos})`);
    }
  };

  /** First non-whitespace index at or after `i`, or -1 when the buffer ran out. */
  const skipWs = (i: number): number => {
    while (i < buf.length && WS.has(buf[i]!)) i += 1;
    return i < buf.length ? i : -1;
  };

  /** Index just past the string literal starting at `i` (which must be `"`), or -1 for incomplete. */
  const scanString = (i: number): number => {
    let j = i + 1;
    while (j < buf.length) {
      const c = buf[j]!;
      if (c === "\\") {
        j += 2; // a `\uXXXX` escape is still opaque here — we only need to not stop on the quote it hides
        continue;
      }
      if (c === '"') return j + 1;
      j += 1;
    }
    return -1;
  };

  /** Index just past the complete JSON value starting at `i`, or -1 for incomplete. */
  const scanValue = (i: number): number => {
    const c = buf[i]!;
    if (c === '"') return scanString(i);
    if (c === "{" || c === "[") {
      let depth = 0;
      let j = i;
      while (j < buf.length) {
        const d = buf[j]!;
        if (d === '"') {
          const end = scanString(j);
          if (end < 0) return -1;
          j = end;
          continue;
        }
        if (d === "{" || d === "[") depth += 1;
        else if (d === "}" || d === "]") {
          depth -= 1;
          if (depth === 0) return j + 1;
        }
        j += 1;
      }
      return -1;
    }
    // A primitive (number / true / false / null) ends at the first structural character or whitespace. It
    // needs the terminator to be PRESENT before it can be called complete, or a number split across a chunk
    // boundary would be truncated silently.
    let j = i;
    while (j < buf.length && !WS.has(buf[j]!) && buf[j] !== "," && buf[j] !== "}" && buf[j] !== "]") j += 1;
    return j < buf.length ? j : -1;
  };

  /** Drop the consumed prefix so `buf` stays bounded rather than growing to the size of the file. */
  const compact = (): void => {
    if (pos >= chunkBytes) {
      buf = buf.slice(pos);
      pos = 0;
    }
  };

  try {
    pos = need(() => skipWs(pos));
    const open = buf[pos];
    if (open !== "{" && open !== "[") throw new Error(`${file}: expected a JSON object or array at the top level`);
    const isObject = open === "{";
    const close = isObject ? "}" : "]";
    pos += 1;

    let first = true;
    for (;;) {
      compact();
      pos = need(() => skipWs(pos));
      if (buf[pos] === close) return;
      if (!first) {
        if (buf[pos] !== ",") throw new Error(`${file}: expected ',' between members`);
        pos += 1;
        pos = need(() => skipWs(pos));
        if (buf[pos] === close) return; // tolerate a trailing comma rather than losing the whole file to it
      }
      first = false;

      let key: string | null = null;
      if (isObject) {
        if (buf[pos] !== '"') throw new Error(`${file}: expected a quoted property name`);
        const keyEnd = need(() => scanString(pos));
        key = JSON.parse(buf.slice(pos, keyEnd)) as string;
        pos = keyEnd;
        pos = need(() => skipWs(pos));
        if (buf[pos] !== ":") throw new Error(`${file}: expected ':' after property name`);
        pos += 1;
        pos = need(() => skipWs(pos));
      }

      const valEnd = need(() => scanValue(pos));
      const raw = buf.slice(pos, valEnd);
      pos = valEnd;
      yield { key, value: JSON.parse(raw) as unknown };
    }
  } finally {
    fs.closeSync(fd);
  }
}

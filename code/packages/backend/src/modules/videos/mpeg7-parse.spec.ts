// The MPEG-7 signature detect-log parser (subsets.mdx §7.3) against a CANNED ffmpeg stderr log — the
// parser must be tolerant of prefixes, integer/decimal seconds, and junk lines, and must pair the
// "whole video matching" qualifier with the match line it follows.
import { describe, expect, it } from "vitest";
import { parseSignatureDetectLog } from "./mpeg7-signature.service.js";

const CANNED_LOG = `
ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
  built with Apple clang version 15.0.0
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/Users/x/Movies/clips/trees_clip.mp4':
  Duration: 00:03:02.00, start: 0.000000, bitrate: 18974 kb/s
Input #1, mov,mp4,m4a,3gp,3g2,mj2, from '/Users/x/Movies/trees_full.mov':
  Duration: 00:10:04.00, start: 0.000000, bitrate: 27011 kb/s
Stream mapping:
  Stream #0:0 (h264) -> signature
  Stream #1:0 (h264) -> signature
Press [q] to stop, [?] for help
Output #0, null, to 'pipe:':
frame= 5462 fps=311 q=-0.0 Lsize=N/A time=00:03:02.00 bitrate=N/A speed=10.4x
[Parsed_signature_0 @ 0x7f8a4c00] matching of video 0 at 0.000000 and 1 at 190.033333, 5462 frames matching
[Parsed_signature_0 @ 0x7f8a4c00] whole video matching
video:2340kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown
`;

const PARTIAL_LOG = `
[Parsed_signature_0 @ 0x600002f0] matching of video 1 at 42.5 and 0 at 7, 900 frames matching
[Parsed_signature_0 @ 0x600002f0] matching of video 0 at 3.400000 and 1 at 88.000000, 218 frames matching
`;

describe("parseSignatureDetectLog", () => {
  it("parses the canonical match line and pairs the whole-video qualifier", () => {
    const matches = parseSignatureDetectLog(CANNED_LOG);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      firstIndex: 0,
      firstS: 0,
      secondIndex: 1,
      secondS: 190.033333,
      frames: 5462,
      whole: true,
    });
  });

  it("parses multiple matches, either input order, integer or decimal seconds, no whole flag", () => {
    const matches = parseSignatureDetectLog(PARTIAL_LOG);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ firstIndex: 1, firstS: 42.5, secondIndex: 0, secondS: 7, frames: 900, whole: false });
    expect(matches[1].frames).toBe(218);
    expect(matches[1].whole).toBe(false);
  });

  it("returns [] for a log with no match report (a no-hit detect, or garbage)", () => {
    expect(parseSignatureDetectLog("")).toEqual([]);
    expect(parseSignatureDetectLog("frame= 100 fps=30 speed=1x\nnothing to see here\n")).toEqual([]);
    // A truncated/mangled match line must be skipped, never throw.
    expect(parseSignatureDetectLog("matching of video 0 at NaN and 1 at ,")).toEqual([]);
  });
});

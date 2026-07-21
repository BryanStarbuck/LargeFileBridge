// The transient-download filter (scan.mdx §4.3.1). Contract:
//   1. A downloader's in-flight temp file is NEVER a scan candidate — the scanner walk drops it before
//      stat, and the watcher's qualifying test refuses to kick a rescan for it. This is the fix for the
//      2026-07-21 phantom-row bug: a yt-dlp HLS fragment (`….fhls-662.mp4`) lived ~60 s during a
//      download, a watcher-kicked rescan indexed it, and the row outlived the file — describe/OCR then
//      failed with file_not_found and auto-decide pinned a path that no longer existed.
//   2. Real media files — including ones with dots, dashes, and long numeric names — are untouched.
import { describe, it, expect } from "vitest";
import { isTransientDownloadFile, isMediaFile } from "./scan-filters.js";

describe("isTransientDownloadFile", () => {
  it("matches yt-dlp per-format intermediates (the bug's exact filenames)", () => {
    // The three files the watcher saw appear/vanish during the 2026-07-21 download.
    expect(isTransientDownloadFile("2079684519762993659.fhls-662.mp4")).toBe(true);
    expect(isTransientDownloadFile("2079684519762993659.fhls-audio-128000-Audio.mp4")).toBe(true);
    expect(isTransientDownloadFile("2079684519762993659.temp.mp4")).toBe(true);
    // Other yt-dlp format-id shapes: numeric, dash, http.
    expect(isTransientDownloadFile("video.f137.mp4")).toBe(true);
    expect(isTransientDownloadFile("video.f251.webm")).toBe(true);
    expect(isTransientDownloadFile("clip.fdash-video-2500000.mp4")).toBe(true);
    expect(isTransientDownloadFile("clip.fhttp-720.mp4")).toBe(true);
  });

  it("matches partial-download marker extensions", () => {
    expect(isTransientDownloadFile("movie.mp4.part")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.ytdl")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.crdownload")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.partial")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.opdownload")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.aria2")).toBe(true);
    expect(isTransientDownloadFile("movie.mp4.part-Frag12")).toBe(true);
  });

  it("never matches real media files", () => {
    // The final merged file the download produced — must stay a candidate.
    expect(isTransientDownloadFile("2079684519762993659.mp4")).toBe(false);
    expect(isTransientDownloadFile("movie.final.mp4")).toBe(false); // .f… word that is not a format id
    expect(isTransientDownloadFile("holiday.fhd.mp4")).toBe(false); // f + letters ≠ hls/dash/http
    expect(isTransientDownloadFile("family.film.mov")).toBe(false);
    expect(isTransientDownloadFile("photo.jpg")).toBe(false);
    expect(isTransientDownloadFile("temp.mp4")).toBe(false); // whole basename "temp", not a .temp. suffix
    expect(isTransientDownloadFile("attempt.mp4")).toBe(false);
  });

  it("is independent of isMediaFile — a transient fragment still LOOKS like media by extension", () => {
    // This is exactly why the walk needs the separate transient test: extension alone admits it.
    expect(isMediaFile("2079684519762993659.fhls-662.mp4")).toBe(true);
    expect(isTransientDownloadFile("2079684519762993659.fhls-662.mp4")).toBe(true);
  });
});

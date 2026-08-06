// THE ENGINES TAKE A PATH TOO (security audit finding 2, second half).
//
// The column browser, the media stream and the entity view each confine their path. The media ENGINES did
// not: compress, OCR, transcribe, describe and git-ignore read the caller's absolute path straight out of
// the request. Those routes do more than read — compress rewrites the file IN PLACE, OCR/transcribe write
// an artifact beside it, describe ships the bytes to a third-party AI provider — so an allow-listed
// principal (in server mode, an allow-listed DOMAIN) could aim any of them anywhere the app's user can
// reach. `confineRequestPaths` is the router-edge guard, so a route added later inherits it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Request, Response } from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-confine-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-outside-"));
const priorBrowseRoots = process.env.LFB_BROWSE_ROOTS;
process.env.LFB_BROWSE_ROOTS = root;

vi.mock("../store-model/config.service.js", () => ({ getAppConfig: () => ({ scanner: { roots: [] } }) }));
vi.mock("../store-model/units.service.js", () => ({ listRepoFolders: () => [], getRepoConfig: () => ({ repo: {} }) }));
vi.mock("./cloud-roots.js", () => ({ detectCloudRoots: () => [] }));

const { confineRequestPaths } = await import("./allow-root.js");

beforeAll(() => {
  fs.writeFileSync(path.join(root, "clip.mp4"), "x");
  fs.writeFileSync(path.join(outside, "secret.mp4"), "x");
});
afterAll(() => {
  if (priorBrowseRoots === undefined) delete process.env.LFB_BROWSE_ROOTS;
  else process.env.LFB_BROWSE_ROOTS = priorBrowseRoots;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function call(req: Partial<Request>): { status: number | null; nexted: boolean } {
  let status: number | null = null;
  let nexted = false;
  const res = {
    status: (c: number) => {
      status = c;
      return { json: () => {} } as unknown as Response;
    },
  } as unknown as Response;
  confineRequestPaths({ method: "POST", originalUrl: "/api/ocr/file", query: {}, ...req } as Request, res, () => {
    nexted = true;
  });
  return { status, nexted };
}

describe("confineRequestPaths", () => {
  it("passes a path inside the allowed roots through", () => {
    expect(call({ body: { path: path.join(root, "clip.mp4") } })).toEqual({ status: null, nexted: true });
  });

  it("refuses a path outside them with 403 and never reaches the handler", () => {
    expect(call({ body: { path: path.join(outside, "secret.mp4") } })).toEqual({ status: 403, nexted: false });
  });

  it("checks the QUERY path too — /compress/check and /ocr/file read it from there", () => {
    expect(call({ query: { path: path.join(outside, "secret.mp4") } }).status).toBe(403);
    expect(call({ query: { path: path.join(root, "clip.mp4") } }).nexted).toBe(true);
  });

  it("checks EVERY entry of paths[], not just the first — a batch is as dangerous as its worst item", () => {
    const body = { paths: [path.join(root, "clip.mp4"), path.join(outside, "secret.mp4")] };
    expect(call({ body }).status).toBe(403);
  });

  it("checks `root`, the directory-scope field the tree/inside routes take", () => {
    expect(call({ body: { root: outside } }).status).toBe(403);
    expect(call({ body: { root } }).nexted).toBe(true);
  });

  it("refuses a traversal that climbs out of an allowed root", () => {
    expect(call({ body: { path: path.join(root, "..", path.basename(outside), "secret.mp4") } }).status).toBe(403);
  });

  it("refuses a SYMLINK inside a root that points outside it", () => {
    const link = path.join(root, "escape.mp4");
    fs.symlinkSync(path.join(outside, "secret.mp4"), link);
    try {
      expect(call({ body: { path: link } }).status).toBe(403);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("lets a request that carries no path at all through untouched", () => {
    expect(call({ body: { overwrite: true } })).toEqual({ status: null, nexted: true });
    expect(call({})).toEqual({ status: null, nexted: true });
  });
});

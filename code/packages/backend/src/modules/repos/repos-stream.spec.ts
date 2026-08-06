// THE WIRE CONTRACT for the two progressive routes (performance.mdx P-37).
//
// `repo-row-stats.spec.ts` pins that streaming COMPOSES the same thing as buffering. This file pins the
// other half — that the same thing actually reaches the client, in the order the reducer in
// `frontend/src/api/streamQueries.ts` depends on:
//
//   • the Repos list:  meta → batch× → done, and the concatenated batches ARE `GET /api/repos`;
//   • the repo detail: head FIRST (that is the entire point — the page paints before the walk finishes),
//     then files/totals/pins/extras, then done, and a client that folds those events back together lands
//     on exactly `GET /api/repos/:repoId`.
//
// The last one is the assertion that matters most: two ways to fetch one repo that disagree would put two
// different numbers in front of the user with no way to tell which is right.
//
// Real express + a real socket, so route ORDERING is exercised too (`/stream` must not be captured by
// `/:repoId`). Auth is stubbed — this file is about the stream, not the gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FileRow, RepoDetail, RepoRow, RepoDetailStreamEvent, RepoRowsStreamEvent } from "@lfb/shared";

const FOLDER = "stream-fixture";
const ROWS = 600; // > ROW_BATCH (250), so the walk MUST produce several batches

let tmp: string;
let repoRoot: string;
let server: Server;
let base: string;
let repoId: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-repos-stream-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");

  // A REAL git working tree: composeFileRows runs `git check-ignore` over every candidate, and a fixture
  // that isn't a repo would skip the one step this change moved off the blocking spawn.
  repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repoRoot, "videos"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "*.mp4\n");
  for (let i = 0; i < ROWS; i++) fs.writeFileSync(path.join(repoRoot, "videos", `clip${i}.mp4`), "x");

  const shared = await import("@lfb/shared");
  const cfg = await import("../store-model/config.service.js");
  const units = await import("../store-model/units.service.js");
  const { reposRouter } = await import("./repos.router.js");
  const express = (await import("express")).default;

  await cfg.updateAppConfig((c) => {
    c.server.mode = "local";
    c.access.allowed_emails = ["stream@localhost"];
    // Scope the freshness self-heal's background scan to the fixture — never the developer's home dir.
    c.scanner.roots = [repoRoot];
    return c;
  });

  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: "stream-fixture", path: repoRoot, remote: null },
    pinned: true,
    decisions: { "videos/clip0.mp4": "sync", "videos/clip1.mp4": "ignore" },
  }));
  units.writeRepoStatus(
    FOLDER,
    shared.UnitStatusSchema.parse({
      last_scan_at: new Date().toISOString(),
      last_pin_at: new Date().toISOString(),
      candidates: Array.from({ length: ROWS }, (_, i) => ({
        path: `videos/clip${i}.mp4`,
        size: 4096,
        modified_at: "2026-07-01T00:00:00Z",
      })),
    }),
  );
  units.writeRepoManifest(
    FOLDER,
    shared.ManifestSchema.parse({
      generated_at: "2026-07-01T00:00:00Z",
      files: [
        { path: "videos/clip0.mp4", cid: "bafyone", size: 4096, sha256: null, modified_at: "2026-07-01T00:00:00Z", pinned_by: ["a-peer"] },
        // Never scanned here + claimed only by a peer ⇒ a remote-only row, which the walk appends AFTER
        // the local rows. It is the batch the reducer is most likely to drop, so the fixture forces one.
        { path: "videos/only-there.mp4", cid: "bafyremote", size: 99, sha256: null, modified_at: "2026-07-01T00:00:00Z", pinned_by: ["a-peer"] },
      ],
    }),
  );
  repoId = units.repoIdFromPath(repoRoot);

  const app = express();
  app.use(express.json());
  app.use("/api", (req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      authenticated: true,
      email: "stream@localhost",
      name: "spec",
      roles: ["admin"],
      permissions: [],
      allowListed: true,
      sessionId: "spec",
    };
    next();
  });
  app.use("/api/repos", reposRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}, 60_000);

afterAll(() => {
  server?.close();
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function getJson<T>(p: string): Promise<T> {
  const r = await fetch(base + p);
  const body = (await r.json()) as { ok: boolean; data: T; error?: string };
  if (!body.ok) throw new Error(`${p}: ${body.error}`);
  return body.data;
}

async function getNdjson<E>(p: string): Promise<E[]> {
  const res = await fetch(base + p);
  expect(res.ok).toBe(true);
  expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
  const text = await res.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as E);
}

/** Deep, key-ORDER-insensitive value comparison. JSON drops undefined-valued keys on the wire, so a row
 *  whose `pinnedHere` was not yet known comes back without the key and the `pins` patch re-adds it at the
 *  end — a different key order for identical data. Only the VALUES are the contract. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

describe("GET /api/repos/stream — the Repos table, progressively", () => {
  it("delivers meta → batch× → done and reproduces the buffered list exactly", async () => {
    const buffered = await getJson<RepoRow[]>("/repos");
    const events = await getNdjson<RepoRowsStreamEvent>("/repos/stream");
    expect(events[0]?.t).toBe("meta");
    expect(events[events.length - 1]?.t).toBe("done");
    const streamed = events.flatMap((e) => (e.t === "batch" ? e.rows : []));
    expect(normalize(streamed)).toEqual(normalize(buffered));
    expect(streamed.length).toBeGreaterThan(0);
  });

  it("is not captured by the /:repoId route", async () => {
    // `/stream` is a legal repo id as far as express is concerned; only registration order keeps this
    // route reachable at all. A 404 "repo not found" here would mean the ordering regressed.
    const res = await fetch(`${base}/repos/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
  });
});

describe("GET /api/repos/:repoId/detail/stream — the One-repo detail, progressively", () => {
  it("sends the header BEFORE any row", async () => {
    const events = await getNdjson<RepoDetailStreamEvent>(`/repos/${repoId}/detail/stream`);
    expect(events[0]?.t).toBe("head");
    const head = (events[0] as { detail: RepoDetail }).detail;
    // Real identity, no rows, explicitly marked provisional — everything the page needs to paint chrome.
    expect(head.name).toBe("stream-fixture");
    expect(head.path).toBe(repoRoot);
    expect(head.files).toEqual([]);
    expect(head.partial).toBe(true);
    expect(events[events.length - 1]?.t).toBe("done");
  });

  it("streams the rows in several batches rather than one blob", async () => {
    const events = await getNdjson<RepoDetailStreamEvent>(`/repos/${repoId}/detail/stream`);
    const batches = events.filter((e) => e.t === "files");
    expect(batches.length).toBeGreaterThan(1);
    expect(events.some((e) => e.t === "totals")).toBe(true);
    expect(events.some((e) => e.t === "pins")).toBe(true);
    expect(events.some((e) => e.t === "extras")).toBe(true);
  });

  it("ships rows with the git-ignore axis UNDETERMINED, then patches it in", async () => {
    // The point of the deferral, asserted on the WIRE rather than on the shared row objects: a row leaves
    // before `git check-ignore` has answered, so it must carry no verdict at all — and the verdict must
    // then actually arrive. An `enrich` that never came would leave every ⊘ toggle inert forever; a row
    // that shipped `gitignore: false` early would invite a click that writes a redundant .gitignore line.
    const events = await getNdjson<RepoDetailStreamEvent>(`/repos/${repoId}/detail/stream`);
    const shipped = events.flatMap((e) => (e.t === "files" ? e.files : []));
    const local = shipped.filter((f) => f.presence !== "remote-only");
    expect(local.length).toBe(ROWS);
    expect(local.every((f) => f.gitignore === undefined)).toBe(true);

    const enrich = events.find((e) => e.t === "enrich");
    expect(enrich).toBeDefined();
    const patch = (enrich as { rows: Record<string, { gitignore?: boolean }> }).rows;
    // The fixture's `.gitignore` is `*.mp4` and every candidate is one, so git ignores them all.
    expect(Object.keys(patch).length).toBe(ROWS);
    expect(Object.values(patch).every((p) => p.gitignore === true)).toBe(true);
  });

  it("folds back into exactly the buffered detail", async () => {
    const buffered = await getJson<RepoDetail>(`/repos/${repoId}`);
    const events = await getNdjson<RepoDetailStreamEvent>(`/repos/${repoId}/detail/stream`);

    // The SAME reduction the browser performs (frontend/src/api/streamQueries.ts streamRepoDetail).
    const first = events[0];
    expect(first?.t).toBe("head");
    let detail: RepoDetail = (first as { detail: RepoDetail }).detail;
    let files: FileRow[] = [];
    for (const ev of events.slice(1)) {
      if (ev.t === "files") {
        files = [...files, ...ev.files];
      } else if (ev.t === "enrich") {
        const rows = ev.rows;
        files = files.map((f) => (rows[f.path] ? { ...f, ...rows[f.path] } : f));
      } else if (ev.t === "totals") {
        detail = {
          ...detail,
          counts: ev.counts,
          peerCount: ev.peerCount,
          status: ev.status,
          taskMetrics: ev.taskMetrics ?? detail.taskMetrics,
        };
      } else if (ev.t === "pins") {
        const map = ev.pinnedHere;
        files = files.map((f) => (f.path in map ? { ...f, pinnedHere: map[f.path] } : f));
        detail = { ...detail, ipfs: ev.ipfs };
      } else if (ev.t === "extras") {
        detail = {
          ...detail,
          missingPinned: ev.missingPinned,
          deletedHere: ev.deletedHere,
          syncBlocked: ev.syncBlocked ?? undefined,
        };
      } else if (ev.t === "done") {
        const { partial: _partial, ...rest } = detail;
        detail = rest;
      }
    }
    const assembled = { ...detail, files };
    expect(assembled.partial).toBeUndefined();
    expect(assembled.files.length).toBe(ROWS + 1); // every scanned candidate + the peer's remote-only row
    expect(normalize(assembled)).toEqual(normalize(buffered));
  });

  it("404s an unknown repo as ordinary JSON, not as a 200 stream carrying an error line", async () => {
    // A bad id must reach the client's normal HTTP error path; wrapping it in a 200 would make every
    // caller parse a stream to discover the resource does not exist.
    const res = await fetch(`${base}/repos/deadbeefdeadbeef/detail/stream`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

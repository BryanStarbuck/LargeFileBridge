// The BYTE-LEVEL progress callbacks the dock's per-file detail is built on (webapp.mdx §11 — "bytes added
// 412 / 734 MB"). Daemon-free: global fetch is stubbed, exactly as pin-liveness.spec.ts does.
//
// What these lock:
//   • `addFile` streams Kubo's `progress=true` {"Bytes":N} ticks to onBytes AND still returns the CID from
//     the record that carries a Hash — not from the last LINE, which with progress on is a byte tick;
//   • `pinAdd` forwards its {"Progress":N} node count to onNodes (the ONLY live signal a fetch emits);
//   • `catToFile` reports the running total actually written to disk;
//   • `approxFetchedBytes` never claims more bytes than the file holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { addFile, pinAdd, catToFile, approxFetchedBytes, DAG_CHUNK_BYTES } = await import("./ipfs.service.js");

const CID = "bafybeig2h7dvxz6eq7af2p4ope57dqh4j5ulfvninyyou5xkx46s4hyqsi";

function ndjsonResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line + "\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function bytesResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;
let tmpDir: string;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-progress-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("addFile — byte progress while a big file uploads", () => {
  it("streams every {Bytes:N} tick and still returns the CID from the Hash record", async () => {
    const src = path.join(tmpDir, "clip.mp4");
    fs.writeFileSync(src, "hello");
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse([
        '{"Name":"clip.mp4","Bytes":1024}',
        '{"Name":"clip.mp4","Bytes":4096}',
        `{"Name":"clip.mp4","Hash":"${CID}","Size":"5"}`,
        // A trailing byte tick after the Hash record: taking the LAST LINE (the old code) would lose the CID.
        '{"Name":"clip.mp4","Bytes":5000}',
      ]),
    );
    const seen: number[] = [];
    const cid = await addFile(src, { onBytes: (b) => seen.push(b) });
    expect(cid).toBe(CID);
    expect(seen).toEqual([1024, 4096, 5000]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("progress=true");
  });

  it("does not ask Kubo for a progress stream when no one is listening", async () => {
    const src = path.join(tmpDir, "quiet.bin");
    fs.writeFileSync(src, "x");
    fetchMock.mockResolvedValueOnce(ndjsonResponse([`{"Name":"quiet.bin","Hash":"${CID}","Size":"1"}`]));
    await expect(addFile(src)).resolves.toBe(CID);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("progress=true");
  });
});

describe("pinAdd — node progress while a fetch runs", () => {
  it("forwards each INCREASED node count to onNodes", async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse([
        '{"Progress":0}', // discovery — not progress, and must not be reported as such
        '{"Progress":12}',
        '{"Progress":12}', // an unchanged heartbeat is not new evidence
        '{"Progress":40}',
        `{"Pins":["${CID}"]}`,
      ]),
    );
    const seen: number[] = [];
    await pinAdd(CID, { onNodes: (n) => seen.push(n) });
    expect(seen).toEqual([12, 40]);
  });
});

describe("catToFile — bytes written to disk", () => {
  it("reports the RUNNING TOTAL, not the per-chunk size", async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(["aaaa", "bb", "cccccc"]));
    const dest = path.join(tmpDir, "out", "clip.mp4");
    const seen: number[] = [];
    await catToFile(CID, dest, { resolved: true, onBytes: (b) => seen.push(b) });
    expect(seen).toEqual([4, 6, 12]);
    expect(fs.readFileSync(dest, "utf8")).toBe("aaaabbcccccc");
  });
});

describe("approxFetchedBytes — an estimate that never overstates", () => {
  it("scales node count by the default chunk size", () => {
    expect(approxFetchedBytes(4)).toBe(4 * DAG_CHUNK_BYTES);
  });

  it("clamps to the size the manifest already knows", () => {
    // Interior DAG nodes make the raw estimate overshoot near the end; a card must never claim to have
    // fetched more of a file than the file contains.
    expect(approxFetchedBytes(10_000, 1_000)).toBe(1_000);
  });

  it("returns the raw estimate when the size is unknown", () => {
    expect(approxFetchedBytes(2, 0)).toBe(2 * DAG_CHUNK_BYTES);
  });
});

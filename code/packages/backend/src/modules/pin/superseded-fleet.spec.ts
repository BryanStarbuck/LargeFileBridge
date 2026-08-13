// A PROOF ONLY ONE COMPUTER CAN MAKE HAS TO REACH THE OTHERS.
//
// Establishing that a recorded CID is a wrapper directory needs the wrapper's blocks. The computer holding
// them can walk it; the others cannot, and no amount of re-running the pass on them will change that. So
// `superseded_cids.yaml` — machine-local by design, because it is derived — left the fleet in a state where
// the disproof existed on exactly one machine while every other one kept publishing the CID it disproved,
// and the merge tie-break (a total order on the CID value, blind to what it is ordering) kept choosing the
// wrapper. That is not a disagreement anybody wins: it is two computers with different evidence.
//
// The device file is the right carrier. It is SELF-OWNED — one computer writes it, the rest only read — so
// it cannot conflict, and it already travels with the SDL. What it must not do is churn: it is committed
// and pushed, and a field that rewrites itself every pass is the flood the quiet gate exists to stop.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const SELF = "pc-4";
const WRAPPER = "bafybeiazdwqqs7cv6mxr5vkqzb772355nhadpsyent32bfdn6c3vuq7ofa";
const FILE_CID = "bafybeigm2judyoxm3yzrfz5x7v6zmsxbhajxdnn7zcmalywiwqhvwykp5y";
const OTHER_WRAPPER = "bafybeicois6dp3tdvdqoo564zyakcue24ckmadwpfwbql63vj7ccjufz7m";
const OTHER_FILE = "bafybeifakl36logu7r7rpyl7xxhcktczdnei65diwbg7zi6o27aoyh5ei4";

let tmp: string;
let storageRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-superseded-fleet-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  storageRoot = path.join(tmp, "sdl");
  fs.mkdirSync(storageRoot, { recursive: true });
  const cfg = await import("../store-model/config.service.js");
  await cfg.updateAppConfig((c) => ((c.computer.label = SELF), c));
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A peer's own device file, as it arrives over the git backbone. */
async function seedPeerDevice(name: string, pairs: Record<string, string>): Promise<void> {
  const { devicesDir } = await import("../storage/devices.service.js");
  fs.mkdirSync(devicesDir(storageRoot), { recursive: true });
  fs.writeFileSync(
    path.join(devicesDir(storageRoot), `${name}.yaml`),
    YAML.stringify({ schema_version: 1, device: { id: name, name }, superseded_cids: pairs }),
    "utf8",
  );
}

describe("adoptSupersededCids — taking on what another computer proved", () => {
  it("takes a pair this computer could never have established itself", async () => {
    const { adoptSupersededCids, supersededCid } = await import("./superseded-cids.service.js");

    expect(adoptSupersededCids({ [WRAPPER]: FILE_CID })).toBe(1);

    expect(supersededCid(WRAPPER)).toBe(FILE_CID);
  });

  it("never overrules our OWN walk — first-hand evidence outranks a peer's report", async () => {
    const { noteSupersededCid, adoptSupersededCids, supersededCid } = await import("./superseded-cids.service.js");
    noteSupersededCid(WRAPPER, FILE_CID);

    expect(adoptSupersededCids({ [WRAPPER]: "bafybeisomethingelse0000000000000000000000000000000000000000" })).toBe(0);

    expect(supersededCid(WRAPPER)).toBe(FILE_CID);
  });

  it("skips junk rather than failing — a peer file we cannot read is a claim, not a fault", async () => {
    const { adoptSupersededCids, supersededCid } = await import("./superseded-cids.service.js");

    expect(
      adoptSupersededCids({ "": FILE_CID, [WRAPPER]: "", "not-a-cid": "also-not-a-cid", [OTHER_WRAPPER]: OTHER_FILE }),
    ).toBe(1);

    expect(supersededCid(OTHER_WRAPPER)).toBe(OTHER_FILE);
    expect(supersededCid(WRAPPER)).toBeNull();
  });

  it("is idempotent, so a pass that re-reads the same peer file writes nothing new", async () => {
    const { adoptSupersededCids } = await import("./superseded-cids.service.js");
    adoptSupersededCids({ [WRAPPER]: FILE_CID });

    expect(adoptSupersededCids({ [WRAPPER]: FILE_CID })).toBe(0);
  });
});

describe("the device registry as the carrier", () => {
  it("reads every PEER's corrections and ignores our own file", async () => {
    // Our own is skipped deliberately: re-adopting what we published could resurrect a pair we have since
    // dropped (the equivalence audit's whole job is to drop wrong ones).
    const { writeSelfDevice, readPeerSupersededCids } = await import("../storage/devices.service.js");
    writeSelfDevice(storageRoot, { supersededCids: { [OTHER_WRAPPER]: OTHER_FILE } });
    await seedPeerDevice("pc-10", { [WRAPPER]: FILE_CID });

    const pairs = readPeerSupersededCids(storageRoot);

    expect(pairs).toEqual({ [WRAPPER]: FILE_CID });
  });

  it("publishes what this computer proved, so a peer can adopt it", async () => {
    const { noteSupersededCid, supersededPairs } = await import("./superseded-cids.service.js");
    noteSupersededCid(WRAPPER, FILE_CID);
    const { writeSelfDevice, devicesDir } = await import("../storage/devices.service.js");

    writeSelfDevice(storageRoot, { supersededCids: supersededPairs() });

    const doc = YAML.parse(fs.readFileSync(path.join(devicesDir(storageRoot), `${SELF}.yaml`), "utf8"));
    expect(doc.superseded_cids[WRAPPER]).toBe(FILE_CID);
  });

  it("leaves published corrections alone when a caller has nothing to say about CIDs", async () => {
    // Most `writeSelfDevice` callers are about identity or the graft. Silence must not retract a proof.
    const { writeSelfDevice, devicesDir } = await import("../storage/devices.service.js");
    writeSelfDevice(storageRoot, { supersededCids: { [WRAPPER]: FILE_CID } });

    writeSelfDevice(storageRoot);

    const doc = YAML.parse(fs.readFileSync(path.join(devicesDir(storageRoot), `${SELF}.yaml`), "utf8"));
    expect(doc.superseded_cids[WRAPPER]).toBe(FILE_CID);
  });

  it("does not rewrite the file when the corrections have not changed — this text is committed and pushed", async () => {
    const { writeSelfDevice, devicesDir } = await import("../storage/devices.service.js");
    const file = path.join(devicesDir(storageRoot), `${SELF}.yaml`);
    writeSelfDevice(storageRoot, { supersededCids: { [WRAPPER]: FILE_CID } });
    const before = fs.readFileSync(file, "utf8");

    writeSelfDevice(storageRoot, { supersededCids: { [WRAPPER]: FILE_CID } });

    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

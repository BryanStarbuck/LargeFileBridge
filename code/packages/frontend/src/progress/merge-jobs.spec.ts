// The dock's merge rules (webapp.mdx §12). The one that matters most here: a click on an instrumented
// endpoint must show ONE card that gains detail, never two cards for one job.
import { describe, it, expect } from "vitest";
import type { ProgressJob } from "@lfb/shared";
import { mergeJobs } from "./merge-jobs.js";

const job = (p: Partial<ProgressJob> & { id: string }): ProgressJob => ({
  kind: "pin",
  target: "ACT3",
  startedAt: "2026-08-06T00:00:00.000Z",
  ...p,
});

describe("mergeJobs", () => {
  it("hides the blind optimistic card once the server's job for the same work appears", () => {
    const optimistic = [job({ id: "opt-1" })];
    const server = [job({ id: "srv-1", done: 3, total: 12, unit: "files", note: "fetching clip.mp4" })];
    const merged = mergeJobs(optimistic, server);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("srv-1");
    expect(merged[0]!.note).toBe("fetching clip.mp4");
  });

  it("keeps the optimistic card while the server has not registered the job yet", () => {
    const merged = mergeJobs([job({ id: "opt-1" })], []);
    expect(merged.map((j) => j.id)).toEqual(["opt-1"]);
  });

  it("only supersedes on the SAME kind and target", () => {
    const merged = mergeJobs(
      [job({ id: "opt-1", target: "ACT3" })],
      [job({ id: "srv-1", target: "OpenAuthFederated" }), job({ id: "srv-2", kind: "scan", target: "ACT3" })],
    );
    expect(merged.map((j) => j.id).sort()).toEqual(["opt-1", "srv-1", "srv-2"]);
  });

  it("puts this tab's own work first — the dock's card cap must not bury the card the user is waiting for", () => {
    const merged = mergeJobs(
      [job({ id: "opt-1", target: "mine" })],
      [job({ id: "srv-1", target: "a" }), job({ id: "srv-2", target: "b" })],
    );
    expect(merged[0]!.id).toBe("opt-1");
  });

  it("never doubles a job that appears in both lists under the same id", () => {
    const merged = mergeJobs([job({ id: "same" })], [job({ id: "same", done: 1, total: 2 })]);
    expect(merged).toHaveLength(1);
  });
});

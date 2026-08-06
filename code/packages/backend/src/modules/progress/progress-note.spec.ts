// The registry's TWO progress axes (webapp.mdx §12a): the determinate fraction and the phase line, which
// move independently. A job that only knows what step it is on must be able to say so without inventing a
// fraction, and a job whose step ends must be able to CLEAR the line rather than leave a stale phrase up.
import { describe, it, expect, vi } from "vitest";

vi.mock("../events/state-events.service.js", () => ({
  bumpTopic: () => {},
  bumpTopicThrottled: () => {},
  PROGRESS_TOPIC: "progress",
}));

const { begin, report, end, list } = await import("./progress.registry.js");

const jobById = (id: string) => list().find((j) => j.id === id);

describe("progress registry — the note axis", () => {
  it("carries a phase line with no counts at all (an indeterminate job that can still explain itself)", () => {
    const id = begin("pin", "ACT3");
    report(id, { note: "reading this computer's pin list" });
    const j = jobById(id)!;
    expect(j.note).toBe("reading this computer's pin list");
    expect(j.done).toBeUndefined();
    expect(j.total).toBeUndefined();
    end(id);
  });

  it("updates the two axes independently", () => {
    const id = begin("pin", "ACT3");
    report(id, { done: 2, total: 10, unit: "files" });
    report(id, { note: "fetching clip.mp4" });
    expect(jobById(id)).toMatchObject({ done: 2, total: 10, unit: "files", note: "fetching clip.mp4" });
    report(id, { done: 3 }); // a bare count tick must not wipe the line
    expect(jobById(id)).toMatchObject({ done: 3, note: "fetching clip.mp4" });
    end(id);
  });

  it("CLEARS the line on an empty note rather than leaving a stale step up", () => {
    const id = begin("pin", "ACT3");
    report(id, { note: "merging the file lists" });
    report(id, { note: "" });
    expect(jobById(id)!.note).toBeUndefined();
    end(id);
  });

  it("ignores a report for a job that already ended", () => {
    const id = begin("pin", "ACT3");
    end(id);
    expect(() => report(id, { note: "late tick" })).not.toThrow();
    expect(jobById(id)).toBeUndefined();
  });
});

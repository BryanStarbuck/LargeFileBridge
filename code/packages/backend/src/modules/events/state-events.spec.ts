// The state-revision bus (storage_company.mdx §8.9) — the thing that lets an open page LEARN that a
// backbone pull just produced new remote-only rows, instead of sitting silently stale until a reload.
//
// What these tests protect is mostly the FAILURE behaviour: this bus is called from inside write paths
// (`writeRepoManifest`, the reconcile fold, the scanner's status write) whose real job is to persist data.
// A notification that can throw is a notification that can lose a write, which would be a far worse bug
// than the staleness it exists to fix.
import { describe, it, expect, beforeEach } from "vitest";
import {
  bumpTopic,
  bumpTopics,
  subscribe,
  currentRevisions,
  subscriberCount,
  repoTopic,
  REPOS_TOPIC,
} from "./state-events.service.js";

describe("state-events bus", () => {
  beforeEach(() => {
    // Drain any subscriber a previous test leaked, so counts below are meaningful.
    expect(subscriberCount()).toBe(0);
  });

  it("delivers a bump to every subscriber with a monotonically increasing revision", () => {
    const seen: Array<{ topic: string; revision: number }> = [];
    const off = subscribe((b) => seen.push({ ...b }));

    const topic = repoTopic("charlie-kirk");
    const first = bumpTopic(topic);
    const second = bumpTopic(topic);

    expect(second).toBe(first + 1);
    expect(seen).toEqual([
      { topic, revision: first },
      { topic, revision: second },
    ]);
    off();
  });

  it("unsubscribe actually detaches — a stream handler that forgets would grow the set forever", () => {
    const seen: string[] = [];
    const off = subscribe((b) => seen.push(b.topic));
    expect(subscriberCount()).toBe(1);
    off();
    expect(subscriberCount()).toBe(0);
    bumpTopic("repos");
    expect(seen).toEqual([]);
  });

  it("a throwing subscriber is dropped and NEVER fails the write that bumped", () => {
    const good: string[] = [];
    const offBad = subscribe(() => {
      throw new Error("this stream's socket is half-closed");
    });
    const offGood = subscribe((b) => good.push(b.topic));
    expect(subscriberCount()).toBe(2);

    // The bump must not throw — a persisted manifest must not be undone by a broken browser tab.
    expect(() => bumpTopic("repos")).not.toThrow();
    // The healthy subscriber still got it: one bad client must not poison the bus for every other page.
    expect(good).toEqual(["repos"]);
    // …and the bad one is gone rather than retried forever.
    expect(subscriberCount()).toBe(1);

    offBad();
    offGood();
  });

  it("bumpTopics de-duplicates so one write is one notification per topic", () => {
    const seen: string[] = [];
    const off = subscribe((b) => seen.push(b.topic));
    const t = repoTopic("dupe-repo");
    bumpTopics([t, REPOS_TOPIC, t]);
    expect(seen).toEqual([t, REPOS_TOPIC]);
    off();
  });

  it("currentRevisions reports the latest revision per topic for the stream's hello", () => {
    const t = repoTopic("hello-repo");
    const rev = bumpTopic(t);
    expect(currentRevisions()[t]).toBe(rev);
  });
});

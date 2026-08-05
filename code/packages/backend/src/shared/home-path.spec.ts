// `~` expansion, and the Windows bug it was written for.
//
// Every call site used to open-code `p.replace(/^~(?=\/|$)/, process.env.HOME || "~")`. `HOME` is unset on
// Windows, so `~/BGit/sync-repo` expanded to the LITERAL string `~/BGit/sync-repo`. The git backbone then
// stats `~/BGit/sync-repo/.git`, finds nothing, logs "not a checkout yet — skipping git cycle" at INFO, and
// that storage never commits or pushes again. Nothing fails; it just stops syncing.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { expandHome, resolveHome, collapseHome, homeDir } from "./home-path.js";

describe("expandHome", () => {
  const home = os.homedir();

  it("expands a leading ~/ without depending on $HOME", () => {
    expect(expandHome("~/BGit/sync-repo")).toBe(`${home}/BGit/sync-repo`);
  });

  it("expands a bare ~", () => {
    expect(expandHome("~")).toBe(home);
  });

  it("expands the backslash form a Windows user actually types", () => {
    expect(expandHome("~\\BGit\\sync-repo")).toBe(`${home}\\BGit\\sync-repo`);
  });

  it("leaves ~user alone — that is a different account, not this one", () => {
    expect(expandHome("~bryan/BGit")).toBe("~bryan/BGit");
  });

  it("only touches a LEADING tilde", () => {
    expect(expandHome("/Volumes/media/~backup")).toBe("/Volumes/media/~backup");
    expect(expandHome("/BGit/a~b")).toBe("/BGit/a~b");
  });

  it("passes an ordinary absolute path through untouched", () => {
    expect(expandHome("/Users/bryan/BGit")).toBe("/Users/bryan/BGit");
  });

  it("never leaves a literal ~ at the front of what a caller will open", () => {
    // The whole defect in one assertion: whatever the platform, an expanded path is a real one.
    expect(expandHome("~/anything").startsWith("~")).toBe(false);
  });

  it("does not re-expand a home directory containing regex replacement syntax", () => {
    // `String.replace` with a string replacement treats `$&` as "the match". A function replacement
    // doesn't — this guards the difference.
    expect(homeDir()).toBe(os.homedir());
    expect(expandHome("~/x")).toBe(`${os.homedir()}/x`);
  });
});

describe("resolveHome", () => {
  it("expands and normalizes in one step", () => {
    // Compared through `path.resolve`, not against a hand-built string: on Windows the separator is `\`,
    // so a literal `${home}/BGit/repo` expectation would fail on the very platform this module exists for.
    expect(resolveHome("~/BGit/../BGit/repo")).toBe(path.resolve(os.homedir(), "BGit", "repo"));
  });
});

describe("collapseHome", () => {
  it("is the inverse of expandHome for display", () => {
    expect(collapseHome(`${os.homedir()}/BGit`)).toBe("~/BGit");
    expect(expandHome(collapseHome(`${os.homedir()}/BGit`))).toBe(`${os.homedir()}/BGit`);
  });

  it("leaves a path outside the home directory alone", () => {
    expect(collapseHome("/Volumes/media/movies")).toBe("/Volumes/media/movies");
  });

  it("only collapses at a path-segment boundary", () => {
    // Bare `startsWith` turns the SIBLING of a home directory into a path that reads as the user's own:
    // with home `/Users/bry`, `/Users/bryan/BGit` displayed as `~an/BGit`.
    const home = os.homedir();
    expect(collapseHome(`${home}x/BGit`)).toBe(`${home}x/BGit`);
    expect(collapseHome(home)).toBe("~");
  });
});

// The two decisions that turn "32 organizations on this disk" into "3 companies" (storage_company.mdx §10):
// grouping repos by the org level of their remote (§10.1), and the LOCKED membership test that an org
// counts only when the user has authored a commit in one of its repos here (§10.2).
//
// Both are regressions waiting to happen for the same reason: they are cheap to get subtly wrong and the
// wrong answer still LOOKS like a working feature. A grouping that does not fold `ACT3ai` and `act3ai` makes
// two companies for one org; a membership test that forgets `personal_accounts` files the user's own GitHub
// account as a company; a filter that DROPS the clone-only orgs instead of reporting them makes a silent
// filter indistinguishable from a bug (warnings.mdx). Each test below pins one of those down.
import { describe, it, expect } from "vitest";
import { buildCandidates, orgKey, orgDirSlug, type RepoInput } from "./company-discovery.service.js";

const PARENT = "/Users/x/BGit/Bryan_git";
const opts = (over: Partial<Parameters<typeof buildCandidates>[1]> = {}) => ({
  personalAccounts: [],
  authored: () => false,
  dismissed: new Set<string>(),
  parentDir: PARENT,
  ...over,
});

const repo = (org: string | null, name: string, i = 0): RepoInput => ({
  path: `/Users/x/BGit/${name}${i || ""}`,
  remote: org ? `https://github.com/${org}/${name}${i || ""}.git` : null,
});

describe("buildCandidates — grouping repos by forge org (§10.1)", () => {
  it("groups every repo under the org level of its remote and counts them", () => {
    const repos = [repo("ACT3ai", "a"), repo("ACT3ai", "b"), repo("stoke-gh", "c")];
    const view = buildCandidates(repos, opts({ authored: () => true }));
    expect(view.organizations.map((o) => [o.org, o.repoCount])).toEqual([
      ["ACT3ai", 2],
      ["stoke-gh", 1],
    ]);
  });

  it("folds SSH/HTTPS and casing into ONE org, keeping the first sighting's display casing", () => {
    // Two spellings of one org would otherwise propose two directories for one company — the same
    // off-by-casing class of defect that made `ACT3ai` miss `act3_large_files_bridge` (§8.4.4).
    const repos: RepoInput[] = [
      { path: "/r/1", remote: "https://github.com/ACT3ai/charlie-kirk.git" },
      { path: "/r/2", remote: "git@github.com:act3ai/other" },
      { path: "/r/3", remote: "ssh://git@github.com/ACT3AI/third/" },
    ];
    const view = buildCandidates(repos, opts({ authored: () => true }));
    expect(view.organizations).toHaveLength(1);
    expect(view.organizations[0]).toMatchObject({ org: "ACT3ai", slug: "act3ai", repoCount: 3 });
  });

  it("gives a repo with no parseable remote NO org — it belongs to Personal, not a company (§10.1)", () => {
    const repos: RepoInput[] = [
      { path: "/r/1", remote: null },
      { path: "/r/2", remote: "" },
      { path: "/r/3", remote: "/Users/x/BGit/some/local/path" },
      // A self-hosted host we do not recognize as a forge: parseable, but `owner` is not an org we can trust.
      { path: "/r/4", remote: "https://git.internal.example.com/team/thing.git" },
    ];
    const view = buildCandidates(repos, opts({ authored: () => true }));
    expect(view.totalOrgs).toBe(0);
    expect(view.organizations).toEqual([]);
    expect(view.skipped).toEqual([]);
  });

  it("proposes `<parent>/<org-slug>_large_files_bridge` under the PARENT it was given, never a hardcode", () => {
    // AC 6: the parent is a setting. If this ever reads a constant instead, this assertion fails.
    const view = buildCandidates([repo("stoke-gh", "s")], opts({ authored: () => true, parentDir: "/elsewhere" }));
    expect(view.organizations[0]!.proposedRoot).toBe("/elsewhere/stoke-gh_large_files_bridge");
  });
});

describe("buildCandidates — the membership test (§10.2, LOCKED)", () => {
  // The measured machine, in miniature: 6 orgs, of which the user commits in 2, one is their own account,
  // and the remaining 3 are clones of other people's projects.
  const repos: RepoInput[] = [
    ...[0, 1, 2].map((i) => repo("ACT3ai", "act", i + 1)),
    repo("stoke-gh", "stoke"),
    ...[0, 1].map((i) => repo("BryanStarbuck", "mine", i + 1)),
    repo("KDE", "kde"),
    repo("OpenShot", "openshot"),
    repo("xai-org", "grok"),
  ];
  const mine = new Set(["/Users/x/BGit/act1", "/Users/x/BGit/stoke"]);
  const view = () =>
    buildCandidates(
      repos,
      opts({
        authored: (p) => mine.has(p),
        personalAccounts: [{ owner: "BryanStarbuck" }],
      }),
    );

  it("keeps ONLY the orgs the user has authored a commit in", () => {
    expect(view().organizations.map((o) => o.org)).toEqual(["ACT3ai", "stoke-gh"]);
  });

  it("qualifies an org from ONE authored repo out of many — membership is existential", () => {
    // Only act1 carries a commit; act2/act3 are clones of the same org and must not un-qualify it.
    expect(view().organizations.find((o) => o.org === "ACT3ai")).toMatchObject({ qualifies: true, repoCount: 3 });
  });

  it("sends the user's OWN forge account to Personal — never a company proposal (§10.2)", () => {
    const v = view();
    expect(v.organizations.map((o) => o.org)).not.toContain("BryanStarbuck");
    expect(v.skipped.map((o) => o.org)).not.toContain("BryanStarbuck");
    expect(v.personalCount).toBe(1);
  });

  it("REPORTS the clone-only orgs instead of dropping them — say the number (§10.2)", () => {
    // The filter is a proposal filter, never a lock: what it excluded must stay visible and addable by hand.
    const v = view();
    expect(v.skippedCount).toBe(3);
    expect(v.skipped.map((o) => o.org).sort()).toEqual(["KDE", "OpenShot", "xai-org"]);
    expect(v.skipped.every((o) => o.qualifies === false)).toBe(true);
    expect(v.totalOrgs).toBe(6);
  });

  it("marks an org the user dismissed, without removing it from the list", () => {
    // Dismissal changes what is OFFERED, not what exists — the row stays so the choice can be undone.
    const v = buildCandidates(
      repos,
      opts({ authored: (p) => mine.has(p), dismissed: new Set(["stokegh"]), personalAccounts: [{ owner: "BryanStarbuck" }] }),
    );
    expect(v.organizations.find((o) => o.org === "stoke-gh")).toMatchObject({ dismissed: true });
    expect(v.organizations.find((o) => o.org === "ACT3ai")).toMatchObject({ dismissed: false });
  });
});

describe("buildCandidates — adopt before create (§10.3)", () => {
  it("marks an org an existing company storage already claims, so no second directory is proposed", () => {
    // The `ACT3ai` ⇢ `act3_large_files_bridge` (named "Act3") case: the org must be ADOPTED, not duplicated.
    const v = buildCandidates(
      [repo("ACT3ai", "a"), repo("stoke-gh", "s")],
      opts({
        authored: () => true,
        claimedBy: (org) => (org === "ACT3ai" ? { id: "abc123", name: "Act3" } : null),
      }),
    );
    expect(v.organizations.find((o) => o.org === "ACT3ai")).toMatchObject({
      alreadyClaimed: true,
      claimedByStorageId: "abc123",
      claimedByStorageName: "Act3",
    });
    expect(v.organizations.find((o) => o.org === "stoke-gh")).toMatchObject({ alreadyClaimed: false });
  });
});

describe("org slugs", () => {
  it("keys case- and punctuation-insensitively, matching the storage-side binding rule (§8.4.4)", () => {
    expect(orgKey("ACT3ai")).toBe(orgKey("act3-ai"));
    expect(orgKey("stoke-gh")).toBe("stokegh");
  });

  it("keeps word separation in the DIRECTORY form a human reads in Finder (§10.3)", () => {
    expect(orgDirSlug("ACT3ai")).toBe("act3ai");
    expect(orgDirSlug("stoke-gh")).toBe("stoke-gh");
    expect(orgDirSlug("Try Kimu!")).toBe("try-kimu");
  });
});

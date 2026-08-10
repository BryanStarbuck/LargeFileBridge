// ONE COMPANY, ONE STORAGE — the dedupe that stops a bare `<name>_large_files_bridge` directory from
// shadowing the real, remoted clone of the same company.
//
// This is a regression test for the highest-cost silent fault the app has produced. On 2026-08-10, BOTH of
// Bryan's computers had two rows for company "Act3": `~/BGit/Bryan_git/act3_large_files_bridge` (adopted on
// its NAME alone — no `storage.yaml`, no git remote) and `~/BGit/act3/act3_large_files_bridge` (descriptor,
// origin, content). The bare one held `pinned: true`, so every device registration, manifest and decision
// was committed into a repo that cannot push. Neither computer published anything; each concluded the other
// had been offline since the day the shadow appeared; every pull-down failed with "no computer is currently
// providing this file" and the counts never drained. Nothing surfaced it but a WARN line in `error.err`.
import { describe, it, expect, vi } from "vitest";
import type { StorageRow } from "@lfb/shared";
import { resolveCompanyConflicts } from "./storage.service.js";

const row = (over: Partial<StorageRow> & { root: string }): StorageRow => ({
  id: over.root,
  name: "Act3",
  type: "company",
  companyName: "Act3",
  communityId: null,
  initialized: false,
  hasLfbridge: true,
  fileCount: 0,
  indexDroppedFiles: 0,
  clones: { googleDrive: null, dropbox: null },
  route: "/storages/x",
  ...over,
});

const REAL = "/Users/x/BGit/act3/act3_large_files_bridge";
const SHADOW = "/Users/x/BGit/Bryan_git/act3_large_files_bridge";
const withOrigin = (roots: string[]) => ({ hasOrigin: (r: string) => roots.includes(r) });

describe("resolveCompanyConflicts — one company, one storage", () => {
  it("drops the bare, remote-less directory and keeps the initialized clone that has an origin", () => {
    const rows = [
      row({ root: SHADOW }),
      row({ root: REAL, initialized: true, fileCount: 2185 }),
    ];
    const kept = resolveCompanyConflicts(rows, { ...withOrigin([REAL]), onShadow: () => {} });
    expect(kept.map((r) => r.root)).toEqual([REAL]);
  });

  it("carries the shadowed storage's pinning opt-in onto the winner — dedupe must never silently stop sharing", () => {
    const onShadow = vi.fn();
    const shadow = row({ root: SHADOW });
    const real = row({ root: REAL, initialized: true });
    resolveCompanyConflicts([shadow, real], { ...withOrigin([REAL]), onShadow });
    expect(onShadow).toHaveBeenCalledWith(shadow, real);
  });

  it("prefers a remote over no remote even when neither carries a descriptor — a storage that cannot push is never the winner", () => {
    const kept = resolveCompanyConflicts([row({ root: SHADOW }), row({ root: REAL })], {
      ...withOrigin([REAL]),
      onShadow: () => {},
    });
    expect(kept.map((r) => r.root)).toEqual([REAL]);
  });

  it("folds casing/punctuation differences in the company name — `ACT3 ai` and `act3ai` are one company", () => {
    const kept = resolveCompanyConflicts(
      [row({ root: SHADOW, name: "ACT3 ai", companyName: "ACT3 ai" }), row({ root: REAL, companyName: "act3ai", initialized: true })],
      { ...withOrigin([REAL]), onShadow: () => {} },
    );
    expect(kept).toHaveLength(1);
  });

  it("leaves genuinely different companies alone, and never touches non-company rows", () => {
    const rows = [
      row({ root: "/a", name: "Act3", companyName: "Act3", initialized: true }),
      row({ root: "/b", name: "Stoke", companyName: "Stoke", initialized: true }),
      row({ root: "/p", type: "personal", name: "Personal", companyName: null }),
    ];
    expect(resolveCompanyConflicts(rows, { ...withOrigin([]), onShadow: () => {} })).toHaveLength(3);
  });
});

// THE TWO TRANSFORMS THAT ARE EASY TO GET BACKWARDS (database_migration.mdx §4.4).
//
// Both are pure functions here on purpose: each one is a single expression whose WRONG version is silent,
// produces no error, and is only discovered later as "the fleet stopped syncing" or "this computer's pins
// are attributed to a machine that does not exist".
import { describe, it, expect } from "vitest";
import { mirrorOptoutFor, canonicalDeviceLabel, indexDeviceRegistry } from "./unit-backfill.js";

describe("the tri-state opt-out — getting this backwards opts EVERY repo out", () => {
  it("maps absent -> NULL, false -> true, true -> false", () => {
    // ABSENT is the case that matters. `sync_repo.enabled` is optional, not defaulted (schemas.ts:541),
    // because the mirror is ON by default and the toggle is an OPT-OUT. All 105 repo configs on this machine
    // carry `sync_repo: {}` — every one of them predates the feature — so a mapping that read absent as
    // "opted out" would stop the entire fleet mirroring and nothing would say why.
    expect(mirrorOptoutFor(undefined)).toBeNull();
    expect(mirrorOptoutFor(false)).toBe(true);
    expect(mirrorOptoutFor(true)).toBe(false);
  });
});

describe("device spellings — one computer must not become two rows", () => {
  // `history/<device>.txt` filenames are repoFolderKey-SANITIZED; `pinned_by` labels are not. The SDL device
  // registry is what tells us the two are one computer, and it has to be consulted BEFORE ids are assigned:
  // once two rows exist, `is_self` is on at most one of them and `pinned_here` is wrong for the other forever.
  const reg = indexDeviceRegistry([
    { fileStem: "bryan-mac-pro", name: "bryan-mac-pro", peerId: "12D3KooWaaa" },
    { fileStem: "nayan-neo", name: "nayan-neo", peerId: "12D3KooWbbb" },
    // A computer whose declared name is NOT its filename spelling — the case the sanitizer creates.
    { fileStem: "xmod2-sjoshi", name: "xmod2 sjoshi", peerId: "12D3KooWccc" },
  ]);

  it("resolves a history FILENAME to the registry's declared name", () => {
    expect(canonicalDeviceLabel("nayan-neo", reg)).toEqual({ label: "nayan-neo", peerId: "12D3KooWbbb" });
  });

  it("collapses the sanitized filename and the unsanitized label onto ONE canonical name", () => {
    // Both spellings of the same computer must land on the same label, or it gets two device rows.
    expect(canonicalDeviceLabel("xmod2 sjoshi", reg).label).toBe("xmod2 sjoshi");
    expect(canonicalDeviceLabel("xmod2-sjoshi", reg).label).toBe("xmod2 sjoshi");
  });

  it("keeps a label the registry has never heard of, rather than inventing a match", () => {
    // `nayan-desktop-tqau7t7` is a real `pinned_by` label on this machine with no device file. Guessing that
    // it is `nayan-neo` because the prefixes rhyme would merge two computers on a hunch; the registry is the
    // authority on what is one computer, and where it is silent so are we.
    expect(canonicalDeviceLabel("nayan-desktop-tqau7t7", reg)).toEqual({
      label: "nayan-desktop-tqau7t7",
      peerId: null,
    });
  });
});

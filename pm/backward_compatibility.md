# Backward Compatibility — living with older Large File Bridge builds

**Status:** implemented in build 7 (2026-09-27). **Owner doc for:** how shared data is versioned, how a newer
build merges and writes it, and how it refuses to be dragged into a fight by an older build.

Related: [performance.mdx](performance.mdx) (P-51…P-59: the incidents this came from) ·
[git_backbone.mdx](git_backbone.mdx) · [decisions.mdx](decisions.mdx) · [deletion.mdx](deletion.mdx) ·
[repo__list_syns.mdx](repo__list_syns.mdx) · [devices.mdx](devices.mdx)

---

## 0. Summary (read this first)

* **The problem.** Every computer in a user's fleet reads and writes the same shared documents (the decision
  ledger, the deletion ledger, the manifest, per-file sidecars) through a git "sync repo". Some of those
  computers run an **older build** — often for days, sometimes a teammate's machine nobody can update right
  now. An older build **cannot be fixed from here**: its code is its code. Twice in two months an older
  build's harmless-looking habit (re-stamping a record, writing records in a different order, keeping a
  duplicate) turned into a **tug-of-war**: each build rewrote the other's bytes on every pass, which meant a
  git commit every few minutes, a multi-megabyte re-merge on every computer on every pass, and the web page
  hanging for seconds at a time.
* **The rule.** *A newer build must be a tolerant reader and a conservative writer.* It accepts anything an
  older build writes, and it never writes a shared document unless the **meaning** changed.
* **The five mechanisms** (each one is independent; together they close every channel an old build's
  behaviour travels through):
  1. **Writer provenance stamps** on every shared record (`writer_build`, `writer_device`) — *who said this,
     with which software* (§3).
  2. **A semantic git merge driver** for the structured documents, installed so that older builds are
     unaffected and newer builds never produce line-union damage (§4.1).
  3. **The semantic write gate** — a shared copy is never rewritten for a difference no reader can see:
     order, compaction, stripped stamps, twins, superseded history (§4.2).
  4. **The tug-of-war breaker** — the general safety net for the *next* incompatibility nobody has found
     yet: a repeated external reversal of the same bytes stops being answered (§5).
  5. **Fleet visibility** — every computer publishes its build; a table of known defects per build explains
     what an older peer does and what this build does about it; `GET /api/health/fleet` and the hourly
     watchdog line say it in words (§6).
* **What a developer must do** when changing a shared document: follow the checklist in §7. The short
  version: *additive, optional fields only; never bump `schema_version` of a fleet-shared document; never
  write a byte change that is not a meaning change; add a row to `KNOWN_FLEET_DEFECTS` when you fix a
  behaviour other computers can see; bump `APP_BUILD`.*

---

## 1. Why versioning alone is not enough

The classic answer to "old clients corrupt data" is a **schema version** in each document and a refusal to
write documents with a newer version. That only works if the *old* code already contains the refusal.
Builds 1–6 of Large File Bridge never read `schema_version` to decide anything, so bumping it today would do
nothing to them — and worse, they re-serialize documents with their own `schema_version: 1`, so a newer
build writing `2` would flip the field back and forth: a new tug-of-war created by the versioning itself.

So the design treats the fleet as it is:

| Channel an old build influences | Can we change what the old build does? | What build 7 does instead |
|---|---|---|
| The bytes it writes into shared documents | No | Tolerant reading (§3, §4.2) and never answering noise (§4.2, §5) |
| How **git** merges shared documents on its machine | **Yes** — git reads `.gitattributes` from the shared repo, on every machine | A later attribute line routes the documents to a semantic driver; old builds fall back safely (§4.1) |
| Whether the user knows it is stale | Yes — every build publishes its build number in its device file | Known-defect table + fleet endpoint + watchdog line (§6) |
| Whether it gets updated | Only by the user (or its own self-update, when that works) | Say exactly which computer and why (§6) |

---

## 2. The shared documents and who writes them

| Document (in `<syncRepo>/repos/<repoUid>/`) | Shape | Merge rule | Old-build hazards seen |
|---|---|---|---|
| `decisions.yaml` — the decision ledger | append-only event log, folded on read (latest `decided_at` per path wins) | union by event identity, compacted | re-stamps (P-56), line-union damage (P-52) |
| `deletions.yaml` — fleet deletion tombstones | records keyed by (path, cid, sha256) | grow-only merge, widest scope, most destructive action | twins after a sha256 backfill, unstable order (P-57) |
| `manifest.yaml` — who holds which file | entries per path with `pinned_by` claims | per-entry merge; claims three-way against the base | withdrawn claims re-added by a union (P-51) |
| `files/**.yaml`, `history/*.txt` | small per-file event lists / flat logs | line union (git built-in) | none that matter at this size |
| `devices/<device>.yaml` | one file per computer, written only by that computer | "ours" | — (this is the build-number channel, §6) |

---

## 3. Writer provenance stamps (data schema)

Every record that travels between computers carries, **from the moment it is created**, which build and
which computer created it:

```yaml
events:
  - sid: r:83e62afc2c80
    path: site/internals/static/img/evidence/0388…jpg
    asked: false
    ipfs: false
    gitignore: false
    decided_by: deleted
    decided_at: 2026-09-27T21:04:10.113Z
    writer_build: 7              # the Large File Bridge build that SAID this
    writer_device: bryan-mac-pro # the computer that said it
```

The same two fields are on each `deletions.yaml` record, and `writer_build` is on each deletion receipt
(`enforced_by[]`). `decided_at` / `removed_at` / receipt `at` were already the *when*.

Rules that make the stamp safe on a mixed fleet:

* **Optional, never defaulted.** A record without a stamp was written by a legacy build (≤ 6) — or
  re-serialized by one, because older builds parse with a schema that strips fields it does not know.
  Absence is information, not an error.
* **Stamped once, at creation.** Never re-stamped by a merge or a re-serialization. A stamp that moved with
  every rewrite would be churn by construction and would stop answering "which build SAID this?".
* **Not part of identity.** Event identity (the union key) and deletion identity ignore the stamps — otherwise
  one event with and without a stamp would be two events, and every round trip through an old build would add
  one.
* **Preferred when duplicated.** When the same event arrives with and without a stamp, the union keeps the
  stamped copy (total order on the stamp, so both computers keep the same one).
* **Never a reason to write.** An older build stripping stamps is a spelling difference, and the semantic
  write gate (§4.2) ignores it — so the stamps live on in Local Storage and in every copy a new build writes
  for a real change, and no computer fights to put them back.

Why not a per-row stamp on `manifest.yaml`? A manifest is rewritten wholesale on every pin pass and has 30k+
rows; a per-row stamp would be 30k lines of noise on the first write. Its writer is visible through the device
registry instead.

Adding a stamp to a record, in code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/shared/writer-stamp.ts` — `writerStamp()`
Schema fields:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/shared/src/schemas.ts` — `DecisionEventSchema`, `DeletionRecordSchema`, `DeletionReceiptSchema`
Stamp-preferring union (identity excludes stamps):
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/ledger-merge.ts` — `unionLedgerEvents()` / `stampRank()`
Stamps applied at creation:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/decisions.service.ts` — `recordDecision()`, `reconcile()`, `seedMigratedLedger()`;
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/pin/deletions.router.ts` — `POST /api/pin/deletions`;
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/pin/deletions.service.ts` — `reap()` (receipts)

---

## 4. Syncing back and forth

### 4.1 The git layer: a semantic merge driver that old builds cannot break

For years `.gitattributes` said `decisions.yaml merge=union` (and the same for `manifest.yaml`). A **line
union is wrong for a nested YAML list**: an item whose `- ` leader lands on the far side of git's seam is
absorbed into the item above, and the document no longer parses (P-52). Every reader heals it on read, but
that is repair after damage, on every read, on every computer.

Build 7 makes git merge these files **as documents**:

```
decisions.yaml merge=union          ← kept: older builds re-add it if missing
manifest.yaml merge=union           ← kept
…
# >>> Large File Bridge (build 7+): merge these as documents, not lines — must stay LAST
decisions.yaml merge=lfb
manifest.yaml merge=lfb
deletions.yaml merge=lfb
.lfbridge/decisions.yaml merge=lfb
.lfbridge/manifest.yaml merge=lfb
# <<< Large File Bridge merge driver
```

How this coexists with older builds — the key property:

* **Git applies the LAST matching attribute line.** So the `merge=lfb` block overrides the union lines on
  every computer that reads this file — which is every computer, old or new.
* **Older builds never flap the file.** Their `ensureMergeAttributes` only checks that its exact
  `X merge=union` lines are present and appends any that are missing. They are all present, so an older
  build never edits the file. (A build-7 computer rewrites the file so the block is always last.)
* **On a build-7 computer** the driver named `lfb` is registered in that working copy's local `.git/config`
  (never committed — it is a path on that computer) and git runs it for any of those files that both sides
  changed.
* **On an older computer** the name `lfb` is not registered, and git **falls back to its ordinary text
  merge**: a clean result when the changes don't touch, a conflict when they do. The older build's own
  conflict resolver already settles these files with its "union" rule — exactly what it did before. Nothing
  about an older computer's behaviour gets worse.

What the driver does, per document:

| Document | Merge |
|---|---|
| `decisions.yaml` | union by event identity → compact → the canonical serialization |
| `deletions.yaml` | the grow-only tombstone merge (twins folded) |
| `manifest.yaml` | per-entry merge; `pinned_by` is merged **three-way against the base**, so a computer withdrawing its own claim is carried, not undone by the other side's copy |
| anything else / any failure | git's own line union followed by the union-damage repair — never worse than the old attribute |

Only the large structured documents use the driver: git spawns it once per file that both sides changed, and
the thousands of small per-file sidecars keep git's fast in-process union.

Attribute block and driver registration, in code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/git/git.service.ts` — `desiredGitattributes()`, `mergeDriverCommand()`, `GitBackbone.ensureMergeAttributes()`, `GitBackbone.ensureMergeDriver()`
The driver process:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/tools/git-merge-driver.ts` — `main()`, `mergeLedger` / `mergeDeletionDocs` / `mergeManifestDocs`

### 4.2 The writer: the semantic write gate

A merge that changes nothing a reader will conclude **does not write the shared copy**, whatever its bytes.
"Meaning" is defined per document:

* **Decision ledger:** the fold — for each file, the latest decision (`asked`, `ipfs`, `gitignore`,
  `decided_by`, `decided_at`). Event order, compaction, stripped writer stamps and superseded history are
  not meaning.
* **Deletion ledger:** the normalized tombstone set — twins folded, total order, writer stamps removed.

Two exceptions: a shared copy that is **damaged** (needed a line-union repair, or lost records) is written
back healed; and a shared copy that does not exist yet is seeded. Local Storage copies are not gated (they
never travel through git).

Consequences, concretely:

* An older build that re-stamps a tombstone every pass writes its re-stamp; this build folds it into Local
  Storage and **does not echo it back**. The commit stream is the old build's alone, not doubled.
* An older build that writes records in a different order or keeps twins leaves its spelling in place; this
  build does not "correct" it.
* A real change here (a new decision, a new deletion, an undelete) changes the meaning and travels at once.

Known and accepted cost: an event that is *superseded* (a newer event for the same file exists on both
sides) does not travel on its own. History of superseded events is kept in Local Storage.

In code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/merge-tasks.ts` — `ledger()` / `deletions()` (the gate), `runMergeTask()`
Meaning functions:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/ledger-merge.ts` — `ledgerMeaning()`, `latestEventPerPath()` (shared with `foldLedger`, so the two cannot disagree);
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/pin/deletions-merge.ts` — `deletionsMeaning()`

The git-side twin: the backbone's quiet gate never tries to judge the three large documents (they have no
volatile fields and a deterministic serializer), and never reverts a commit that heals a damaged HEAD.
In code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/git/git.service.ts` — `volatileYamlPathsFor()`, `GitBackbone.dropVolatileOnlyChanges()`

### 4.3 Idempotent writers (fix the source, not only the symptom)

Where the noise came from *our own* older code, the writer was fixed to be idempotent — a pass that changed
nothing writes nothing:

* The deletion reaper stales only entries **this pass** changed; `recordDecision` skips a tombstone for a
  path the ledger already folds to Undecided (P-56).
* A sha256 backfill folds into its null-sha twin; the deletion serializer sorts to a total order (P-57).

In code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/pin/deletions.service.ts` — `reap()`;
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/decisions.service.ts` — `recordDecision()`;
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/pin/deletions-merge.ts` — `mergeDeletions()`, `serializeDeletions()`

---

## 5. The tug-of-war breaker (the general safety net)

The specific causes get specific fixes (§4). The breaker is for the **next** incompatibility nobody has found
yet.

**Rule.** Before writing bytes `TO` over a shared file currently holding `FROM`:

* if `FROM` is **not** what this computer last wrote there (someone else put it there), and
* this computer has already written this exact `TO` over this exact `FROM` **3 times in the last 24 hours**,

then another writer keeps turning this computer's answer back into its own. Writing it a fourth time changes
nothing but the commit count — so the write is declined, **one** ERROR names the file and the computers on
older builds (with their known defects), and Local Storage stays authoritative.

Why it cannot block real work:

* A real change produces **new** bytes — a new `(FROM, TO)` pair the breaker has never counted. It is
  written immediately, and it ends the hold.
* A user toggling a decision back and forth produces repeated pairs, but every `FROM` there is bytes *this*
  computer wrote — excluded by the first condition.
* Evidence ages out after 24 hours; a held file is re-tried from scratch then.

The breaker applies to every write into a sync repo's working tree from the mirror: the decision ledger, the
deletion ledger, the manifest, the shared policy, and the `repo_storage.yaml` projection. Its history is
persisted (`~/T/_large_files_bridge/sync-fights.json`) so a restart does not reopen a fight.

In code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/sync-fight.ts` — `writeSharedIfDifferent()`, `listSyncFights()`
Applied at the commit of every mirror leg:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/storage/tracking-sync.service.ts` — `commitMerge()`, `mergePolicyInto()`, `projectRepoStorageToMirror()`

---

## 6. Knowing the fleet (versioning that works across builds)

* **`APP_BUILD`** — one deliberate integer per build, bumped when a change matters to other computers. Every
  computer publishes it in its own device file (`devices/<device>.yaml`: `app_build`, `app_build_label`) —
  the one channel an older build *does* keep current, because each computer writes only its own file.
* **`KNOWN_FLEET_DEFECTS`** — for each fixed behaviour that other computers can see: which builds still have
  it (`below`), what it does in one sentence, and what this build does about it. Build 7's rows:

| Id | Builds | What the older build does | What build 7 does |
|---|---|---|---|
| P-56 tombstone re-stamp | < 7 | re-records every fleet-deleted file as Undecided on every pass | recognises the re-stamp as unchanged meaning; never writes it back |
| P-57 deletion twins | < 7 | keeps a deletion twice after its checksum is filled in; writes the pair in varying order | folds twins on read; order alone is never written back |
| P-52 line-union merge | < 7 | merges the structured YAML documents line by line (can leave a file no reader can open) | heals on read; merges these documents with the semantic driver |

* **Where the user sees it:**
  * `GET /api/health/fleet` (allow-listed) → this build, every stale computer with its defects, and every
    file the breaker is holding.
  * A banner on every page (amber, dismissible per situation) says which computers are behind, what their
    build does, and what this computer does about it — and lists any shared file the breaker is holding.
  * The hourly watchdog line in `error.err` names the stale computers **and** what their build is known to do.
  * The tug-of-war ERROR (§5) names the file and the stale computers.
* **Getting them updated:** a stale computer is fixed only by updating Large File Bridge there (`git pull` in its checkout, then
  `just run` — or its self-update, when its checkout is clean). Nothing in the shared data can
  force an older build to change behaviour — which is exactly why §4 and §5 exist.

In code:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/shared/src/build.ts` — `APP_BUILD`, `KNOWN_FLEET_DEFECTS`, `defectsOfBuild()`, `FleetCompat`
Endpoint:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/health/health.router.ts` — `GET /api/health/fleet`
Banner (reads the endpoint):
`~/BGit/Bryan_git/LargeFileBridge/code/packages/frontend/src/components/FleetCompatBanner.tsx` — `FleetCompatBanner`
Watchdog message:
`~/BGit/Bryan_git/LargeFileBridge/code/packages/backend/src/modules/schedule/self-update.service.ts` — `stalePeerMessage()` / `knownDefectsSentence()`

---

## 7. Checklist for any change to a shared document

Before merging a change that touches anything in §2:

1. **Additive and optional only.** New fields are `.optional()` (never `.default(...)` if the default would
   make an old record look different when re-serialized). Absence must mean "legacy writer", and old records
   must parse unchanged.
2. **Never bump `schema_version`** of a fleet-shared document while any computer might run a build that
   writes the old value — the field itself becomes a tug-of-war.
3. **Deterministic serialization with a TOTAL order** (plain code-point comparison where two computers could
   otherwise disagree). Two records that compare equal must be the same record.
4. **Identity excludes provenance** (stamps, timestamps of re-statements) — or every round trip grows the
   document.
5. **No write without a meaning change.** Extend `ledgerMeaning` / `deletionsMeaning` (or add a meaning
   function for a new document) so the write gate covers the new field correctly: a field readers act on is
   part of the meaning; provenance is not.
6. **Idempotent writers.** A pass that changed nothing writes nothing — test it (run the pass twice; the
   second must not touch the file).
7. **Stamp new records at creation** with `writerStamp()`.
8. **If the fix changes a behaviour other computers can see, add a `KNOWN_FLEET_DEFECTS` row and bump
   `APP_BUILD`** (with a label that says what changed).
9. **Merges across a mixed fleet:** if the document is merged by git, make sure the `lfb` driver handles it
   (add it to `SEMANTIC_MERGE_PATHS` and a merger in `git-merge-driver.ts`), and keep any older `merge=`
   line an older build expects present *above* the driver block.

---

## 8. Tests that pin this down

| What | Spec |
|---|---|
| Stamps: one identity, stamped copy wins, round trip | `code/packages/backend/src/modules/storage/fleet-compat.spec.ts` §3 |
| Meaning ignores spelling, changes with decisions/deletions | `fleet-compat.spec.ts` §4.2 |
| Mirror not rewritten for an old build's spelling; a real decision still travels | `fleet-compat.spec.ts` "end to end" |
| Breaker trips on external reversals, never on real changes or own toggles | `fleet-compat.spec.ts` §5 |
| Driver with real git: clean merge that parses; old computer gets a conflict, never damage; claims merged three-way | `code/packages/backend/src/tools/git-merge-driver.spec.ts` |
| Reaper silent after the first pass; twins fold; merge byte-identical both ways | `code/packages/backend/src/modules/pin/deletions.spec.ts` "churn" |
| Quiet gate never judges the large documents | `code/packages/backend/src/modules/git/quiet-gate.spec.ts` |

---

## 9. Open items

* **Which old computer is churning right now** (2026-09-27, measured): the sync repo's reflog on this
  computer shows the remaining every-~7-minute `decisions.yaml` / `deletions.yaml` commits arriving as
  FAST-FORWARDS — made elsewhere. Of the stale computers, only **bryan-mac-studio** (build 6, active today)
  and **bryan-mac-pro** (build 6, active today) are running; the rest have been silent since August.
  Updating those two ends it. (Every computer commits as the same git identity, so `git reflog` — "commit"
  vs "merge … Fast-forward" — is how to tell this computer's commits from a peer's.)
* **Older computers still churn on their own** (including, the moment this computer moved to build 7, the
  user's own build-6 Macs — bryan-mac-pro and bryan-mac-studio). A build-6 computer still re-stamps its tombstones and
  commits them; build 7 no longer answers, but only updating that computer stops its own commits. The
  fleet endpoint and watchdog name them (as of 2026-09-27: rijan-acerpredatorwh and xmod2-sjoshi on build 4;
  abiralkhanal-macbook-pro, lenovo-laptop-ug0k96ca, nayan-neo and rafin-macbook-pro on build 5).
* **Postgres dual-write of reconciled events.** Events that arrive by reconcile (a peer's writes) are not
  yet inserted into `lfb.decision_event` until the next backfill pass (database.mdx) — a gap between boots,
  not a data loss.

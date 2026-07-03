
WebApp = Large File Bridge

# Large File Bridge — Charter

`LargeFileBridge` is a syncing big files across a user's computers via IPFS.
Do NOT use this for files that shouldn't be public and accessible to other people.
With AI, these days, people often use GIThub to share/backup their files across their computers.
* This works great when many files are small and text files.
* The problems happen with videos, large image files and other large files.
* With "Large File Bridge" (LFB or LFBridge) is that you can GIT IGNORE the big files.
* Then Large File Bridge can use IPFS and lists of IPFS files to get the files synced between
  your computers.  You may have a home laptop, a second home computer, a work computer,
  and maybe a server.  Or maybe another family member.
* LFBridge allows it that they all IPFS PIN the files.  So if you lose a laptop, then
  your files are safely on your other computers.  And up-to-date.
  This also keeps your git
## What this is

* A web app that syncs large files across a user's own computers via IPFS.
* **Runs locally first.** Development and early use happen on **localhost**.
* **Server-side later.** Over time we will stand up a hosted version running on a
  server. The design should not assume localhost-only.

## Authentication

* Uses **OpenAuth federated** login.
* Users sign in with their **Google email address**.
* **Only allow-listed users** may enter. OpenAuth federated enforces this —
  no one outside the list gets in.
* **No default / anonymous account.** There is no "no-login" access path. Every
  session belongs to an authenticated, allow-listed user.

## IPFS gateway / no-relay policy (security)

* **By default, the local computer must NOT act as a public IPFS gateway or
  relay.** We do not want our computer to become a gateway that bounces or
  caches **other people's** content or traffic.
* We only want to store, pin, and serve **our own content** — nothing else.
* We still need a solution so that our **other computers** can fetch our IPFS
  files. Solve for that (our machines can reach our files) **without** turning
  any machine into a general-purpose gateway for the public.
* This secure, gateway-off behavior is the **default**. There is a setting in
  the web app's **global settings** that can change it away from the default,
  but the default stands unless the user deliberately opts out.
* **Always look for cases where we are out of compliance** with this policy and
  flag/fix them. The only acceptable exception is when the user has gone out of
  their way to change that setting on their specific computer.

## Tech stack

* Language: **TypeScript**.
* Runtime: runs as a **Node app**.

## Background sync process

* On Mac, LFBridge runs a **background process** that periodically syncs the
  large files over IPFS.
* It is scheduled as a **`launchd` plist** (the macOS cron equivalent), not a
  traditional crontab entry.
* It runs **every 15 minutes**.
* The plist must be **installed** for the background process to exist. Whether the
  user then wants it **on or off** is a separate choice.

## Web app

* Getting the **web app** started is the first priority.
* Part of the UI provides **transparency on the background process**:
  * Whether it is **installed**.
  * Whether it is currently **on or off**.
* The user can **turn the background process on or off** from the web app.

## Git remote

* Repo: `https://github.com/BryanStarbuck/LargeFileBridge.git`

## Directory layout

```
LargeFileBridge/
├── code/        # Application code (web app: frontend + backend)
├── pm/          # Project management: goals, to-dos, decisions
├── README.md
└── CLAUDE.md    # This charter
```

### Important directory rules

These rules are strict — they define where things are allowed to live.

* **`~/BGit/Bryan_git/LargeFileBridge/pm/`** — Product management **only**.
  All product-management material (goals, to-dos, decisions, planning) lives here.
  **Never put code in this directory.**

* **`~/BGit/Bryan_git/LargeFileBridge/code/`** — Web app code **only**.
  This directory, and its subdirectories, are the **only** place the web app code
  may go. All application code lives here — nowhere else.

## Knowledge directory

* **`~/BGit/Bryan_git/LargeFileBridge/knowledge/`** holds our knowledge base.
* **Read every file in this directory into the context window.** These files
  give us knowledge we should know and understand about the project. Always
  pull them in.

## UI page part specifications

* Every UI page in the product has a **part specification** written as an
  **`.mdx`** file in the **`pm/`** directory.
* Create these `.mdx` part specs **if and when needed** — one per UI page.

## Tables (TanStack)

* **All tables are TanStack tables.** No exceptions.
* Above every table sits a control row with:
  * A **search** box.
  * A single **filter** icon (opens a dropdown to filter the table).
  * A single **sort** icon (opens a dropdown to sort the table).
* The filter and sort dropdowns apply to the table below them. Build the
  dropdown UI **very well** — reference **SysRaps** and how they implement
  their filter/sort dropdowns as the pattern to match.
* **Pagination default: 500 items per page.** Do **not** default to small
  pagination — show the item count before pagination and page at 500 by
  default.
* **Click-a-header to sort.** Clicking a column header sorts the table by that
  column; clicking the **same** header again toggles **ascending ↔ descending**.
  This needs **no new UI** — the header itself is the affordance (a small caret
  `↑`/`↓` marks the active sort column and direction). It is **in addition to** the
  sort dropdown above the table; both drive the **same** sort state, so a column
  sorted by header click shows as active in the dropdown and vice-versa.
* **Full-page-height tables.** A table with **no content beneath it** fills the
  **full height of the page**: its body scroll region grows down to the bottom of
  the viewport so there is **no dead white space** below it when the browser window
  is tall. The **page does not scroll** in this case — the rows scroll **inside**
  the table (the header/control row and the count/pagination footer stay pinned;
  only the body scrolls). This is the **default** for every table across the site.
  * **The one exception is content underneath the table.** When a page renders
    anything **below** the table (a details disclosure, a footer summary, a second
    panel), the table keeps a **bounded height** so that content below stays
    visible; it does **not** expand to fill the page. Everything **above** a table
    (headers, stat tiles, banners, filter rows) is unaffected — only content
    **below** triggers the exception.

## Compression (a core value)

We care about compression. Many large files that people sync are **uncompressed**
when they don't need to be. LFBridge helps users find those files and, only when
they ask, compress them.

* **Scope.** We do this **primarily for video files** and **secondarily for image
  files**. Normally **nothing else** — unless something special warrants it.
* **Never compress or alter a file unless the user explicitly asks.** We detect,
  surface, and offer. We do not act on files on our own.
* **Track the uncompressed count.** Wherever we look — a single repo, a directory,
  a list of repos, or the whole computer — we want a metric for **how many files
  appear to be uncompressed** so the user can see it and act.
* In the UI we give options to **compress** and show **indicators** of whether a
  file is compressed or not.

### Detecting whether a file is "compressed" (learned baselines)

We can't know compression state from the extension alone, so we **learn it over
time** from a growing sample set.

* Keep a **YAML or CSV file in the repo** that we train over time. It records, for
  a file of a given **duration** and **pixel size (resolution)**, the **typical
  file size when uncompressed** vs. the **typical file size when compressed**.
* Store the shape of the distribution, not just a point: the **mean of the bell
  curve** plus **one sigma (1σ)** and **two sigma (2σ)** bounds.
* Include **samples across a range of durations and a range of pixel sizes** so the
  model generalizes. (A movie is the canonical example: from duration + resolution
  we can predict the expected compressed and uncompressed size ranges.)
* Use this baseline to decide whether a given file **looks compressed or not**, and
  to drive the uncompressed-count metric and the "offer to compress" indicators.

### PNG → compressible conversion (with safety checks first)

* We often offer a UI option to convert a **PNG** (or other non-compressible
  format) into a **compressible** format.
* **Before converting, run checks** and warn the user if converting would lose
  data or functionality:
  * **Check whether the alpha channel is actually used** (a real alpha mask). If
    the PNG has a meaningful alpha channel, warn that conversion will **lose that
    transparency data**.
  * Warn about any other functionality that relies on the non-compressed format
    and would be lost.
* Only after these checks and the right warnings do we present the convert option.

## Big-file / git-ignore nudging (policy)

* A repo can normally check in files **under our big-file threshold**. Files
  **over** the threshold usually want to be **git-ignored** (they sync via IPFS
  instead).
* **Never add a `.gitignore` entry automatically for anyone.** We only surface and
  offer.
* We **do** point out files that are **big but not git-ignored**, and give an easy
  **one-click** option to git-ignore them.

## Category rollup table (directory / repo / computer level)

At a higher level — a **directory**, a **repo**, or the **whole computer** — show a
table of **count + category** with a per-row action. Each row shows the number
(e.g. `27`) and lets the user click to act (e.g. **Compress**, **Ignore**, or
**Track**). Rows by file category:

1. **Videos that can be compressed** — count + click to compress.
2. **Images that can be compressed** — count + click to compress.
3. **Big files that aren't a good idea to check in** — count + click to git-ignore
   them.
4. **Big files that are being git-ignored** — these are **not tracked by us and not
   synced**. Nudge the user to decide whether they want us to **track/sync** them.

(This is a TanStack table like all others — see the Tables section above.)

## Sister webapps (learn from these)

These are established sibling web apps. Study them for patterns, conventions, and
structure — they share our `code/` + `pm/` layout and are good references for how
to build and organize this app.

* **`~/BGit/all/app/`** — sister webapp (has its own `CLAUDE.md`, `code/`, `pm/`,
  `cli/`, `justfile`; pnpm workspace with `packages/`).
* **`~/BGit/Bryan_git/EmailDeliveryHero/`** — sister webapp (has its own
  `CLAUDE.md`, `code/`, `pm/`, `justfile`, `fix_log/`).

## Per-file tracking metadata (in the YAML)

When we **track** a file, we record it in the tracking YAML with enough
per-file metadata to tell whether it has changed since we last saw it.

* **Store a hash of the file** so we can detect whether it has changed or not.
* **Also store, per file:**
  * **File size.**
  * **Created date.**
  * **Modified date.**
* **Compressible types (videos and images) carry two hashes.** For these, keep a
  **compressed** and an **uncompressed** hash, layered in the YAML hierarchy —
  nest them **underneath** the file entry. That way for one logical file we may
  be tracking both the **compressed** and the **uncompressed** hashes (the
  size/fingerprint of each variant).
* Treat these hashes as **fingerprints** of the file (and of each compressed /
  uncompressed variant) — the thing we compare against to know if a file is
  new, unchanged, or modified.

Example shape (illustrative — nest the compressed/uncompressed variants under
the file):

```yaml
files:
  some/movie.mp4:
    size: 734003200
    created: 2026-05-01T10:12:00Z
    modified: 2026-06-18T14:33:00Z
    hashes:
      uncompressed:
        hash: <fingerprint>
        size: 734003200
      compressed:
        hash: <fingerprint>
        size: 118489088
```

## Perceptual / content-fingerprint matching (PhotoDNA-style) — local only

We want to know when two files are **fundamentally the same file** even after
they have been **reduced in pixel resolution**, **compressed**, or **converted**
(e.g. **PNG → JPEG** with high lossy compression), and similar transforms.

* **PhotoDNA** is the canonical example of a robust perceptual hash that survives
  these transforms. We want that capability, but there are **competitors /
  alternatives to PhotoDNA** — we will **evaluate the options and pick one**.
* **Hard requirement: no external networking.** Whatever we choose must run
  **entirely locally**. It must **NOT** phone home, call an external service, or
  otherwise send file data or fingerprints over the network. (Note: the real
  PhotoDNA service is used for reporting content; we are **not** doing that —
  **we are not a reporting service** and must not behave like one.)
* Use this perceptual fingerprint to recognize the **same underlying content**
  across compressed/uncompressed and format-converted variants, complementing the
  exact per-file hashes above.



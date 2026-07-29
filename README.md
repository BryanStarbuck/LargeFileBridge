# Large File Bridge

**Keep your Git repos small, and keep your big files in sync across every computer you own — over IPFS, with no cloud subscription and no storage bill.**

Large File Bridge is a small web app you run on your own machine. Open
**<http://localhost:2222/>** and it shows you every Git repo and folder on this
computer, finds the huge files inside them, and helps you decide what to do with
each one: sync it to your other computers, git-ignore it, compress it,
transcribe it, describe it, or delete a duplicate of it.

It is TypeScript / Node, MIT licensed, and it runs entirely on your machine.

---

## ⚠️ Read this first: what you sync is PUBLIC

Large File Bridge moves your big files with **IPFS**. IPFS is a public,
content-addressed network. That has one consequence you must understand before
you pin anything:

> **Every file you choose to sync is public. It is not encrypted. Anyone who
> knows or guesses its content hash (its CID) can download it, from anywhere,
> forever — including after you unpin it, if someone else has already copied it.**

In practice your files are hard to *find*: a CID is a long random-looking hash,
nothing publishes it, and nobody is indexing your laptop. But **"hard to find"
is not "private."** Obscurity is not security.

So:

* ✅ Good for: video projects, renders, footage, game assets, model weights,
  datasets, photo libraries you'd be fine having on YouTube.
* ❌ **Never** for: anything secret, personal, confidential, licensed, medical,
  financial, or under NDA.

This is why syncing is **opt-in per file**. Large File Bridge never pins
anything on its own — it shows you candidates, and you check the box. Nothing
leaves your machine until you say so.

A separate promise, in the other direction: **your computer never becomes a
public IPFS gateway or relay.** By default the node stores and serves *your*
content only — it will not cache or rebroadcast strangers' traffic. That default
is enforced, and only you can turn it off in Settings.

---

## What it does for you

Concretely, here is what you get out of running it:

1. **Push to GitHub without fighting file-size limits.** Your 4 GB video stays
   out of Git history, so clones stay fast and pushes stop getting rejected.
2. **Your big files exist on all your computers.** Laptop, desktop, studio
   tower, home server, a family member's Mac — clone the repo, run the sync, and
   the large files reappear right where the code expects them.
3. **A real backup, for free.** Every machine that pins a file is another copy.
   Lose a laptop and the files are already safe elsewhere — and current.
4. **No monthly storage bill.** No Git LFS quota, no Dropbox tier, no S3
   invoice. Your bytes live on hardware you already own.
5. **Find where your disk went.** Browse any folder or repo and see the big
   files ranked, with what's tracked, what's ignored, and what's duplicated.
6. **Reclaim space by compressing.** It spots videos and images that are far
   larger than they need to be and offers to compress them — with integrity
   checks, and never without you asking.
7. **Stop storing the same movie five times.** Duplicate and subset detection
   finds identical *and* re-encoded/downscaled/cropped copies of the same
   content, side by side, so you can safely delete the extras.
8. **Make your media searchable.** Local transcription of audio/video, AI
   descriptions of images and video, and OCR of on-screen text — saved as plain
   text files next to the originals, so grep and your editor can find them.
9. **A to-do list instead of a chore.** One page tells you what needs attention
   right now — files to pull down from another computer, big files to ignore,
   media to compress, things not backed up anywhere.
10. **It keeps working when you're not looking.** A background job runs every 15
    minutes to pin and fetch, and every 4 hours to rescan.

---

## How it works

The core idea is a clean split between two jobs Git tries to do at once:

* **Git tracks the small stuff** — code, prompts, docs, config — and stays the
  source of truth for how the project is laid out.
* **IPFS moves the large files** between your machines, out of band, never
  touching your Git remote.

```
   ┌──────────────┐        git (small files only)      ┌──────────────┐
   │  Computer A  │ ──────────────────────────────────▶│    GitHub    │
   │              │◀────────────────────────────────── │  (code only) │
   └──────┬───────┘                                     └──────────────┘
          │
          │  IPFS  (large files, content-addressed, public)
          │
   ┌──────▼───────┐
   │  Computer B  │
   └──────────────┘
```

The bridge between the two is a **sync list**: a small text manifest that travels
with the repo and records each large file's path and its IPFS CID. Git carries
the list; IPFS carries the bytes. Clone anywhere, sync, and the files land next
to the code that references them.

Files that aren't in a Git repo at all — a folder of movies under `~/`, say —
work the same way, via a *storage* (see below) instead of a repo.

---

## Install

**Platform:** macOS is the primary and best-tested platform (the background
scheduler uses `launchd`). Linux works for the web app; the scheduler does not
install itself there yet. Windows is untested.

### 1. Prerequisites

```bash
brew install node pnpm just ipfs      # node must be >= 20; ipfs is Kubo
brew install ffmpeg                   # optional but strongly recommended
```

* **node ≥ 20** and **pnpm** — required to run the app.
* **just** — the task runner every command below uses.
* **ipfs (Kubo)** — required for syncing. The app can start and manage the
  daemon for you.
* **ffmpeg / ffprobe** — needed for video compression, duration/resolution
  probing, transcription and video frame analysis. Without it the app runs, but
  every video feature is disabled.

If you skip one, the app's **Tools** page tells you exactly what's missing, what
it's used for, and the command to install it. Nothing is ever installed without
you clicking.

⚠️ If you already ran `brew services start kubo` at some point, turn it off
(`brew services stop kubo`). Two owners fighting over the same IPFS repo lock is
a real, diagnosed failure mode — one of them loses and silently stays dead.

### 2. Clone this repo and its auth library

Sign-in is handled by [OpenAuthFederated](https://github.com/BryanStarbuck/OpenAuthFederated),
which is consumed as a local `link:` dependency, so it must sit **next to** this
repo:

```bash
git clone https://github.com/BryanStarbuck/LargeFileBridge.git
git clone https://github.com/BryanStarbuck/OpenAuthFederated.git
```

Both must end up as siblings in the same parent directory. (`just` will stop
with a clear message and the exact `git clone` command if it can't find it.)

### 3. Run it

```bash
cd LargeFileBridge
just run
```

That installs dependencies, seeds a backend `.env`, builds the CLI, and starts
both processes in the background. When it's up it prints the URL:

```
Up: http://localhost:2222  (API :8787)
```

| | Port | What |
|---|---|---|
| **Web app** | **2222** | What you open in a browser. If 2222 is taken it moves up (2223, 2224, …) and prints the port it took. |
| API / backend | 8787 | JSON API. Not meant for a browser. |

Everyday commands:

```bash
just run        # start (and restart — it stops the old instance first)
just status     # is it actually up? health-checks the backend, not just the port
just stop       # stop it
just logs       # follow the launcher log
just logs-all   # follow all four logs at once
just boot on    # start the web app automatically at every login/reboot
```

`just status` is worth knowing: a live page on :2222 does **not** mean the app
works — Vite happily serves pages with a dead backend. `status` asks the API to
prove it's alive and exits non-zero if it isn't.

### 4. First run in the browser

Open <http://localhost:2222/>. You'll be walked through, in this order:

1. **Security setup** — enter the Google accounts (and/or company domains)
   allowed to use this install. This happens once and is stored locally. There
   is no anonymous account; every session belongs to a listed user.
2. **Sign in with Google** — this needs a Google OAuth client. Paste
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` into
   `code/packages/backend/.env` (redirect URI
   `http://localhost:8787/api/v1/oauth_callback`).

   **Just trying it out?** Skip Google entirely. The shipped `.env.example` sets
   `LFB_DEV_AUTH=true`, which signs you in as the first allow-listed email —
   but only when *all* of these hold: local mode, the request came from this
   machine (loopback), the flag is explicitly `true`, security setup is done,
   and no Google credentials are configured. It is unreachable over the network
   and impossible in server mode.
3. **Tools** — if `ipfs` or `ffmpeg` are missing, you'll land here first with an
   install button.

Then point it at a repo or folder and run a scan.

---

## The features, one by one

### Repos

The home page: every Git repo on this computer that Large File Bridge manages,
with its large-file counts, pin status, and warnings. Open one and you get the
per-repo workspace — the file table, the task tabs (All / IPFS / Compress /
Transcribe), and one clear recommendation at the top of the page telling you the
single most useful next thing to do.

### Storages — where your files belong

Not everything lives in a Git repo, so files are grouped into **storages**:

* **Personal** — your own big files, and the default owner of any repo with no
  organization behind it.
* **Company** — one per organization, auto-detected from a repo's Git remote.
  Repos group under their owner. Ownership is never propagated to a teammate's
  machine silently — they get a consent screen.
* **Repos** — the plain list of Git repos.
* **Communities** — see below.

A directory-based storage is marked by a `storage.yaml` at its root, which makes
that directory the tracking area. Inside a working Git repo, everything Large
File Bridge writes is quarantined in one hidden `.lfbridge/` folder so it never
litters your project.

### File System browser

Browse the whole disk two ways: a Finder-style column view, and a flat
full-paths table of the large files under any folder. Rows carry badges — repo,
pinned, compressible, on IPFS — and folders whose subtree hides big files get
tinted so you can hunt down disk usage by eye.

### Devices / Peers

The registry of every computer carrying your files — this Mac, a laptop, a
studio tower, a server. Each is fingerprinted by its hardware (model, year,
screen, disk, RAM, chip) so two similar MacBooks are told apart. It always shows
at least this machine.

### IPFS control panel

Is the node installed? Is it running? Turn it on or off, keep it on across
reboots, and watch live metrics — files shared, storage used, peers, bandwidth.
It also states your gateway posture plainly, so the "only our own content" rule
is visible rather than assumed. Drill in for the full pinset table.

### Communities

The opposite direction from Devices: **other people's public files that you
choose to carry.** Someone publishes a list of CIDs; you can *Get* them to
watch, or *Support* them by rebroadcasting so the content stays alive. Per
community you pick Block (the default) / Recommended / Full backup, against a
storage budget derived from your actual free disk. Everything is explicit
opt-in, and it still never makes you a public gateway.

### Compression

Many large files are large for no reason. Large File Bridge learns what a
compressed file of a given **duration × resolution** normally weighs, keeps that
as a distribution (mean, 1σ, 2σ) in a baseline file it improves over time, and
uses it to flag files that look uncompressed. Then it offers to compress them —
video first, images second.

* **Nothing is ever compressed or altered unless you ask.**
* Integrity is checked before and after; a conversion that can't verify its
  output is blocked rather than trusted.
* Originals go to the trash by default, not to `/dev/null`.
* Converting a PNG warns you first if it has a real alpha channel you'd lose.

### Duplicates and Subsets

Two review screens under **Videos**, backed by a dedicated detection scan:

* **Duplicates** — files that are the same content, whether byte-identical or
  perceptually identical after a re-encode.
* **Subsets** — files whose content lives *inside* another file: clips, crops,
  downscales.

Both show candidates side by side with previews so you can confirm before
deleting anything. Perceptual matching is local-only — fingerprints never leave
your machine, and nothing is ever reported anywhere.

### Transcription, AI descriptions, OCR

Three ways to turn media into searchable text, saved as plain files beside the
original (`movie.mp4` → `movie.mp4.transcription`, `movie.mp4.ai_description`):

* **Transcription** — speech to text, running locally on your machine.
* **AI descriptions** — what an image or video actually *shows*. This one calls
  an external vision provider, so it needs an API key (Gemini is the only
  provider that handles video); the app shows you exactly where to put it. This
  is the one feature that talks to a third party, and only when you invoke it.
* **OCR** — text burned into images, video frames, and PDFs. Fully local, with
  the engine bundled as a library — nothing to install.

All three run through a queue with progress, batching, and crash recovery, so
you can point them at a whole tree and walk away.

### To Do

The single aggregated list of everything the app recommends, bundled per
storage: files to pull down from your other computers, big files to git-ignore,
media to compress, files backed up nowhere, media that could be transcribed.
Only storages with actual work show up, each as a card you open, review, and
apply.

### Git-ignore nudging

Files above the big-file threshold usually want to be git-ignored so IPFS can
carry them instead. Large File Bridge points them out and gives you one-click
ignore — but **it never edits your `.gitignore` on its own**, and un-ignoring
removes only the exact line it added.

### Scans and the background worker

Two scheduled `launchd` jobs, both visible and switchable from the **Scans**
page:

* **pin — every 15 minutes**: pin new bytes, fetch anything missing, refresh the
  pinset.
* **scan — every 4 hours**: rediscover repos and files.

```bash
just install-agents    # install + enable both
just uninstall-agents  # remove them
just scan              # run a discovery scan right now
just pin               # run a pin/fetch right now
```

Installing the schedule and having it *enabled* are separate choices — you can
have it installed and turned off.

### The `lfb` command line

A thin CLI wrapper over the same backend (it starts the app itself if it isn't
running). It computes nothing of its own, so the CLI and the web app can never
disagree.

```bash
lfb                              # every file under the current directory
lfb ~/Movies --tree              # same, as a tree
lfb files ~/repo --compress      # just the compressible ones
lfb files --all --ocr --transcribe
lfb help
```

Categories: compressible, should-be-git-ignored, pull-down (on another computer
but missing here), not-backed-up, transcribable, AI-describable, OCR-able.
Output is plain absolute paths, so it pipes cleanly into anything.

`just build` and `just run` keep it up to date. Add `LargeFileBridge/cli` to
your `PATH` to call it as `lfb`.

---

## Where it keeps things

There is **no database**. Everything is flat files.

| Path | What |
|---|---|
| `~/T/_large_files_bridge/` | State root — config, ledgers, caches. Override with `LFB_STATE_DIR`. |
| `~/T/_large_files_bridge/log.log` | Everything the app said |
| `~/T/_large_files_bridge/error.err` | Only what broke (written synchronously, survives a crash) |
| `~/T/_large_files_bridge/transactions.log` | What the app *did* — the work ledger |
| `~/T/_large_files_bridge/launcher.log` | Whether the process itself died |
| `<repo>/.lfbridge/` | Per-repo artifacts, quarantined in one hidden folder |

All logs rotate at 5 MiB × 5 generations, so nothing grows without bound.

---

## Repository layout

```
LargeFileBridge/
├── code/        # the web app — pnpm workspace (backend + frontend)
├── cli/         # the `lfb` command line
├── pm/          # product specs, one .mdx per page/feature — the real documentation
├── knowledge/   # background notes (IPFS, device identification)
├── scripts/     # helper scripts (log rotation sink)
├── justfile     # every command in this README
├── CLAUDE.md    # project charter and working rules
└── README.md
```

If you want to understand a feature deeply, read its spec in `pm/` — those files
are written first and describe intent, behavior, and where the implementing code
lives.

---

## Status

Actively developed and used daily on macOS. Expect rough edges outside that
path: Linux runs the web app but not the scheduler, Windows is untested, and the
hosted/server mode is designed for but not yet deployed.

## Contributing

Issues and pull requests welcome. Two house rules:

* `pm/` is product management only — never put code there.
* `code/` is the only place application code lives.

## License

[MIT](./LICENSE) © Bryan Starbuck

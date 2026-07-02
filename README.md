# LargeFileBridge

Keep your Git repos small and your big files in sync across every computer you own.

## The problem

Git is terrible at large binary files. Videos, model weights, render output,
datasets, PSDs, raw photos — commit them and your `.git` history balloons,
clones crawl, and hosts like GitHub start rejecting pushes (100 MB hard limit,
warnings well before that). Git LFS helps but still routes every byte through a
hosted quota you pay for.

Most of those big files don't need history or a central server at all. You just
need the *same bytes* to exist on your laptop, your desktop, and your studio
machine.

## The idea

**LargeFileBridge splits the two jobs cleanly:**

* **Git** tracks the small stuff — code, prompts, docs, configuration — and is
  the source of truth for how the project is structured.
* **A peer-to-peer layer** (IPFS or direct p2p sync) moves the large files
  between your machines out-of-band, never touching the Git remote.

The bridge between them is a `.gitignore` that deliberately excludes the big
files, plus a manifest that records *what* those files are and *where* to fetch
them from the p2p network. Clone the repo anywhere, run the sync, and the large
files reappear next to the code that references them.

```
   ┌─────────────┐        git (small files)        ┌─────────────┐
   │  Computer A  │ ───────────────────────────────▶│   GitHub     │
   │             │◀─────────────────────────────── │  (code only) │
   └──────┬──────┘                                  └─────────────┘
          │
          │  IPFS / p2p  (large files, content-addressed)
          │
   ┌──────▼──────┐
   │  Computer B  │
   └─────────────┘
```

## How it works

1. **Git ignores the big files.** The `.gitignore` excludes common large-media
   and binary extensions plus a dedicated `large/` directory. Those bytes never
   enter Git history, so pushes stay fast and under host limits.
2. **A manifest tracks them instead.** A small text manifest (checked into Git)
   lists each large file by path and its content hash / IPFS CID. This *is*
   versioned, so every machine agrees on which files should exist.
3. **P2P moves the bytes.** IPFS (content-addressed, deduplicated) or a direct
   peer-to-peer sync (e.g. Syncthing-style) transfers the large files directly
   between your computers — no cloud quota, no central server.
4. **Re-hydrate on any machine.** After cloning the repo, run the sync to pull
   every file named in the manifest into place.

## Repository layout

```
LargeFileBridge/
├── code/        # scripts / tooling that runs the bridge (git-tracked)
├── pm/          # product-management notes, specs, decisions (git-tracked)
├── large/       # big files live here — GIT-IGNORED, synced via p2p
├── .gitignore   # the bridge: what Git deliberately skips
└── README.md
```

## Why IPFS / p2p instead of a cloud drive

* **No quota, no bill.** Your bytes live on your own machines.
* **Content-addressed.** IPFS names files by their hash, so identical files are
  stored once and integrity is verifiable.
* **Offline-friendly.** Peers sync directly on a LAN without a round trip to the
  internet.
* **Decoupled from Git hosting.** Your GitHub repo never sees a 500 MB video, so
  it never rejects a push.

## Status

Early scaffolding. The `code/` and `pm/` directories are where the sync tooling
and specs will grow.

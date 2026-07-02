
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

members a shared, logged-in space: shared text files, family resources, and a
growing collection of pointers off to things the family does and cares about.

## What this is

* A web app for the **Starbuck family** — members log in and access shared content.
* **Runs locally first.** Development and early use happen on **localhost**.
* **Server-side later.** Over time we will stand up a hosted version running on a
  server. The design should not assume localhost-only.

## Authentication

* Uses **OpenAuth federated** login.
* Members sign in with their **Google email address**.
* **Only allow-listed family members** may enter. OpenAuth federated enforces this —
  no one outside the list gets in.
* **No default / anonymous account.** There is no "no-login" access path. Every
  session belongs to an authenticated, allow-listed family member.

### Allow-listed family members (Google emails)

* Heather — `heather@thestarbucks.com`
* Jordan — `jordan@thestarbucks.com`
* Bryan — `bryan@thestarbucks.com`
* Tom Starbuck — `tom@thestarbucks.com`
* ...additional family members to be added to the allow-list over time.

> Note: confirm the exact login domain. This charter assumes `thestarbucks.com`
> based on the repo name; update these addresses if the real Google domain differs.

## What the app does

* Hosts a number of **shared text files** the family can read and share.
* Provides **things we do** together as a family.
* Acts as a hub of **pointers** off to other family resources and destinations.

## Directory layout

```
the_starbucks/
├── code/        # Application code (web app: frontend + backend)
├── pm/          # Project management: goals, to-dos, decisions
├── README.md
└── CLAUDE.md    # This charter
```

### Important directory rules

These rules are strict — they define where things are allowed to live.

* **`~/BGit/Bryan_git/the_starbucks/pm/`** — Product management **only**.
  All product-management material (goals, to-dos, decisions, planning) lives here.
  **Never put code in this directory.**

* **`~/BGit/Bryan_git/the_starbucks/code/`** — Web app code **only**.
  This directory, and its subdirectories, are the **only** place the web app code
  may go. All application code lives here — nowhere else.

## Sister webapps (learn from these)

These are established sibling web apps. Study them for patterns, conventions, and
structure — they share our `code/` + `pm/` layout and are good references for how
to build and organize this app.

* **`~/BGit/all/app/`** — sister webapp (has its own `CLAUDE.md`, `code/`, `pm/`,
  `cli/`, `justfile`; pnpm workspace with `packages/`).
* **`~/BGit/Bryan_git/EmailDeliveryHero/`** — sister webapp (has its own
  `CLAUDE.md`, `code/`, `pm/`, `justfile`, `fix_log/`).





---
title: Device Identification & Disambiguation
description: How Large File Bridge fingerprints each computer, auto-names it, and tells two similar machines apart. The human companion to the code in device-naming.ts / hardware.service.ts and to pm/devices.mdx §7–§9.
---

# Device Identification & Disambiguation

Large File Bridge pins a user's large files across **their own computers**. To do that well it has to
know **which computers exist**, **which one it is running on right now**, and — when a user owns two
similar machines — **how to tell them apart** without making the user hand-label each one.

This file is the plain-language write-up of that logic. The authoritative spec is
`pm/devices.mdx` (§1 identity, §7 fingerprint, §8 naming, §9 auto-seed). The pure logic lives in
`code/packages/shared/src/device-naming.ts`; collection lives in
`code/packages/backend/src/modules/storage/hardware.service.ts` with the model lookup in
`hardware-models.ts`.

---

## 1. The two identifiers every device has

1. **A stable random id (UUID).** Minted once on first run. It is the *durable* key — it never changes
   when hardware, the IPFS PeerID, or the nice name changes. It is stored in **two** places so it is both
   local and carried between machines:
   * `~/T/_large_files_bridge/config.yaml → computer.id` — machine-local, never travels.
   * copied into **every pinned storage's** `.lfbridge/devices/<device>.yaml` — travels via Git /
     Dropbox / Google Drive.
   Any computer answers *"which of these devices is me?"* by matching the backbone-carried `devices/*.yaml` ids
   against its own local `computer.id`.

2. **A hardware fingerprint.** The set of facts that identify the *physical machine*. Used to auto-name
   the computer and to disambiguate similar ones. Collected **entirely locally — never over the
   network.**

---

## 2. The fingerprint — what we collect

| Field | Source | Example |
| --- | --- | --- |
| `platform` | `os.platform()` | `darwin` |
| `arch` | `os.arch()` | `arm64` |
| `hostname` | `os.hostname()` | `Bryans-MacBook-Pro` |
| **`username`** | `os.userInfo().username` | `bryan` |
| **`home_dir`** | `os.homedir()` | `/Users/bryan` |
| `cpu_cores` | `os.cpus().length` | `12` |
| `ram_gb` | `os.totalmem()` | `32` |
| `disk_total_gb` | `fs.statfsSync('/')` | `1000` |
| `model_identifier` | `sysctl -n hw.model` | `Mac14,7` |
| `model_name` | `system_profiler SPHardwareDataType` | `MacBook Pro` |
| `chip` | `system_profiler SPHardwareDataType` | `Apple M2 Pro` |
| `screen_count` | `system_profiler SPDisplaysDataType` | `1` |
| `marketing_name` | model table (from `model_identifier`) | `MacBook Pro (14-inch, 2023)` |
| `year` | model table | `2023` |
| `screen_inches` | model table (built-in display) | `14` |
| `kind` | derived | `laptop` |

Notes:

* The `os`/`fs` fields are always available and need **no** subprocess.
* The `sysctl` / `system_profiler` calls are macOS-only, run best-effort with a short timeout, and are
  simply skipped (fields left blank) on other platforms or if the tool is missing.
* The **model table** turns a bare `Mac14,7` into a marketing string, a year, and a built-in screen
  size, because macOS exposes the identifier but not a clean human name. Unknown identifiers degrade
  gracefully — `marketing_name` is `""`, `year`/`screen_inches` are `null`, and the raw `model_name`
  still shows.
* **`kind`** is derived from the model: `MacBook*` → **laptop**; `Macmini` / `iMac` / `MacStudio` /
  `MacPro` → **desktop**; server mode or a headless host with no display → **server**.
* The whole fingerprint is collected once, cached in-process, and persisted to
  `config.yaml → computer.hardware`.

---

## 3. Auto-naming a fresh computer

Nobody should stare at a device called `this-computer`. On first run the default nice name is:

```
<username>-<model-slug>
```

lower-kebab-cased. Examples:

* `bryan` + `MacBook Pro` → **`bryan-macbook-pro`**
* `bryan` + `Mac Studio` → **`bryan-mac-studio`**
* unknown model → fall back to the sanitized **hostname**.

This is only the *seed*. The user can rename the computer at any time from the web app; the rename moves
the `devices/<device>.yaml` file but keeps the id.

---

## 4. Disambiguation — combine only what differs

When a user owns two similar machines (e.g. two MacBook Pros), the bare nice name collides. The rule:

> **Append only the attributes that DIFFER across the colliding machines — nothing that is the same.**

Algorithm:

1. Look at the whole set of devices shown in the table.
2. Group devices whose **base display collides** (same nice name, or same `username` + `model_name`).
3. For each colliding group, find which fingerprint attributes actually differ across its members.
4. Append those differing attributes to each label, in this fixed **priority order**, adding just enough
   to make every label in the group unique:

   1. **screen size** — `14-inch` vs `16-inch` (most human, checked first)
   2. **model year** — `2021` vs `2023`
   3. **disk size** — `512 GB` vs `1 TB`
   4. **RAM** — `16 GB` vs `32 GB`
   5. **chip** — `M1 Pro` vs `M2 Pro`
   6. **hostname** — last-resort tie-break (always unique enough)

The user's own words for the intent:

> If they have two MacBook Pros, you start to put the parts that are different. If the sizes of the hard
> drives are the same, then you don't include that. If the screen sizes are different, then you do
> include that. If the years are different but the screen sizes are the same, then you put the year in
> the title.

Worked examples:

| Machine A | Machine B | Labels |
| --- | --- | --- |
| MBP 14″ 2023 | MBP 16″ 2023 | `bryan-macbook-pro (14-inch)` · `bryan-macbook-pro (16-inch)` |
| MBP 14″ 2021 | MBP 14″ 2023 | `bryan-macbook-pro (2021)` · `bryan-macbook-pro (2023)` |
| MBP 14″ 512 GB | MBP 14″ 1 TB | `bryan-macbook-pro (512 GB)` · `bryan-macbook-pro (1 TB)` |

A device with **no** colliding twin shows its bare nice name — **no** suffix. Keep every label as short
as possible while still unique.

---

## 5. Never an empty registry

* The Devices / Peers table **always** includes **this computer**, injected from
  `config.yaml → computer` even before any storage exists. The first launch on a brand-new machine shows
  exactly one row — this one — tagged **"This computer"**.
* This computer writes its own `devices/<device>.yaml` into every storage it touches (create / index /
  pin). A storage missing the current machine's entry is healed on the next pass.

---

## 6. Git backbone

The id, nice name, fingerprint, schedule, and graft ride in the self-owned `devices/<device>.yaml`,
which is committed to the storage's Git repo (and optionally mirrored to Google Drive / Dropbox). Any
computer that pulls the storage gets the full, up-to-date array of devices. Writes are self-owned, so two
computers editing at once touch different files and never collide. Rename a computer or upgrade its disk
on one machine and the next backbone pass carries the change to every other computer's Devices / Peers table.

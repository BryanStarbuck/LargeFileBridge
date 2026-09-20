// FLEET-WIDE DELETION — the HTTP surface (pm/deletion.mdx §10, pm/cli.mdx §11.5).
//
// ONE set of routes for BOTH the CLI and the web app's "Delete everywhere…" action. cli.mdx §6 is explicit
// that the CLI is another caller of the app's own endpoints and never gets a private backdoor — which
// matters more here than anywhere else in the product, because this is the one action that reaches other
// people's computers. A CLI-only path would be a second place for the confirmation, the other-copies
// search, and the git-history warning to drift out of agreement.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { expandHome } from "../../shared/home-path.js";
import { listRepoFolders, getRepoConfig } from "../store-model/units.service.js";
import { computerLabel } from "../store-model/config.service.js";
import { readRepoTrackingManifest } from "./manifest.service.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import {
  deletionsPathForRepo,
  readDeletions,
  writeDeletions,
  emptyDeletions,
  mergeDeletions,
  toRelPosix,
} from "./deletions.service.js";
import { enforceNow } from "./deletions-apply.service.js";
import type { DeletionRecord } from "@lfb/shared";

export const deletionsRouter = Router();
deletionsRouter.use(requireAllowListed);

interface RepoView {
  folder: string;
  root: string;
}

function knownRepos(): RepoView[] {
  const out: RepoView[] = [];
  for (const folder of listRepoFolders()) {
    try {
      const cfg = getRepoConfig(folder);
      const root = expandHome(cfg.repo.path);
      if (root) out.push({ folder, root });
    } catch {
      /* a repo whose config will not load cannot be a target */
    }
  }
  return out;
}

/**
 * Which unit owns this absolute path, and what is the path RELATIVE to it.
 *
 * Longest-root-wins, because repos nest: `~/BGit/all` contains `~/BGit/all/politics`, and resolving a file
 * in the inner one to the OUTER unit would write the tombstone into a ledger no device consults for that
 * file — a deletion that silently does nothing at all.
 */
function resolveUnit(abs: string): { repo: RepoView; rel: string } | null {
  let best: { repo: RepoView; rel: string } | null = null;
  for (const repo of knownRepos()) {
    const root = path.resolve(repo.root);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    const rel = toRelPosix(path.relative(root, abs));
    if (!best || root.length > path.resolve(best.repo.root).length) best = { repo, rel };
  }
  return best;
}

/**
 * WHO DID THIS. An interactive web request carries a signed-in identity; the CLI authenticates with the
 * shared local API key, which proves possession of a 0600 file owned by this user but names no email.
 *
 * Recording an empty string there is the wrong answer: `removed_by` is half of what explains a deletion to
 * a teammate whose file vanished, and "(unrecorded)" against a destructive fleet-wide action is exactly the
 * kind of gap an audit cannot close. The OS user on this device IS who ran it, so say that, and keep the
 * shape (`someone@somewhere`) the signed-in case uses.
 */
function actorFor(req: unknown): string {
  const email = (req as { identity?: { email?: string } }).identity?.email;
  if (email) return email;
  try {
    return `${os.userInfo().username}@${computerLabel()}`;
  } catch {
    return `cli@${computerLabel()}`;
  }
}

function sha256OfFile(abs: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function canon(c: string): string {
  try {
    return canonicalCid(c);
  } catch {
    return c;
  }
}

/** Every OTHER unit whose manifest holds these same bytes (deletion.mdx §5.3). Reported, never acted on. */
function findOtherCopies(
  self: { folder: string; rel: string },
  cid: string | null,
  sha256: string | null,
): Array<{ folder: string; path: string; matchedBy: "cid" | "sha256" }> {
  const hits: Array<{ folder: string; path: string; matchedBy: "cid" | "sha256" }> = [];
  if (!cid && !sha256) return hits;
  const wantCid = cid ? canon(cid) : null;
  for (const repo of knownRepos()) {
    let files;
    try {
      files = readRepoTrackingManifest(repo.root).files;
    } catch {
      continue;
    }
    for (const f of files) {
      if (repo.folder === self.folder && toRelPosix(f.path) === toRelPosix(self.rel)) continue;
      if (wantCid && f.cid && canon(f.cid) === wantCid) {
        hits.push({ folder: repo.folder, path: f.path, matchedBy: "cid" });
      } else if (sha256 && f.sha256 && f.sha256.toLowerCase() === sha256.toLowerCase()) {
        hits.push({ folder: repo.folder, path: f.path, matchedBy: "sha256" });
      }
    }
  }
  return hits;
}

/**
 * Does this path appear in the WORKING repo's git history? (deletion.mdx §8.)
 *
 * Reported because a user deleting a sensitive file needs to know, in one sentence, AT THE MOMENT THEY ACT,
 * that deleting it here does not rewrite that history — rather than discovering it later. We never rewrite
 * history on their behalf; that is a separate, deliberate operation.
 */
async function gitHistoryCount(root: string, rel: string): Promise<number> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("git", ["-C", root, "log", "--oneline", "--", rel], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0; // not a repo, no git, or the path was never committed — all "nothing to warn about"
  }
}

const CreateBody = z.object({
  paths: z.array(z.string()).min(1),
  reason: z.string().default(""),
  scope: z.enum(["fleet", "here"]).default("fleet"),
  deleteBytes: z.boolean().default(true),
  unpin: z.boolean().default(true),
  alsoOtherCopies: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

// POST /api/pin/deletions — resolve, report, tombstone, enforce locally.
deletionsRouter.post("/", async (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const b = parsed.data;
  const device = computerLabel();
  const nowIso = new Date().toISOString();
  const results: unknown[] = [];
  // Group by unit so a multi-path delete writes each ledger ONCE — writing per path would re-read and
  // re-serialize a whole ledger for every file in a ten-file batch.
  const byUnit = new Map<string, { repo: RepoView; records: DeletionRecord[]; ledgerFile: string }>();

  try {
    for (const raw of b.paths) {
      const abs = path.resolve(expandHome(raw.trim()));
      const found = resolveUnit(abs);
      if (!found) {
        results.push({ input: raw, ok: false, error: `no Large File Bridge unit owns this path: ${abs}` });
        continue;
      }
      const { repo, rel } = found;
      let entry;
      try {
        entry = readRepoTrackingManifest(repo.root).files.find((f) => toRelPosix(f.path) === rel);
      } catch {
        entry = undefined;
      }
      // Identity, best available. The sha256 is computed from the bytes WHILE THEY ARE STILL HERE — after
      // enforcement there is nothing left to hash, and content matching (deletion.mdx §5.2) is what stops
      // the same bytes returning under a different path.
      const sha = entry?.sha256 ?? (fs.existsSync(abs) ? sha256OfFile(abs) : null);
      const cid = entry?.cid ?? null;
      const size = entry?.size ?? (fs.existsSync(abs) ? fs.statSync(abs).size : 0);

      // A PATH THAT IS NEITHER ON DISK NOR IN THE MANIFEST IS A TYPO, NOT A DELETION TARGET.
      //
      // deletion.mdx §1 requires accepting a file that is NOT on this computer — that is the whole point,
      // and it is why this cannot simply stat the path. But "not here AND not in the file list" describes
      // nothing the fleet has ever heard of, so a tombstone for it can only ever match nothing. Accepting
      // it writes a permanent, inert record into an append-only ledger that every computer then carries
      // forever. Measured the first time this ran: one shell quoting mistake put all ten paths in as a
      // single argument and produced exactly such a record.
      if (!entry && !fs.existsSync(abs)) {
        results.push({
          input: raw,
          ok: false,
          error:
            `not on this computer and not in ${repo.folder}'s file list — nothing to delete. ` +
            `Check the path (one file per argument; quote paths containing spaces).`,
        });
        continue;
      }
      const others = findOtherCopies({ folder: repo.folder, rel }, cid, sha);
      const history = await gitHistoryCount(repo.root, rel);

      const record: DeletionRecord = {
        path: rel,
        cid,
        cid_alternates: [],
        sha256: sha,
        size,
        scope: b.scope,
        reason: b.reason,
        removed_at: nowIso,
        removed_by: actorFor(req),
        removed_on_device: device,
        actions: { delete_bytes: b.deleteBytes, unpin: b.unpin },
        enforced_by: [],
        undeleted_at: null,
        undeleted_by: null,
        undelete_reason: null,
      };

      const targets: Array<{ repo: RepoView; record: DeletionRecord }> = [{ repo, record }];
      if (b.alsoOtherCopies) {
        for (const o of others) {
          const oRepo = knownRepos().find((r) => r.folder === o.folder);
          if (!oRepo) continue;
          targets.push({ repo: oRepo, record: { ...record, path: toRelPosix(o.path) } });
        }
      }
      for (const t of targets) {
        const key = t.repo.root;
        if (!byUnit.has(key)) {
          byUnit.set(key, { repo: t.repo, records: [], ledgerFile: deletionsPathForRepo(t.repo.root) });
        }
        byUnit.get(key)!.records.push(t.record);
      }

      results.push({
        input: raw,
        ok: true,
        unit: repo.folder,
        path: rel,
        cid,
        sha256: sha,
        size,
        scope: b.scope,
        inManifest: !!entry,
        onDiskHere: fs.existsSync(abs),
        otherCopies: others,
        gitHistoryCommits: history,
      });
    }

    if (b.dryRun) {
      return res.json({ ok: true, data: { dryRun: true, device, results, enforced: null } });
    }

    // Write each unit's ledger, then enforce here and now — waiting for the next scheduled pass would leave
    // the bytes sitting on disk for up to fifteen minutes after the user was told the file was deleted.
    const enforced: unknown[] = [];
    for (const [, unit] of byUnit) {
      let ledger;
      try {
        ledger = readDeletions(unit.ledgerFile);
      } catch (e) {
        // Refuse rather than start a fresh ledger over an unreadable one: that would silently discard every
        // tombstone already in it and un-delete every file they name.
        enforced.push({ unit: unit.repo.folder, ok: false, error: (e as Error).message });
        continue;
      }
      const merged = mergeDeletions(ledger, { ...emptyDeletions(), deletions: unit.records });
      writeDeletions(unit.ledgerFile, merged);
      try {
        enforced.push({ unit: unit.repo.folder, ok: true, ...(await enforceNow(unit.repo.root)) });
      } catch (e) {
        // The instruction STANDS even when this device could not carry it out — the tombstone is written and
        // every other device still enforces it. The failure is reported, never swallowed.
        enforced.push({ unit: unit.repo.folder, ok: false, error: (e as Error).message });
      }
    }
    res.json({ ok: true, data: { dryRun: false, device, results, enforced } });
  } catch (e) {
    log.error("pin", `deletions create failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/pin/deletions?path=… — the ledger plus the enforcement matrix (deletion.mdx §7.5).
deletionsRouter.get("/", async (req, res) => {
  const q = z.object({ path: z.string().optional(), pending: z.coerce.boolean().optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ ok: false, error: q.error.message });
  try {
    const repos = q.data.path
      ? (() => {
          const abs = path.resolve(expandHome(q.data.path!.trim()));
          const f = resolveUnit(abs);
          return f ? [f.repo] : [];
        })()
      : knownRepos();
    const units: unknown[] = [];
    for (const repo of repos) {
      let ledger;
      try {
        ledger = readDeletions(deletionsPathForRepo(repo.root));
      } catch (e) {
        units.push({ unit: repo.folder, error: (e as Error).message });
        continue;
      }
      if (ledger.deletions.length === 0) continue;
      // EVERY device the manifest has ever heard of — so a device that has NOT reported is visible as a
      // gap rather than simply absent from the list. "Not reported" is the honest answer to "is it gone
      // everywhere yet"; an implicit omission reads as "done" and would be a lie (deletion.mdx §7.5).
      const fleet = new Set<string>([computerLabel()]);
      try {
        for (const f of readRepoTrackingManifest(repo.root).files) for (const d of f.pinned_by) fleet.add(d);
      } catch {
        /* no manifest — the fleet is just us */
      }
      const rows = ledger.deletions
        .map((r) => {
          const reported = new Set(r.enforced_by.map((e) => e.device));
          return {
            path: r.path,
            cid: r.cid,
            sha256: r.sha256,
            scope: r.scope,
            reason: r.reason,
            removed_at: r.removed_at,
            removed_by: r.removed_by,
            removed_on_device: r.removed_on_device,
            active: !r.undeleted_at,
            undeleted_at: r.undeleted_at,
            enforced_by: r.enforced_by,
            notReported: [...fleet].filter((d) => !reported.has(d)).sort(),
          };
        })
        .filter((r) => (q.data.pending ? r.active && r.notReported.length > 0 : true));
      if (rows.length > 0) units.push({ unit: repo.folder, deletions: rows });
    }
    res.json({ ok: true, data: { device: computerLabel(), units } });
  } catch (e) {
    log.error("pin", `deletions list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/pin/deletions/undelete — lift one (deletion.mdx §12). A SEPARATE route, never a flag on create.
deletionsRouter.post("/undelete", async (req, res) => {
  const b = z.object({ path: z.string(), reason: z.string().default("") }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ ok: false, error: b.error.message });
  try {
    const abs = path.resolve(expandHome(b.data.path.trim()));
    const found = resolveUnit(abs);
    if (!found) return res.status(404).json({ ok: false, error: `no unit owns this path: ${abs}` });
    const file = deletionsPathForRepo(found.repo.root);
    const ledger = readDeletions(file);
    const hits = ledger.deletions.filter((r) => toRelPosix(r.path) === found.rel && !r.undeleted_at);
    if (hits.length === 0) return res.status(404).json({ ok: false, error: `no active tombstone for ${found.rel}` });
    const nowIso = new Date().toISOString();
    for (const r of hits) {
      // DEACTIVATE, never erase — "deleted, then restored, by whom, and why" is exactly what an audit needs,
      // and erasing the record is how a deletion silently un-happens (deletion.mdx §12).
      r.undeleted_at = nowIso;
      r.undeleted_by = actorFor(req);
      r.undelete_reason = b.data.reason;
    }
    writeDeletions(file, ledger);
    // NOTHING IS FETCHED. The file returns to being a pull-down OFFER and the user pulls it if they want it.
    // Lifting a deletion must not itself be a surprise re-publication.
    res.json({ ok: true, data: { unit: found.repo.folder, path: found.rel, lifted: hits.length, refetched: false } });
  } catch (e) {
    log.error("pin", `undelete failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

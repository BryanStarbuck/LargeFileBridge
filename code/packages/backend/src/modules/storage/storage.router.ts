// REST for the Storages tab/page (storages.mdx §2). Discovery + descriptor + per-storage index/analyze.
// Allow-list-gated like every data route.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import {
  listStoragesPage,
  getStorageDetail,
  initStorageById,
  indexStorageById,
  analyzeStorageFile,
  readBookmarks,
  setBookmark,
} from "./storage.service.js";
import { readStorageSettings, writeStorageSettings, getMappedDirsView, patchMappedDirs } from "./storage-settings.service.js";

export const storagesRouter = Router();
storagesRouter.use(requireAllowListed);

// The per-storage settings PATCH payload (storage_settings.mdx §5). All fields optional (partial update).
const BackingPatch = z.object({ enabled: z.boolean(), path: z.string().nullable() }).partial();
const StorageSettingsPatch = z.object({
  synced: z.boolean().optional(),
  lfbridge: z.object({ enabled: z.boolean(), path: z.string().nullable() }).partial().optional(),
  backing: z
    .object({
      dedicatedRepo: BackingPatch.optional(),
      googleDrive: BackingPatch.optional(),
      dropbox: BackingPatch.optional(),
    })
    .partial()
    .optional(),
});

// GET /api/storages — the Storages page payload (local + personal + companies + communities + repos link).
storagesRouter.get("/", (_req, res) => {
  try {
    res.json({ ok: true, data: listStoragesPage() });
  } catch (e) {
    log.error("storage", `listStoragesPage failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/storages/:id — one storage's descriptor + tracked files.
storagesRouter.get("/:id", (req, res) => {
  try {
    res.json({ ok: true, data: getStorageDetail(req.params.id) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/storages/:id/init — create storage.yaml + .lfbridge/ for a detected candidate (storages.mdx §3–§4).
storagesRouter.post("/:id/init", (req, res) => {
  try {
    res.json({ ok: true, data: initStorageById(req.params.id) });
  } catch (e) {
    log.warn("storage", `init ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/storages/:id/index — (re)build the per-file fingerprint index (storages.mdx §4.1).
storagesRouter.post("/:id/index", (req, res) => {
  try {
    res.json({ ok: true, data: indexStorageById(req.params.id) });
  } catch (e) {
    log.warn("storage", `index ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/storages/:id/settings — the machine-local per-storage settings (storage_settings.mdx §5).
storagesRouter.get("/:id/settings", (req, res) => {
  try {
    res.json({ ok: true, data: readStorageSettings(req.params.id) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/storages/:id/settings — update the local config (+ canonical clones in storage.yaml, §5).
storagesRouter.patch("/:id/settings", async (req, res) => {
  const patch = StorageSettingsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  try {
    res.json({ ok: true, data: await writeStorageSettings(req.params.id, patch.data) });
  } catch (e) {
    log.warn("storage", `settings ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/storages/:id/mapped-dirs — the shared mapped-directory list joined with this device's graft
// (storage_settings.mdx §4a). Editable only for company/personal; repo shows its working tree read-only.
storagesRouter.get("/:id/mapped-dirs", async (req, res) => {
  try {
    res.json({ ok: true, data: await getMappedDirsView(req.params.id) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/storages/:id/mapped-dirs — replace the shared list (add/remove rows) and/or set this
// device's per-row graft path (storage_settings.mdx §4a).
const MappedDirsPatch = z.object({
  mapped: z
    .array(
      z.object({
        key: z.string().optional(),
        label: z.string().optional(),
        canonical: z.string().nullable().optional(),
        recursive: z.boolean().optional(),
      }),
    )
    .optional(),
  graft: z.record(z.string(), z.string().nullable()).optional(),
});
storagesRouter.patch("/:id/mapped-dirs", async (req, res) => {
  const patch = MappedDirsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  try {
    res.json({ ok: true, data: await patchMappedDirs(req.params.id, patch.data) });
  } catch (e) {
    log.warn("storage", `mapped-dirs ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/storages/:id/bookmarks — the storage's bookmarked relpaths (syncable_data_location.mdx §4.4).
storagesRouter.get("/:id/bookmarks", (req, res) => {
  try {
    res.json({ ok: true, data: readBookmarks(req.params.id) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/storages/:id/bookmarks — set/clear one bookmark (body {path, on}).
storagesRouter.post("/:id/bookmarks", async (req, res) => {
  const body = z.object({ path: z.string().min(1), on: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path and on required" });
  try {
    res.json({ ok: true, data: await setBookmark(req.params.id, body.data.path, body.data.on) });
  } catch (e) {
    log.warn("storage", `bookmark ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/storages/:id/analyze — queue media analysis for one file (storages.mdx §6).
storagesRouter.post("/:id/analyze", (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: analyzeStorageFile(req.params.id, body.data.path) });
  } catch (e) {
    log.warn("storage", `analyze ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

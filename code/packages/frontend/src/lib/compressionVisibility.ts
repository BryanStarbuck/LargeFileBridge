// The pure rules behind the per-user "Show compression features" setting (compression_visibility.mdx §2).
// When the setting is OFF (the default) every compression surface except context menus is hidden; each
// surface asks one of these helpers what to drop, so "what counts as compression" is decided in ONE place.
// Pure TS — no React — so it is unit-tested in compressionVisibility.spec.ts. The live on/off comes from
// useCompressionEnabled() in api/useUserPrefs.ts.
import type { FsBadge, TodoBatchDetail, TodoBatchPattern, TodoBatchSummary, TodoCategory } from "@lfb/shared";
import type { MetricId } from "../pages/repos/metricWarnings.js";
import type { FileFilterFieldId } from "../components/table/fileFilter.js";
import type { WarningPopupSpec } from "../components/ui/warnings/registry.js";

/** The One-repo metric tiles that exist only to advertise compression (§2 row 2). */
const COMPRESSION_METRICS: ReadonlySet<MetricId> = new Set<MetricId>([
  "compressibleVideos",
  "compressibleImages",
  "alreadyCompressed",
]);
export const isCompressionMetric = (id: MetricId): boolean => COMPRESSION_METRICS.has(id);

/** The §2.11 Filter-dropdown fields that belong to compression (§2 row 8). */
const COMPRESSION_FILTER_FIELDS: ReadonlySet<FileFilterFieldId> = new Set<FileFilterFieldId>([
  "compressible_videos",
  "compressible_images",
  "compressible_audio",
]);
export const isCompressionFilterField = (id: FileFilterFieldId): boolean => COMPRESSION_FILTER_FIELDS.has(id);

/** Drop the compressible fields from a filter-field list when compression is hidden. Works on bare ids
 *  (`FileFilterFieldId[]`) and on `{ id, … }` field specs alike. Returns the SAME array when shown. */
export function withoutCompressionFields<F extends FileFilterFieldId | { id: FileFilterFieldId }>(
  fields: F[],
  compressionOn: boolean,
): F[] {
  if (compressionOn) return fields;
  return fields.filter((f) => !isCompressionFilterField(typeof f === "string" ? f : f.id));
}

/** The C (compress) and c (compressed) code badges (§2 row 11). */
const COMPRESSION_BADGES: ReadonlySet<FsBadge> = new Set<FsBadge>(["compress", "compressed"]);

/** The badges to render. Returns the SAME array when compression is shown, so memoized rows stay stable. */
export function visibleBadges(badges: FsBadge[], compressionOn: boolean): FsBadge[] {
  if (compressionOn || !badges.some((b) => COMPRESSION_BADGES.has(b))) return badges;
  return badges.filter((b) => !COMPRESSION_BADGES.has(b));
}

/**
 * An educate-and-fix popup with compression taken out (§2 row 9): the per-row Compress axis is removed, a
 * row whose ONLY action was Compress is dropped (it would otherwise sit in the list with no toggle at all),
 * and any option named "compress" (the Pull-down popup's "Compress once the bytes arrive") is removed.
 * Returns the SAME spec when compression is shown or nothing in it is about compression.
 */
export function stripCompressionFromPopup(popup: WarningPopupSpec, compressionOn: boolean): WarningPopupSpec {
  if (compressionOn) return popup;
  const hasCompressOption = (popup.options ?? []).some((o) => o.kind === "checkbox" && o.name === "compress");
  const hasCompressAxis = (popup.targets ?? []).some((t) => t.axes?.compress !== undefined);
  if (!hasCompressOption && !hasCompressAxis) return popup;
  const targets = popup.targets?.flatMap((t) => {
    if (!t.axes || t.axes.compress === undefined) return [t];
    const { compress: _drop, ...rest } = t.axes;
    return Object.keys(rest).length ? [{ ...t, axes: rest }] : [];
  });
  const options = popup.options?.filter((o) => !(o.kind === "checkbox" && o.name === "compress"));
  return { ...popup, targets, options };
}

/** The To Do categories that belong to compression (§2 row 10). */
const COMPRESSION_TODO: ReadonlySet<TodoCategory> = new Set<TodoCategory>(["compress_video", "compress_image"]);

// When a batch loses its compress categories, its slug template must come from what is left.
const PATTERN_FOR: Record<TodoCategory, TodoBatchPattern> = {
  compress_video: "compress",
  compress_image: "compress",
  git_ignore: "git_ignore",
  pin: "pin",
  pull_down: "pull_down",
  transcribe_video: "transcribe",
  transcribe_audio: "transcribe",
};

/**
 * A To Do batch with its compress work removed (§2 row 10), or null when nothing is left to show. Compress
 * totals and items are dropped, `recommend.compress` is cleared on the remaining items, and a batch whose
 * pattern was "compress" re-derives its pattern from the categories that remain. Returns the SAME batch
 * when compression is shown or the batch has no compress work.
 */
export function todoBatchWithoutCompression<B extends TodoBatchSummary | TodoBatchDetail>(
  batch: B,
  compressionOn: boolean,
): B | null {
  if (compressionOn) return batch;
  const cats = Object.keys(batch.totals) as TodoCategory[];
  const items = "items" in batch ? batch.items : undefined;
  const touchesCompress =
    cats.some((c) => COMPRESSION_TODO.has(c)) ||
    batch.pattern === "compress" ||
    (items ?? []).some((it) => COMPRESSION_TODO.has(it.category) || it.recommend?.compress !== undefined);
  if (!touchesCompress) return batch;

  const totals: TodoBatchSummary["totals"] = {};
  for (const c of cats) if (!COMPRESSION_TODO.has(c) && batch.totals[c]) totals[c] = batch.totals[c];
  const left = Object.keys(totals) as TodoCategory[];
  if (left.length === 0) return null;

  let pattern = batch.pattern;
  if (pattern === "compress") {
    const patterns = new Set(left.map((c) => PATTERN_FOR[c]));
    pattern = patterns.size === 1 ? [...patterns][0] : "mixed";
  }
  const out = { ...batch, totals, pattern };
  if (items) {
    (out as TodoBatchDetail).items = items
      .filter((it) => !COMPRESSION_TODO.has(it.category))
      .map((it) => {
        if (it.recommend?.compress === undefined) return it;
        const { compress: _drop, ...recommend } = it.recommend;
        return { ...it, recommend };
      });
  }
  return out;
}

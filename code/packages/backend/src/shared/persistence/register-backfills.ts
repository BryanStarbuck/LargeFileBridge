// THE ORDERED BACKFILL REGISTRATION, in ONE place.
//
// It used to live inline in `backfill-cli.ts`, which meant the CLI was the only caller that could run the
// areas and the ORDER — which is load-bearing, because registration order IS run order and half these areas
// have a NOT NULL FK onto what an earlier one produces — existed in exactly one function. Boot now runs the
// same set, so the order has to be shared rather than transcribed; a second copy that drifted by one line
// would fail as a foreign-key violation on a cold machine and nowhere else.
import { registerUnitBackfills } from "../../modules/store-model/unit-backfill.js";
import { registerFileBackfills } from "../../modules/store-model/file-backfill.js";
import { registerDecisionBackfills } from "../../modules/storage/decision-backfill.js";
import { registerManifestBackfills } from "../../modules/pin/manifest-backfill.js";
import { registerForeignPinBackfill } from "../../modules/ipfs/foreign-pin-backfill.js";
import { registerSidecarBackfills } from "../../modules/storage/sidecar-backfill.js";
import { registerBatchBackfill } from "../../modules/jobqueue/batch-backfill.js";
import { registerHistoryBackfill } from "../../modules/storage/history-backfill.js";
import { registerBaselineBackfill } from "../../modules/compress/baseline-backfill.js";

let registered = false;

/** Register every backfill area, once per process, in dependency order. Idempotent. */
export function registerAllBackfills(): void {
  if (registered) return;
  registered = true;
registerUnitBackfills();
// AFTER the unit areas, always: every area-3 scope opens by resolving a `unit_id` from its pin folder,
// and registration order IS run order (backfill.ts `registerBackfill`).
registerFileBackfills();
// AFTER the units. `decision_event.unit_id` is NOT NULL and REFERENCES `lfb.unit`, so a decision scope
// whose repo has not been adopted yet has nowhere to put its events — registration order IS the run
// order (`runAllBackfills`), and this is what makes a single cold run land both.
registerDecisionBackfills();
// AFTER the units too. `manifest_entry.unit_id` and `pin_claim.device_id` are FKs into what areas 1 and 2
// produce, so a manifest scope run first would have nowhere to put a single row. Area 10 (`cid_alias`)
// rides along with it — it has no unit FK, but it shares `lfb.cid` with the manifests.
registerManifestBackfills();
// Area 9 (foreign pins + the probe cache). It has no REQUIRED ordering — `foreign_pin.unit_id` is
// nullable, since a pin can be discovered outside every unit — but running it after the unit areas means a
// single cold run gets the unit ids attached instead of leaving them NULL until the next pass.
registerForeignPinBackfill();
// Areas 6 and 7 (sidecars, then the artifact index). AFTER the units for the same reason as the rest —
// `file.unit_id` REFERENCES `lfb.unit`, and `file_event` / `file_artifact` in turn reference `lfb.file` —
// and after area 1 too, because every sidecar event joins to a `device` and a `person`.
registerSidecarBackfills();
// Area 8 (history). AFTER areas 1 AND 2: `history_entry.unit_id` and `.device_id` are both NOT NULL FKs
// into what `adopt_units` and `adopt_devices` produce, and a history file whose device has no row is a
// reject rather than a row.
registerHistoryBackfill();
// Area 11 (the charter's learned compression baseline). AFTER area 2 for `compression_record.unit_id`.
// It is the only area that spawns a subprocess per file (one ffprobe, ~27 ms measured) and hashes whole
// media files (450 MB / 0.19 s measured), so it goes late — nothing else waits behind it if a file on a
// cold cloud mount makes a probe slow.
registerBaselineBackfill();
// Area 12 (the `_batches/*.yaml` projection). NO ordering requirement — `batch_manifest` / `batch_item`
// have no FK onto anything an earlier area produces, because a batch's scope is a list of absolute paths
// that routinely spans repos and may name files in no registered repo at all. Last, so the run order reads
// the way the plan lists the areas.
registerBatchBackfill();
}

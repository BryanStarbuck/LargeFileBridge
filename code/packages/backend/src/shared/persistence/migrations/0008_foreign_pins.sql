-- ============================================================================
-- 0008_foreign_pins — foreign-pins.json and foreign-pin-cache.json become rows.
--
-- Independently shippable and independently valuable (database.mdx §9 slice 8): it
-- retires 8.47 MB of RESIDENT JSON and the 40,000-entry eviction cap, and it touches only
-- modules/ipfs. The 4 GB RSS incident of 2026-07-20 was a whole-file rewrite of exactly
-- this cache (database.mdx §1.1).
-- ============================================================================

-- foreign-pins.json — 2,825 records measured. Keyed by ABS PATH because a foreign pin can
-- be discovered for a file OUTSIDE any unit, so (unit_id, rel_posix) is not available as
-- an identity here.
CREATE TABLE {{S}}.foreign_pin (
  abs_path   text PRIMARY KEY,
  cid_text   text NOT NULL,
  cid_canon  text NOT NULL REFERENCES {{S}}.cid(cid_canon) ON DELETE CASCADE,
  profile    text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  unit_id    bigint REFERENCES {{S}}.unit(unit_id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

-- foreign-pin-cache.json — 36,045 entries / 7.19 MB measured, of which 33,099 are
-- NEGATIVE (cid IS NULL). THE NEGATIVES ARE THE POINT: they are what stops re-hashing a
-- file we have already hashed and found unpinned. The key is fpKey() split back apart
-- (foreign-pin.service.ts:55).
CREATE TABLE {{S}}.fingerprint_probe (
  abs_path   text   NOT NULL,
  size_bytes bigint NOT NULL,
  mtime_ms   bigint NOT NULL,
  cid_text   text,                               -- NULL = hashed and not pinned
  profile    text,
  probed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (abs_path, size_bytes, mtime_ms)
);
-- That PK IS fpKey() split apart, and it is the only lookup discoverForeignPin makes.

CREATE INDEX foreign_pin_canon ON {{S}}.foreign_pin (cid_canon);
--   SERVES: foreignPinByCanonicalCid — today a linear scan of 2,825 records.

CREATE INDEX foreign_pin_unit ON {{S}}.foreign_pin (unit_id) WHERE unit_id IS NOT NULL;
--   SERVES: foreignPinPathSet() per unit — today a full 2,825-record Set rebuild once per
--   unit, i.e. 105 rebuilds per Repos-list composition.

CREATE INDEX fingerprint_probe_age ON {{S}}.fingerprint_probe (probed_at);
--   SERVES: eviction. Replaces CACHE_MAX_ENTRIES=40,000 plus an O(n log n) key sort with
--   `DELETE WHERE probed_at < (SELECT probed_at FROM ... ORDER BY probed_at DESC OFFSET
--   200000 LIMIT 1)` — and lets the cap RISE, because the cap only ever existed because
--   the whole file had to be resident in the heap.

-- ============================================================================
-- 0007_manifest_and_pins — the pin plane: the manifest, the exploded pin claims with
-- their origin guard, this node's real pinset, and the CID alias map.
--
-- The correctness area this migration exists to close is the one the foreign-pin work
-- keeps reopening (MEMORY.md, "foreign pin: recorded must render"):
--   "PINNED" MEANS PINNED ON THIS COMPUTER BY ANY LOCAL SOFTWARE. A PEER'S CLAIM IS
--   NEVER PINNED-HERE.
-- Here that stops being discipline and becomes a database invariant.
-- ============================================================================

-- The repo manifest. ONE table serving BOTH on-disk copies —
-- repos/<key>/manifest.yaml (the wire receive point) and pin/r/<folder>/manifest.yaml
-- (local pin state). They are NOT a redundant twin to be collapsed: pin.service.ts:793
-- gates the tracking copy behind `publish_manifest`, and pin.service.ts:768-770
-- deliberately keeps the unit copy off the wire so mergeManifests has two operands.
-- `stage` preserves that, so collapsing them cannot start publishing a manifest the user
-- opted out of (database.mdx §4.1).
CREATE TABLE {{S}}.manifest_entry (
  unit_id     bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  stage       text   NOT NULL CHECK (stage IN ('unit','tracking')),
  rel_path    text   NOT NULL,
  rel_posix   text   GENERATED ALWAYS AS (replace(rel_path, '\', '/')) STORED,
  cid_text    text,                              -- verbatim, never locally rewritten
  cid_canon   text REFERENCES {{S}}.cid(cid_canon) ON DELETE SET NULL,
  size_bytes  bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256      text,
  modified_at timestamptz,
  PRIMARY KEY (unit_id, stage, rel_posix)
);
-- The PK (unit_id, stage, rel_posix) SERVES the per-entry merge and the re-render, both
-- of which are always stage-scoped.

-- `pinned_by` exploded. `origin` is NOT decoration: manifest-merge.ts:123-128,157 merges
-- the two halves ASYMMETRICALLY — our own label comes ONLY from the local pin pass, every
-- peer's label passes through from the wire unchanged. A pure INSERT..ON CONFLICT DO
-- NOTHING union re-adopts a claim this computer WITHDREW, which is the exact defect that
-- produced 77% of one day's commits.
CREATE TABLE {{S}}.pin_claim (
  unit_id    bigint NOT NULL,
  stage      text   NOT NULL CHECK (stage IN ('unit','tracking')),
  rel_posix  text   NOT NULL,
  device_id  smallint NOT NULL REFERENCES {{S}}.device(device_id) ON DELETE CASCADE,
  origin     {{S}}.claim_origin NOT NULL,
  cid_canon  text REFERENCES {{S}}.cid(cid_canon) ON DELETE SET NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, stage, rel_posix, device_id),
  FOREIGN KEY (unit_id, stage, rel_posix)
    REFERENCES {{S}}.manifest_entry(unit_id, stage, rel_posix) ON DELETE CASCADE
  -- THE ASYMMETRY IS ENFORCED BY `lfb_pin_claim_guard` BELOW, NOT BY A CHECK.
  -- The design draft carried an inline placeholder CHECK here to keep the intent visible
  -- in `\d`. It is NOT SHIPPED, because it could never have worked: a CHECK constraint
  -- may not contain a subquery, and the rule it wants to state — "a claim naming a device
  -- whose device.is_self is true may only have origin='local'" — is about ANOTHER TABLE.
  -- Postgres rejects the placeholder outright with "cannot use subquery in check
  -- constraint", so the file would not apply. database.mdx §8.5 records the open choice:
  -- leave enforcement in the trigger (done here) or denormalize device.is_self onto this
  -- table as a generated column so a real CHECK becomes expressible.
);

-- This node's actual pinset (`ipfs pin ls`), refreshed by the pin pass. Truth about THIS
-- computer only; a peer's pin is never pinned-here.
CREATE TABLE {{S}}.local_pin (
  cid_canon  text PRIMARY KEY REFERENCES {{S}}.cid(cid_canon) ON DELETE CASCADE,
  cid_text   text NOT NULL,
  pin_type   {{S}}.pin_type NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

-- cid_equivalence.yaml (58 pairs) + superseded_cids.yaml (16) unified. BOTH stay
-- MACHINE-LOCAL — scopes.ts:12-20 says putting them in the SDL "is what made two machines
-- rewrite each other's manifest forever". `superseded` additionally has an EXPORT leg into
-- <sdl>/devices/<self>.yaml, which keeps its YAML writer (writeSelfDevice).
CREATE TABLE {{S}}.cid_alias (
  alias_canon  text PRIMARY KEY,
  target_canon text NOT NULL REFERENCES {{S}}.cid(cid_canon) ON DELETE CASCADE,
  kind         {{S}}.alias_kind NOT NULL,
  proof        text NOT NULL,                    -- 'resolveFileCid' | 'rehash' | 'peer'
  proved_by    smallint REFERENCES {{S}}.device(device_id) ON DELETE SET NULL,
  proved_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cid_alias_not_self CHECK (alias_canon <> target_canon)
);

-- ── the origin guard ────────────────────────────────────────────────────────
-- Enforces the manifest-merge asymmetry as a constraint rather than as discipline: a
-- claim naming THIS computer may only be written with origin='local'.
CREATE FUNCTION {{S}}.pin_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE self boolean;
BEGIN
  SELECT is_self INTO self FROM {{S}}.device WHERE device_id = NEW.device_id;
  IF self AND NEW.origin <> 'local' THEN
    RAISE EXCEPTION 'pin_claim: a claim about this computer may only originate locally (ipfs.mdx 1.1)';
  END IF;
  RETURN NEW;
END $guard$;

CREATE TRIGGER lfb_pin_claim_guard BEFORE INSERT OR UPDATE ON {{S}}.pin_claim
  FOR EACH ROW EXECUTE FUNCTION {{S}}.pin_claim_guard();

-- ── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX manifest_cid ON {{S}}.manifest_entry (cid_canon) WHERE cid_canon IS NOT NULL;
--   SERVES: buildTrackedIndex's cid->file map (ipfs-page.service.ts:48) — today a parse of
--   every repo's manifest on every IPFS-page load.

CREATE INDEX pin_claim_device ON {{S}}.pin_claim (device_id, unit_id);
--   SERVES: the Devices page ("what does peer X hold") and the withdrawal audit.
--   MEASURED: GROUP BY device over the real 22,221 claims = 2.66 ms via an index-only
--   scan; the same question today is an all-manifest walk.

CREATE INDEX pin_claim_self ON {{S}}.pin_claim (unit_id, stage, rel_posix)
  WHERE origin = 'local';
--   SERVES: `transferFor` (units.service.ts:977) — "is this pinned on THIS computer by
--   us" — and the pin pass's DELETE-then-reinsert of our own claims, which is the
--   WITHDRAWAL a pure union cannot express.

CREATE INDEX cid_alias_target ON {{S}}.cid_alias (target_canon);
--   SERVES: the reverse audit (reconciler auditCidEquivalences), today a walk of the whole
--   in-memory map. The PK (alias_canon) serves pinsetHasContent / supersededCid, both
--   called per manifest entry inside the reconciler's walk.

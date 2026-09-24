-- THE SECOND HASH FOR TRANSPARENT IMAGES (perceptual_fingerprint.mdx §FD.1).
--
-- A PNG with see-through pixels (a macOS window screenshot's shadow, a logo) has no single appearance:
-- one tool flattens it onto white, the next onto black. Measured: a white-only hash missed every
-- black-flattened copy (median 64 of 256 bits apart). The engine now stores the white-background hash in
-- `value` and the black-background hash here, and matching takes the nearer of the two.
--
-- NULL for every video and for every opaque image. A separate migration rather than an edit to 0018
-- because 0018 may already be applied on another computer (the tree is committed continuously), and the
-- runner checksums applied migrations.
ALTER TABLE {{S}}.perceptual_fp
  ADD COLUMN IF NOT EXISTS value_alt text CHECK (value_alt IS NULL OR value_alt ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS perceptual_fp_value_alt ON {{S}}.perceptual_fp (value_alt) WHERE value_alt IS NOT NULL;

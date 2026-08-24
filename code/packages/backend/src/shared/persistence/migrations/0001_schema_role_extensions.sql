-- ============================================================================
-- 0001_schema_role_extensions — the schema and the two extensions. Nothing else.
--
-- Large File Bridge keeps its machine-local state in PostgreSQL 16 (verified on
-- 16.15 Homebrew: listen_addresses=localhost, ssl=off, bound only to 127.0.0.1:5432
-- and [::1]:5432 — the loopback posture database.mdx §7.1 asserts at boot).
-- Database `largefilebridge`, role `lfb`, schema `lfb`.
--
-- `{{S}}` is the schema-name placeholder. The runner substitutes it before it
-- executes anything (migrate.ts `render()`, which rewrites /\{\{S\}\}/g to
-- `DB_SCHEMA`, itself `LFB_DB_SCHEMA` or the default `lfb` — pool.ts:10). NEVER
-- hard-code `lfb` in a migration: the test harness and a future multi-tenant server
-- both point `DB_SCHEMA` somewhere else, and a hard-coded reference would silently
-- write into the wrong schema rather than fail.
--
-- SHIPPABLE ALONE (database.mdx §9 slice 1-2): after this migration the app boots,
-- finds an empty ledger, applies nothing else, and runs on YAML exactly as it does
-- today. Zero readers, zero writers, zero behaviour change.
--
-- WHY `{{S}}.schema_migration` IS NOT CREATED HERE, even though database.mdx §4
-- lists it under this migration: the runner creates the ledger ITSELF, before it can
-- read it, under `pg_advisory_lock(2306411)` — migrate.ts `LEDGER_DDL`, executed at
-- the top of `runSchemaMigrations()` prior to the SELECT that lists applied names. A
-- duplicate `CREATE TABLE IF NOT EXISTS` here would be harmless; a duplicate
-- DEFINITION that drifts from `LEDGER_DDL` would not be, and there is no mechanism
-- that would ever tell us the two had diverged. One definition, in the runner.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS {{S}};

-- Both extensions are installed INTO `{{S}}`, not into `public`, so the whole
-- installation is one droppable unit and nothing depends on `public` being present
-- or writable. Every later reference is schema-qualified to match
-- (`{{S}}.citext`, `{{S}}.gin_trgm_ops`) so a migration does not depend on the
-- caller's search_path — psql, the pool (`-c search_path={{S}},public`, pool.ts:134)
-- and a `just db-psql` session all behave identically.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA {{S}};   -- verified available: pg_trgm 1.6
CREATE EXTENSION IF NOT EXISTS citext  WITH SCHEMA {{S}};   -- verified available: citext 1.6

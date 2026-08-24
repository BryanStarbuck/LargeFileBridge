// THE LOOPBACK DECISION AND THE POOL SHAPE (database.mdx §7, §7.1).
//
// The centre of gravity here is `isLoopbackDatabaseUrl`. It is not a formatting helper — it is the single
// predicate that decides whether TLS is turned OFF for a connection, so a wrong answer in the permissive
// direction sends a database password across a network in the clear. The sister app shipped exactly that bug
// (pool.ts:78-82): a regex over the WHOLE connection string, which a remote URL whose *password* contained
// `@localhost:` satisfied. These tests pin the parsed-not-matched, fail-closed behaviour so that regression
// cannot come back quietly.
//
// Everything else in this file guards the properties a reviewer would otherwise have to take on trust: that
// off-loopback keeps certificate verification on, that `search_path` and `statement_timeout` actually reach
// the server, and that no code path can put a live password into a log line.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DB_SCHEMA,
  LOCAL_DEV_DATABASE_URL,
  POOL_MAX,
  buildPoolConfig,
  isLoopbackDatabaseUrl,
  listenAddressesAreLoopbackOnly,
  resolveDbMode,
  safeUrl,
} from "./pool.js";
import { log } from "../logging.js";

afterEach(() => {
  // Env is process-global and these tests deliberately move LFB_DB_* around. Without this, a stubbed
  // LFB_DB_MODE=off would leak into every spec that runs after this file in the same worker and silently
  // change what `getPool()` returns for them.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isLoopbackDatabaseUrl — the TLS decision, and it must FAIL CLOSED (database.mdx §7.1)", () => {
  it("REJECTS a remote host whose PASSWORD contains '@localhost:' — the sister app's exact bug", () => {
    // THE regression test of this file. `/@(localhost|127\.0\.0\.1|\[::1\])[:/]/` over the raw string matches
    // inside the userinfo of this URL, so the sister app disabled TLS on a connection to db.example.com. The
    // host here is db.example.com and nothing else may be consulted, so the answer is false and TLS stays on.
    const attack = "postgresql://u:p%40localhost%3A5432@db.example.com/x";
    expect(new URL(attack).hostname).toBe("db.example.com"); // states the premise the assertion rests on
    expect(isLoopbackDatabaseUrl(attack)).toBe(false);
  });

  it("also rejects the un-encoded variant of the same shape", () => {
    // A password may legally carry `@` and `:` un-encoded in the string a user pastes; URL parsing takes the
    // LAST `@` as the userinfo delimiter, so the host is still remote. A pattern search cannot tell.
    expect(isLoopbackDatabaseUrl("postgresql://u:pass@localhost:5432@db.example.com:5432/x")).toBe(false);
  });

  it("accepts the three loopback spellings, so the local fast path still works", () => {
    // If this were over-strict the localhost default would demand TLS from a server that has none, and
    // `just db-up` would stop working on a fresh machine — the failure mode §7.2 exists to prevent.
    expect(isLoopbackDatabaseUrl("postgresql://lfb:lfb@localhost:5432/largefilebridge")).toBe(true);
    expect(isLoopbackDatabaseUrl("postgresql://lfb:lfb@127.0.0.1:5432/largefilebridge")).toBe(true);
    // REGRESSION (found by this spec): `URL.hostname` KEEPS the brackets on an IPv6 literal — it returns
    // `[::1]`, not `::1` (node v26.7.0). The original comparison was written against the unbracketed form,
    // so this URL answered false and demanded TLS from a local server that has none. Safe direction, real
    // breakage. Assert through the bracketed form a human actually types into postgresql.conf.
    expect(isLoopbackDatabaseUrl("postgresql://lfb:lfb@[::1]:5432/largefilebridge")).toBe(true);
  });

  it("accepts the long-form IPv6 loopback, which the parser normalises to [::1]", () => {
    expect(new URL("postgresql://lfb:lfb@[0:0:0:0:0:0:0:1]:5432/x").hostname).toBe("[::1]"); // the premise
    expect(isLoopbackDatabaseUrl("postgresql://lfb:lfb@[0:0:0:0:0:0:0:1]:5432/largefilebridge")).toBe(true);
  });

  it("does not let the bracket-stripping turn a REMOTE ipv6 host into loopback", () => {
    // The fix strips `[` and `]` before comparing. That must not become a general loosening: any address
    // other than the loopback one still has to answer false, brackets or not.
    expect(isLoopbackDatabaseUrl("postgresql://u:p@[2001:db8::1]:5432/x")).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@[::2]:5432/x")).toBe(false);
  });

  it("holds for the shipped local-development default", () => {
    // §7.2 puts a throwaway password on this URL on purpose, and that is only defensible while the URL is
    // genuinely loopback. Tie the constant to the predicate so nobody can edit one without the other.
    expect(isLoopbackDatabaseUrl(LOCAL_DEV_DATABASE_URL)).toBe(true);
  });

  it("rejects an ordinary remote host", () => {
    expect(isLoopbackDatabaseUrl("postgresql://u:p@db.example.com:5432/x")).toBe(false);
  });

  it("rejects a host that merely CONTAINS a loopback name", () => {
    // `localhost.evil.example.com` resolves wherever its owner points it. Equality, not substring.
    expect(isLoopbackDatabaseUrl("postgresql://u:p@localhost.evil.example.com/x")).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@notlocalhost/x")).toBe(false);
  });

  it("rejects a private-network address — loopback is not the same as 'on my LAN'", () => {
    // 127.0.0.1 never leaves the machine; 192.168.1.5 crosses a wire other people are on.
    expect(isLoopbackDatabaseUrl("postgresql://u:p@192.168.1.5:5432/x")).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@10.0.0.9:5432/x")).toBe(false);
  });

  it("FAILS CLOSED on anything it cannot parse", () => {
    // An unparseable string is not evidence of loopback. Returning true here would hand a garbled or
    // truncated DATABASE_URL_FILE a plaintext connection, which is the worst possible reading of a
    // malformed secret.
    expect(isLoopbackDatabaseUrl("not a url at all")).toBe(false);
    expect(isLoopbackDatabaseUrl("")).toBe(false);
    // This one is a trap worth pinning: it DOES parse — WHATWG reads `localhost:` as the scheme and leaves
    // the hostname empty — so the guard that saves us is the host EQUALITY check, not the try/catch. A
    // pattern-matching implementation would have said true.
    expect(new URL("localhost:5432/largefilebridge").hostname).toBe("");
    expect(isLoopbackDatabaseUrl("localhost:5432/largefilebridge")).toBe(false);
  });
});

describe("listenAddressesAreLoopbackOnly — the boot compliance assertion (database.mdx §7.1)", () => {
  it("flags '*', the setting that offers Postgres to every interface", () => {
    // This is the database equivalent of running a public IPFS gateway, and the charter forbids the posture.
    // It is invisible until someone finds it, so the WARN this drives is the only thing that surfaces it.
    expect(listenAddressesAreLoopbackOnly("*")).toBe(false);
  });

  it("passes a plain localhost binding", () => {
    expect(listenAddressesAreLoopbackOnly("localhost")).toBe(true);
    expect(listenAddressesAreLoopbackOnly("127.0.0.1")).toBe(true);
    expect(listenAddressesAreLoopbackOnly("::1")).toBe(true);
  });

  it("passes the common loopback list, tolerating whitespace and case", () => {
    // postgresql.conf is hand-edited; `localhost, ::1` with a space is the normal way it is written.
    expect(listenAddressesAreLoopbackOnly("localhost, 127.0.0.1, ::1")).toBe(true);
    expect(listenAddressesAreLoopbackOnly("LocalHost")).toBe(true);
  });

  it("FAILS a list where only ONE entry is routable", () => {
    // `listen_addresses` is a comma-separated list and it is permissive: every element opens a binding. One
    // routable entry among four loopback ones is full exposure, so `.every` is the only correct reduction —
    // an `.includes('localhost')` reading would call this compliant.
    expect(listenAddressesAreLoopbackOnly("localhost,192.168.1.5")).toBe(false);
    expect(listenAddressesAreLoopbackOnly("localhost, 127.0.0.1, ::1, 10.0.0.9")).toBe(false);
  });

  it("treats the empty string as compliant — it is STRICTER than localhost, not weaker", () => {
    // `listen_addresses = ''` means Postgres accepts no TCP at all and is reachable only over the unix
    // socket. Warning here would train the user to ignore the warning that matters.
    expect(listenAddressesAreLoopbackOnly("")).toBe(true);
    expect(listenAddressesAreLoopbackOnly("   ")).toBe(true);
    expect(listenAddressesAreLoopbackOnly(",,")).toBe(true);
  });

  it("stays quiet on null — we could not read the setting, which is not the same as a violation", () => {
    // null arrives when the probe query returned no row. Crying wolf on an unknown makes the real WARN
    // unbelievable.
    expect(listenAddressesAreLoopbackOnly(null)).toBe(true);
  });
});

describe("resolveDbMode — how hard we insist on Postgres (database.mdx §7)", () => {
  it("defaults to auto when nothing is set", () => {
    // The charter's posture: a user who has never heard of Postgres gets a working app on the YAML path.
    vi.stubEnv("LFB_DB_MODE", "");
    expect(resolveDbMode()).toBe("auto");
  });

  it("honours required and off exactly, including surrounding whitespace and case", () => {
    // `required` is server mode, where an unusable database must be a hard boot failure rather than several
    // logged-in people being served stale YAML. A typo-tolerant read of the value would be wrong; a
    // whitespace-tolerant one is just kindness to a hand-edited plist.
    vi.stubEnv("LFB_DB_MODE", "required");
    expect(resolveDbMode()).toBe("required");
    vi.stubEnv("LFB_DB_MODE", "  OFF  ");
    expect(resolveDbMode()).toBe("off");
    vi.stubEnv("LFB_DB_MODE", "auto");
    expect(resolveDbMode()).toBe("auto");
  });

  it("WARNS and falls back to auto on a value it does not recognise", () => {
    // Silently treating `LFB_DB_MODE=requred` as auto is how a server deployment ends up on the YAML path
    // without anyone noticing. Falling back is right (never refuse to boot over an env typo) but it has to
    // leave a trail.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.stubEnv("LFB_DB_MODE", "requred");
    expect(resolveDbMode()).toBe("auto");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("requred");
  });

  it("does NOT warn when the variable is simply unset — that is the documented default", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.stubEnv("LFB_DB_MODE", "   ");
    expect(resolveDbMode()).toBe("auto");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("buildPoolConfig — TLS, search_path and statement_timeout (database.mdx §7)", () => {
  it("omits ssl on loopback, where the socket never leaves the machine", () => {
    // `undefined` (not `false`) is what `pg` needs to mean "plain connection"; asserting the exact value
    // keeps someone from "tidying" it into `ssl: false` and changing node-postgres' behaviour.
    const cfg = buildPoolConfig(LOCAL_DEV_DATABASE_URL);
    expect(cfg.ssl).toBeUndefined();
  });

  it("requires a VERIFIED certificate off-loopback", () => {
    // `rejectUnauthorized: true` is the whole point. `ssl: true` with verification off would encrypt against
    // any server that answers, which defeats the reason we insisted on TLS in the first place.
    const cfg = buildPoolConfig("postgresql://u:p@db.example.com:5432/x");
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("keeps TLS on for a connection string it cannot parse", () => {
    // Same fail-closed rule as isLoopbackDatabaseUrl, asserted where it actually has consequences.
    const cfg = buildPoolConfig("garbage");
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("puts search_path and statement_timeout on the CONNECTION, not on each query", () => {
    // Unqualified names must resolve to our schema, and no query may become the event-loop stall this whole
    // workstream exists to remove. Both are `options` startup parameters so they apply to every session the
    // pool hands out, including ones taken by code that forgot to set them.
    const cfg = buildPoolConfig(LOCAL_DEV_DATABASE_URL);
    expect(cfg.options).toContain(`-c search_path=${DB_SCHEMA},public`);
    expect(cfg.options).toContain("-c statement_timeout=15000");
  });

  it("lets statement_timeout be tuned by env, and ignores a nonsense value", () => {
    // `num()` accepts only a finite positive number; anything else keeps the default. A `statement_timeout=0`
    // would mean NO timeout, which is precisely the state we are engineering away from.
    vi.stubEnv("LFB_DB_STATEMENT_TIMEOUT_MS", "4000");
    expect(buildPoolConfig(LOCAL_DEV_DATABASE_URL).options).toContain("-c statement_timeout=4000");
    vi.stubEnv("LFB_DB_STATEMENT_TIMEOUT_MS", "0");
    expect(buildPoolConfig(LOCAL_DEV_DATABASE_URL).options).toContain("-c statement_timeout=15000");
    vi.stubEnv("LFB_DB_STATEMENT_TIMEOUT_MS", "soon");
    expect(buildPoolConfig(LOCAL_DEV_DATABASE_URL).options).toContain("-c statement_timeout=15000");
  });

  it("labels every connection 'lfb-web' so pg_stat_activity names the culprit", () => {
    // When a human runs `just db-psql` at 2am to find what is holding a lock, an unnamed connection is a
    // dead end. This is the one field that makes a hung session attributable.
    expect(buildPoolConfig(LOCAL_DEV_DATABASE_URL).application_name).toBe("lfb-web");
  });

  it("carries the URL through unchanged and caps the pool", () => {
    // The pool is deliberately small (desktop app, not a web tier) — see the INTERACTIVE RESERVE note at
    // pool.ts:101-113 and the sister app's 2026-08-15 logout incident.
    const cfg = buildPoolConfig(LOCAL_DEV_DATABASE_URL);
    expect(cfg.connectionString).toBe(LOCAL_DEV_DATABASE_URL);
    expect(cfg.max).toBe(POOL_MAX);
    expect(POOL_MAX).toBeGreaterThan(0);
  });

  it("fails fast on connect so the auto fallback is measured in milliseconds", () => {
    // On `auto`, a machine with nothing on :5432 has to reach the YAML path immediately. Waiting out the OS
    // connect timeout would read to the user as the app hanging at launch.
    const cfg = buildPoolConfig(LOCAL_DEV_DATABASE_URL);
    expect(cfg.connectionTimeoutMillis).toBe(3_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
  });
});

describe("safeUrl — the ONLY form of a connection string that may reach a log line", () => {
  it("redacts the password", () => {
    // The connection string carries the database password, and every log line in pool.ts interpolates this
    // function for that reason. A leak here is a leak into log.log, error.err AND launcher.log at once.
    const out = safeUrl("postgresql://lfb:sup3rs3cret@localhost:5432/largefilebridge");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("***");
    expect(out).toContain("localhost:5432");
    expect(out).toContain("largefilebridge");
  });

  it("keeps the USERNAME, which is diagnostic and not a secret", () => {
    // "which role am I connecting as" is the first question when a permission error appears; redacting it
    // would make the log line useless.
    expect(safeUrl("postgresql://lfb:pw@localhost:5432/largefilebridge")).toContain("lfb");
  });

  it("redacts the password of the attack URL too, without leaking it via the host", () => {
    // The password that fooled the sister app's regex contains a host-looking substring. It must be
    // redacted like any other, so the log line cannot be mistaken for a loopback connection either.
    const out = safeUrl("postgresql://u:p%40localhost%3A5432@db.example.com/x");
    expect(out).not.toContain("p%40localhost");
    expect(out).toContain("***");
    expect(out).toContain("db.example.com");
  });

  it("does not throw on an unparseable url — a log call must never be the thing that crashes us", () => {
    // safeUrl is called from error paths. If it threw on the malformed URL that CAUSED the error, the
    // failure would be reported as a crash inside logging instead of as a bad connection string.
    expect(() => safeUrl("not a url")).not.toThrow();
    expect(safeUrl("not a url")).toBe("<unparseable database url>");
    expect(safeUrl("")).toBe("<unparseable database url>");
  });

  it("passes through a password-less url unchanged in substance", () => {
    expect(safeUrl("postgresql://lfb@localhost:5432/largefilebridge")).toContain("lfb@localhost:5432");
  });
});

// BUG #15A — a laptop changing wifi is not a fault, and a DNS blip must not cost a sync cycle.
//
// These lines filled `error.err` (the DURABLE FAULT TRAIL — WARN/ERROR/FATAL only) for days:
//
//   [WARN] [pin] storage personal git: Git remote error … 'https://github.com/…': Could not resolve host: github.com
//   [WARN] [pin] device-reg storage … : Resolving timed out after 900230 milliseconds
//
// Every one is a closed lid or a sleeping radio. The tests below pin the classification (offline vs. a real
// auth/remote fault), the host extraction the retry-on-reconnect needs, and the waiter that re-runs the
// cycle the outage cost us instead of losing it until the next 15-minute tick.
import { describe, it, expect, afterEach } from "vitest";
import {
  isTransientNetworkError,
  hostFromGitError,
  hostFromRemote,
  whenOnline,
  pendingOnlineWaiters,
  probeOnlineWaitersForTest,
  resetOnlineWaitersForTest,
} from "../../shared/net-transient.js";
import { classifyRemoteFailure } from "../git/git.service.js";

afterEach(() => resetOnlineWaitersForTest());

describe("isTransientNetworkError — the shapes an offline laptop actually produces", () => {
  it("recognizes the exact lines from error.err", () => {
    for (const m of [
      "fatal: unable to access 'https://github.com/BryanStarbuck/personal_large_files_bridge.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/ACT3ai/act3_large_files_bridge.git/': Resolving timed out after 900230 milliseconds",
      "fatal: unable to access 'https://github.com/ACT3ai/charlie-kirk.git/': Failed to connect to github.com port 443: Operation timed out",
      "getaddrinfo EAI_AGAIN github.com",
      "connect ENETUNREACH 140.82.113.4:443",
      "ssh: connect to host github.com port 22: Network is unreachable",
    ]) {
      expect(isTransientNetworkError(m), m).toBe(true);
    }
  });

  it("never swallows a REAL fault — auth, a missing repo, or a rejected push stay faults", () => {
    for (const m of [
      "fatal: Authentication failed for 'https://github.com/x/y.git/'",
      "remote: Permission to x/y.git denied to someone",
      "fatal: repository 'https://github.com/x/y.git/' not found",
      "! [rejected] main -> main (non-fast-forward)",
      "error: Your local changes to the following files would be overwritten by merge:\n\t.gitignore",
    ]) {
      expect(isTransientNetworkError(m), m).toBe(false);
    }
  });
});

describe("classifyRemoteFailure — offline is its own kind, and it wins over the auth regex", () => {
  it("classifies a DNS failure as offline with a plain-English, spelled-out product name", () => {
    const r = classifyRemoteFailure(
      new Error("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"),
    );
    expect(r.kind).toBe("offline");
    expect(r.problem).toContain("Large File Bridge");
    expect(r.problem).not.toMatch(/\bLFB\b/); // charter: never an abbreviation in user-facing English
  });

  it("still flags a credential problem for re-authentication", () => {
    const r = classifyRemoteFailure(new Error("fatal: Authentication failed for 'https://github.com/x/y.git/'"));
    expect(r.kind).toBe("auth");
    expect(r.problem).toContain("Large File Bridge");
  });

  it("keeps everything else a remote fault", () => {
    const r = classifyRemoteFailure(new Error("fatal: repository 'https://github.com/x/y.git/' not found"));
    expect(r.kind).toBe("remote");
  });
});

describe("hostFromGitError / hostFromRemote — which host the retry must wait on", () => {
  it("reads the host out of git's own sentence", () => {
    expect(
      hostFromGitError("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"),
    ).toBe("github.com");
    expect(hostFromGitError("ssh: connect to host git@gitlab.com:x/y.git failed")).toBe("gitlab.com");
    expect(hostFromGitError("some error with no host in it")).toBeNull();
  });

  it("reads the host out of a configured remote, URL or scp-style", () => {
    expect(hostFromRemote("https://github.com/x/y.git")).toBe("github.com");
    expect(hostFromRemote("git@github.com:x/y.git")).toBe("github.com");
    expect(hostFromRemote("/Users/me/some/local/path")).toBeNull();
    expect(hostFromRemote(null)).toBeNull();
  });
});

describe("whenOnline — the lost cycle becomes a delayed cycle", () => {
  it("fires the retry once the host resolves again", async () => {
    let ran = 0;
    whenOnline("storage personal", "localhost", () => {
      ran += 1;
    });
    expect(pendingOnlineWaiters()).toBe(1);
    await probeOnlineWaitersForTest();
    expect(ran).toBe(1);
    expect(pendingOnlineWaiters()).toBe(0);
  });

  it("keeps waiting while the host is still unreachable — and never queues two retries for one key", async () => {
    let ran = 0;
    const host = "lfb-offline-probe.invalid";
    whenOnline("storage personal", host, () => {
      ran += 1;
    });
    whenOnline("storage personal", host, () => {
      ran += 1;
    });
    expect(pendingOnlineWaiters()).toBe(1); // re-registering REPLACES, never piles up
    await probeOnlineWaitersForTest();
    expect(ran).toBe(0);
    expect(pendingOnlineWaiters()).toBe(1);
  });
});

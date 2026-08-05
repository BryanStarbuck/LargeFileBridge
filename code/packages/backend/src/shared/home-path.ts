// ONE `~` expansion for the whole app — and the reason it exists is Windows.
//
// The expansion was open-coded in ~20 modules as `p.replace(/^~(?=\/|$)/, process.env.HOME || "~")`. `HOME`
// is a POSIX variable: Windows sets `USERPROFILE` and leaves `HOME` unset, so on every one of those sites a
// configured `~/BGit/foo` expanded to the LITERAL string `~/BGit/foo`. For the git backbone that is not
// cosmetic — `resolveWorkingCopy` stats `<remote>/.git`, finds nothing, and skips that storage's entire
// commit/push cycle every pass with one INFO line to show for it. Same class as `stableGitBin()`: resolve it
// once, correctly, in a leaf module (node builtins only) that anything may import without a cycle.
import os from "node:os";
import path from "node:path";

// `~/x` everywhere, plus `~\x` — the shape a Windows user actually types.
const LEADING_TILDE = /^~(?=[/\\]|$)/;

/** This user's home directory. `os.homedir()` reads USERPROFILE on Windows and HOME on POSIX. */
export function homeDir(): string {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || "~";
}

/** Expand a leading `~` to this user's home. Any other path is returned unchanged. */
export function expandHome(p: string): string {
  // Function replacement, not a string one: a home directory containing `$&` would otherwise be re-expanded.
  return p.replace(LEADING_TILDE, () => homeDir());
}

/** `expandHome` + `path.resolve` — the combination most call sites actually want. */
export function resolveHome(p: string): string {
  return path.resolve(expandHome(p));
}

/** The inverse, for display: `/Users/bryan/BGit` → `~/BGit`. Never used to build a path we then open. */
export function collapseHome(p: string): string {
  const home = homeDir().replace(/[/\\]+$/, ""); // a trailing separator would make every path "inside" home
  if (home === "~" || home === "") return p;
  const rest = p.slice(home.length);
  // A SEGMENT BOUNDARY, not bare `startsWith`: with home `/Users/bry`, the sibling `/Users/bryan/BGit`
  // otherwise collapses to `~an/BGit` — a path that reads as the user's and is not. And on Windows the
  // comparison must ignore case, because `C:\Users\Bryan` and `c:\users\bryan` are one directory.
  const sameHead =
    process.platform === "win32"
      ? p.slice(0, home.length).toLowerCase() === home.toLowerCase()
      : p.slice(0, home.length) === home;
  if (!sameHead || (rest !== "" && rest[0] !== "/" && rest[0] !== "\\")) return p;
  return `~${rest}`;
}

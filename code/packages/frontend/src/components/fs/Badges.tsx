// The File System code-badge chips (directory.mdx §3): white letter on a solid color square.
// The backend orders badges[] RIGHTMOST-FIRST — [repo, sync, compress, ipfs] (directory.mdx §5) —
// so we render the array REVERSED, giving the fixed visual left→right order  i · C/c · S · R/r
// with the repo badge pinned to the far right.
import { memo } from "react";
import type { FsBadge } from "@lfb/shared";

interface BadgeMeta {
  letter: string;
  bg: string; // CSS var
  ink: string; // letter color
  title: string;
}

const BADGE_META: Record<FsBadge, BadgeMeta> = {
  repo_root: { letter: "R", bg: "var(--lfb-badge-repo-root)", ink: "#fff", title: "Repo root (git working tree)" },
  repo_descendant: {
    letter: "r",
    bg: "var(--lfb-badge-repo-descendant)",
    ink: "#fff",
    title: "Inside a repo",
  },
  repo_ancestor: {
    letter: "r",
    bg: "var(--lfb-badge-repo-ancestor)",
    ink: "#fff",
    title: "Contains a repo below",
  },
  sync: { letter: "S", bg: "var(--lfb-badge-sync)", ink: "#fff", title: "Sync — tracked & synced" },
  compress: { letter: "C", bg: "var(--lfb-badge-compress)", ink: "#fff", title: "Should be compressed" },
  compressed: {
    letter: "c",
    bg: "var(--lfb-badge-compressed)",
    ink: "var(--lfb-badge-compressed-ink)",
    title: "Already compressed",
  },
  ipfs: { letter: "i", bg: "var(--lfb-badge-ipfs)", ink: "#fff", title: "IPFS share / list artifact" },
};

// Memoized — the badge array for a row only changes identity when that row's data changes, so a table
// re-render (scroll/keystroke/selection) doesn't rebuild every row's chips (performance.mdx P-12).
export const Badges = memo(function Badges({ badges }: { badges: FsBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className="flex items-center gap-0.5">
      {badges.slice().reverse().map((b, i) => {
        const m = BADGE_META[b];
        return (
          <span
            key={`${b}-${i}`}
            title={m.title}
            className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none select-none"
            style={{ backgroundColor: m.bg, color: m.ink }}
          >
            {m.letter}
          </span>
        );
      })}
    </span>
  );
});

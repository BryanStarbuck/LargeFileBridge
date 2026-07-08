// The File System code-badge chips (directory.mdx §3): white letter on a solid color square.
// The backend orders badges[] RIGHTMOST-FIRST — [repo, sync, compress, ipfs] (directory.mdx §5) —
// so we render the array REVERSED, giving the fixed visual left→right order  i · C/c · S · R/r
// with the repo badge pinned to the far right.
import { memo } from "react";
import type { FsBadge } from "@lfb/shared";
import { Tooltip } from "../ui/Tooltip.js";

interface BadgeMeta {
  letter: string;
  bg: string; // CSS var
  ink: string; // letter color
  name: string; // the short NAME the letter stands for (1–3 words) — the tooltip headline
  desc: string; // one line explaining it, a little longer when needed
}

// The single source of truth for what each code-badge letter MEANS. `name` is the 1–3 word phrase the
// letter stands for (shown bold in the hover tooltip); `desc` is the slightly-longer one-line explanation.
// BadgeLegend.tsx reuses these, so the hover tooltip and the "What do these letters mean?" legend never drift.
export const BADGE_META: Record<FsBadge, BadgeMeta> = {
  repo_root: {
    letter: "R",
    bg: "var(--lfb-badge-repo-root)",
    ink: "#fff",
    name: "Repo root",
    desc: "The top of a git working tree LFBridge manages.",
  },
  repo_descendant: {
    letter: "r",
    bg: "var(--lfb-badge-repo-descendant)",
    ink: "#fff",
    name: "Inside a repo",
    desc: "This lives underneath a git repo root.",
  },
  repo_ancestor: {
    letter: "r",
    bg: "var(--lfb-badge-repo-ancestor)",
    ink: "#fff",
    name: "Contains a repo",
    desc: "A git repo sits somewhere below this folder.",
  },
  sync: {
    letter: "S",
    bg: "var(--lfb-badge-sync)",
    ink: "#fff",
    name: "Synced",
    desc: "Tracked and bridged over IPFS across your computers.",
  },
  compress: {
    letter: "C",
    bg: "var(--lfb-badge-compress)",
    ink: "#fff",
    name: "Compress",
    desc: "Looks uncompressed — could be shrunk (an offer, never automatic).",
  },
  compressed: {
    letter: "c",
    bg: "var(--lfb-badge-compressed)",
    ink: "var(--lfb-badge-compressed-ink)",
    name: "Compressed",
    desc: "Already compressed.",
  },
  ipfs: {
    letter: "i",
    bg: "var(--lfb-badge-ipfs)",
    ink: "#fff",
    name: "IPFS artifact",
    desc: "An IPFS share / list artifact.",
  },
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
          // Hover/focus the chip → a tooltip names what the letter stands for (directory.mdx §4). One
          // Tooltip per badge, so every place a badge renders — FS rows, Full Paths, the entity-detail
          // header strip at the top of the page — explains itself the same way.
          <Tooltip
            key={`${b}-${i}`}
            content={
              <span className="block">
                <span className="font-semibold">{m.name}</span>
                <span className="mt-0.5 block text-white/75">{m.desc}</span>
              </span>
            }
          >
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none select-none"
              style={{ backgroundColor: m.bg, color: m.ink }}
            >
              {m.letter}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
});

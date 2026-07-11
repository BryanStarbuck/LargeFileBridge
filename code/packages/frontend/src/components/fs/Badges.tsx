// The File System code-badge chips (directory.mdx §3): white letter on a solid color square.
// The backend orders badges[] RIGHTMOST-FIRST — [repo, pin, compress, ipfs, git_ignored] (directory.mdx
// §5) — so we render the array REVERSED, giving the fixed visual left→right order  I · i · C/c · P · R/r
// with the repo badge pinned to the far right.
//
// Every chip is ALSO a hover source for the non-intrusive hover-info panel (non_intrusive_tooltip.mdx §2):
// hovering/focusing a chip publishes its code-key block into the bottom-of-left-bar panel. The native
// Tooltip is kept as the accessibility fallback (screen readers + surfaces with no left bar).
import { memo, useMemo } from "react";
import type { FsBadge } from "@lfb/shared";
import { Tooltip } from "../ui/Tooltip.js";
import { useHoverInfoSource, type HoverInfo } from "../hoverinfo/HoverInfoContext.js";

interface BadgeMeta {
  letter: string;
  bg: string; // CSS var
  ink: string; // letter color
  border?: string; // optional 1px chip border — needed for the near-white "I" (white letter on near-white)
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
  pin: {
    letter: "P",
    bg: "var(--lfb-badge-pin)",
    ink: "#fff",
    name: "Pinned",
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
  git_ignored: {
    letter: "I",
    bg: "var(--lfb-badge-git-ignored)",
    ink: "#ffffff",
    border: "var(--lfb-badge-git-ignored-border)",
    name: "Git-ignored",
    desc: "Not committed to git — pinned over IPFS instead.",
  },
};

// One chip. A component (not an inline map body) so it can call the useHoverInfoSource hook at the top level
// per badge — the chip publishes its code-key block to the hover-info panel on enter/focus.
function BadgeChip({ b }: { b: FsBadge }) {
  const m = BADGE_META[b];
  const payload = useMemo<HoverInfo>(
    () => ({
      blocks: [
        {
          kind: "code",
          chip: { letter: m.letter, bg: m.bg, ink: m.ink, border: m.border },
          name: m.name,
          line: m.desc,
        },
      ],
    }),
    [m],
  );
  const hover = useHoverInfoSource(payload);
  return (
    // Hover/focus the chip → the hover-info panel names what the letter stands for (non_intrusive_tooltip.mdx
    // §2). The native Tooltip stays as the a11y fallback (directory.mdx §3.5.1).
    <Tooltip
      content={
        <span className="block">
          <span className="font-semibold">{m.name}</span>
          <span className="mt-0.5 block text-white/75">{m.desc}</span>
        </span>
      }
    >
      <span
        {...hover}
        className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none select-none"
        style={{
          backgroundColor: m.bg,
          color: m.ink,
          border: m.border ? `1px solid ${m.border}` : undefined,
        }}
      >
        {m.letter}
      </span>
    </Tooltip>
  );
}

// Memoized — the badge array for a row only changes identity when that row's data changes, so a table
// re-render (scroll/keystroke/selection) doesn't rebuild every row's chips (performance.mdx P-12).
export const Badges = memo(function Badges({ badges }: { badges: FsBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className="flex items-center gap-0.5">
      {badges.slice().reverse().map((b, i) => (
        <BadgeChip key={`${b}-${i}`} b={b} />
      ))}
    </span>
  );
});

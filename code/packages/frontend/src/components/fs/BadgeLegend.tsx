// A reachable, self-explaining legend for the File System code badges (use_cases.mdx §5.7) so a
// non-expert isn't stuck guessing what R/r · P · C/c · i mean. The badges themselves are unchanged
// (Badges.tsx); this just explains them once, behind a chevron.
import { Badges, BADGE_META } from "./Badges.js";
import { Disclosure } from "../ui/Disclosure.js";
import type { FsBadge } from "@lfb/shared";

// The legend rows reuse the SAME name/desc as the hover tooltips (Badges.tsx → BADGE_META), so the two
// explanations of the letters can never drift. `repo_ancestor` shares the `r` glyph with repo_descendant,
// so it isn't listed separately here.
const LEGEND_BADGES: FsBadge[] = ["repo_root", "repo_descendant", "pin", "compress", "compressed", "ipfs", "git_ignored"];

export function BadgeLegend({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Disclosure label="What do these letters mean?">
        <ul className="space-y-1.5">
          {LEGEND_BADGES.map((b) => {
            const m = BADGE_META[b];
            return (
              <li key={b} className="flex items-center gap-2 text-sm text-black/70">
                <Badges badges={[b]} />
                <span>
                  <span className="font-medium text-black/80">{m.name}</span> — {m.desc}
                </span>
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </div>
  );
}

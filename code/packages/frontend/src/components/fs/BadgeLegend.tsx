// A reachable, self-explaining legend for the File System code badges (use_cases.mdx §5.7) so a
// non-expert isn't stuck guessing what R/r · S · C/c · i mean. The badges themselves are unchanged
// (Badges.tsx); this just explains them once, behind a chevron.
import { Badges } from "./Badges.js";
import { Disclosure } from "../ui/Disclosure.js";
import type { FsBadge } from "@lfb/shared";

const ITEMS: { badges: FsBadge[]; text: string }[] = [
  { badges: ["repo_root"], text: "Repo root — a git working tree LFBridge manages." },
  { badges: ["repo_descendant"], text: "Inside a repo." },
  { badges: ["sync"], text: "Synced — bridged over IPFS across your computers." },
  { badges: ["compress"], text: "Looks uncompressed — could be shrunk (an offer, never automatic)." },
  { badges: ["compressed"], text: "Already compressed." },
  { badges: ["ipfs"], text: "An IPFS share / list artifact." },
];

export function BadgeLegend({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Disclosure label="What do these letters mean?">
        <ul className="space-y-1.5">
          {ITEMS.map((it, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-black/70">
              <Badges badges={it.badges} />
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

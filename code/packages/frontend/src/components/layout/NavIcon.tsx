// Resolve a lucide icon by name; unknown name renders nothing (left_bar.mdx §5).
//
// We import ONLY the icons the nav config (pm/left_bar.yaml) actually references, by name, into an
// explicit map. A namespace import (`import * as Icons from "lucide-react"`) would pull the entire
// ~775 kB icon barrel into the bundle and defeat tree-shaking — this map keeps just the ~dozen we use.
// When a new icon is added to left_bar.yaml, add it here too; an unknown name warns in dev and renders
// nothing (unchanged runtime behavior), so a missing entry degrades gracefully instead of crashing.
import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";
import {
  Boxes,
  ChevronDown,
  Columns3,
  FolderGit2,
  HardDrive,
  Loader2,
  LogOut,
  Network,
  RefreshCw,
  Settings,
  ShieldAlert,
  Users,
} from "lucide-react";

const ICONS: Record<string, ComponentType<LucideProps>> = {
  Boxes,
  ChevronDown,
  Columns3,
  FolderGit2,
  HardDrive,
  Loader2,
  LogOut,
  Network,
  RefreshCw,
  Settings,
  ShieldAlert,
  Users,
};

export function NavIcon({ name, ...props }: { name: string } & LucideProps) {
  const Cmp = ICONS[name];
  if (!Cmp) {
    if (import.meta.env.DEV) {
      console.warn(`[NavIcon] no lucide icon mapped for "${name}" — add it to ICONS in NavIcon.tsx`);
    }
    return null;
  }
  return <Cmp {...props} />;
}

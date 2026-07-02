// Resolve a lucide icon by name; unknown name renders nothing (left_bar.mdx §5).
import * as Icons from "lucide-react";
import type { LucideProps } from "lucide-react";

export function NavIcon({ name, ...props }: { name: string } & LucideProps) {
  const Cmp = (Icons as unknown as Record<string, React.ComponentType<LucideProps>>)[name];
  if (!Cmp) return null;
  return <Cmp {...props} />;
}

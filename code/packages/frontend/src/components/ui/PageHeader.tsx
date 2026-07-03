// Consistent page title block (use_cases.mdx §3.6) so every page shares the Home dashboard's top
// rhythm: H1 + optional subtitle on the left, a right-aligned actions slot. Replaces the ad-hoc
// flex/h1 repeated on each page.
import { type ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  above,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  above?: ReactNode; // e.g. a breadcrumb / back link that sits over the title
}) {
  return (
    <div className="mb-3">
      {above}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-black">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-black/60">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

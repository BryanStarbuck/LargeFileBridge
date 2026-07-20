// Consistent page title block (use_cases.mdx §3.6) so every page shares the Home dashboard's top
// rhythm: H1 + optional subtitle on the left, a right-aligned actions slot. Replaces the ad-hoc
// flex/h1 repeated on each page.
import { type ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  actionsRow,
  above,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  // The page action-links row (page_actions.mdx §3): a horizontal row of blue hyperlinks rendered
  // directly BENEATH the title block (NOT in the header's right-aligned `actions` slot). The page's
  // single primary button (Pin now / Index files / + Add repo) stays in `actions`; this row is separate.
  actionsRow?: ReactNode;
  above?: ReactNode; // e.g. a breadcrumb / back link that sits over the title
}) {
  return (
    <div className="mb-3">
      {above}
      {/* ROW 1 — the title and the right-aligned actions slot ONLY. The title never wraps: it truncates
          with the full text on hover, so a long repo name can't push the tab strip down or force a
          second line (one_repo.mdx §3.1). */}
      <div className="flex items-baseline justify-between gap-3">
        {/* PRIORITY: the title is sized to its CONTENT and the actions slot takes the remainder (basis-0,
            grow). That ordering is the point — with `flex-1` on the title instead, the actions slot won
            every pixel it wanted and the repo name was the thing that shrank. Capped at half the row so a
            pathological name can't crush the tab strip entirely; past the cap it ellipsizes. */}
        <h1
          className="min-w-0 max-w-[50%] shrink truncate whitespace-nowrap text-2xl font-bold text-black"
          title={typeof title === "string" ? title : undefined}
        >
          {title}
        </h1>
        {actions && <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{actions}</div>}
      </div>
      {/* ROW 2 — the subtitle (on One-repo: the absolute directory path) gets the FULL page width. It is
          deliberately NOT nested in row 1's left column: sharing that row with a `shrink-0` actions slot
          squeezed it into a narrow box and wrapped it over several lines while the right side sat empty
          (one_repo.mdx §3.1). One line, ellipsized, full text on hover. */}
      {subtitle && (
        <p
          className="mt-0.5 w-full truncate whitespace-nowrap text-sm text-black/60"
          title={typeof subtitle === "string" ? subtitle : undefined}
        >
          {subtitle}
        </p>
      )}
      {actionsRow && <div className="mt-2">{actionsRow}</div>}
    </div>
  );
}

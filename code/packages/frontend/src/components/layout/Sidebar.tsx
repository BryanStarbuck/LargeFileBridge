// The one left bar (left_bar.mdx). 256px, white, right border. Content from pm/left_bar.yaml.
// Color rules: all text black; wordmark + active item + sign-in accent stay accent.
// The IPFS item is the one DISCLOSURE parent (ipfs.mdx §2.1): while active it expands into a child
// list of the repos that hold pinned content; a child filters /ipfs to that repo, the parent clears it.
import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser, PendingCompanyMapping } from "@lfb/shared";
import { leftBar } from "../../config/left_bar.js";
import { api } from "../../api/client.js";
import { http, unwrap } from "../../api/axios.js";
import { clientLog } from "../../lib/clientLog.js";
import { useProgress } from "../../progress/progress-context.js";
import { NavIcon } from "./NavIcon.js";
import { HoverInfoPanel } from "../hoverinfo/HoverInfoPanel.js";

// The nav row shapes, in ONE place. The active/inactive treatment used to be an inline `style` ternary
// copy-pasted at five call sites, so a change to it only ever landed in some of them. Colors are the
// LOCKED ones from left_bar.mdx §2 (labels black; active + wordmark stay accent); what is new is the
// motion, the left accent rail on the active row, and hover being suppressed while active so the tint
// doesn't flicker under the pointer.
const NAV_BASE =
  "relative mx-2 my-0.5 flex items-center rounded-md text-sm transition-colors duration-150 " +
  "before:absolute before:-left-2 before:top-1 before:bottom-1 before:w-[3px] before:rounded-r-full " +
  "before:bg-[var(--lfb-primary)] before:transition-opacity before:duration-150";

function navRowClass(active: boolean): string {
  return `${NAV_BASE} gap-2.5 px-3 py-2 ${
    active
      ? "bg-[var(--lfb-primary-tint)] font-medium text-[var(--lfb-primary)] before:opacity-100"
      : "text-black before:opacity-0 hover:bg-slate-100"
  }`;
}

function navChildClass(active: boolean): string {
  return `${NAV_BASE} gap-2 py-1.5 pl-9 pr-3 ${
    active
      ? "bg-[var(--lfb-primary-tint)] font-medium text-[var(--lfb-primary)] before:opacity-100"
      : "text-black before:opacity-0 hover:bg-slate-100"
  }`;
}

// The count badge on Storages / To Do. min-w + tabular figures so a 1-digit and a 3-digit count are
// the same shape instead of a narrow oval next to a wide one.
const NAV_BADGE =
  "grid min-w-[1.25rem] place-items-center rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums text-white";

export function Sidebar({ user }: { user: CurrentUser }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Background-work state for the conditional "Processing" item (processing.mdx §2).
  const { processing, recentlyFinished, jobs, queued } = useProgress();
  const processingCount = jobs.length + queued;
  const activeRepo = useRouterState({
    select: (s) => (s.location.search as { repo?: string } | undefined)?.repo,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (route: string) => (route === "/" ? path === "/" : path.startsWith(route));
  const onIpfs = path.startsWith("/ipfs");
  const onStorages = path.startsWith("/storages");

  // Storages disclosure children (storages.mdx §2): Personal · one per Company (DERIVED) · Repos → Repos
  // tab · Communities. Fetched only while the Storages section is active; shares the ["storages"] cache.
  const { data: storages, error: storagesError } = useQuery({
    queryKey: ["storages"],
    queryFn: api.storages,
    enabled: onStorages,
  });
  useEffect(() => {
    if (storagesError) clientLog.error("Sidebar.storages", storagesError);
  }, [storagesError]);
  const storageChildren: { key: string; label: string; route: string }[] = [
    { key: "personal", label: "Personal", route: storages?.personal?.route ?? "/storages/personal" },
    ...(storages?.companies ?? []).map((c) => ({ key: c.id, label: c.name, route: c.route })),
    { key: "repos", label: "Repos", route: "/" },
    { key: "communities", label: "Communities", route: "/communities" },
  ];

  // Left-bar children (ipfs.mdx §2.1): the repos that actually hold pins. Fetched only while the IPFS
  // section is active; shares the ["ipfs"] cache with the page so there's no extra request.
  // Subscribe to ONLY the pinning-repos slice of the (potentially large) IPFS payload via `select`
  // (performance.mdx P-09), so the sidebar re-renders only when that list changes — not on every pin
  // update. Shares the ["ipfs"] cache with the page, so there's still no extra request.
  const { data: pinningRepos = [], error: pinningReposError } = useQuery({
    queryKey: ["ipfs"],
    queryFn: api.ipfs,
    enabled: onIpfs,
    select: (d) => d.repos,
  });

  // The children fetch fails silently (the disclosure just stays empty) — log it so a broken /ipfs
  // payload still leaves a fault trail instead of vanishing.
  useEffect(() => {
    if (pinningReposError) clientLog.error("Sidebar.pinningRepos", pinningReposError);
  }, [pinningReposError]);

  // The To Do count badge (to_do.mdx §2): how many non-dismissed batches have work. Shares the page's
  // ["todo","batches"] cache; a stale time keeps it from re-walking on every navigation.
  const { data: todoBatches } = useQuery({
    queryKey: ["todo", "batches"],
    queryFn: api.todoBatches,
    staleTime: 60_000,
  });
  const todoCount = todoBatches?.length ?? 0;

  // Pending company repo→ownership mappings awaiting this member's consent (repo_owner_propagation.mdx §4):
  // a badge on the Storages entry links to the review page when a teammate has asserted repos this member
  // hasn't resolved. Shares the ["company-mappings","pending"] cache with the review page; a stale time keeps
  // it from re-walking on every navigation. Subscribe to only the COUNT so the sidebar re-renders minimally.
  const { data: pendingMappingCount = 0 } = useQuery({
    queryKey: ["company-mappings", "pending"],
    queryFn: () => unwrap<PendingCompanyMapping[]>(http.get("/company-mappings/pending")),
    staleTime: 60_000,
    select: (rows) => rows.length,
  });

  return (
    <aside
      className="flex flex-col h-full border-r bg-white"
      style={{ width: leftBar.sidebarWidth, borderColor: "var(--lfb-border)" }}
    >
      {/* Wordmark */}
      <Link
        to={leftBar.clickRoute}
        title={leftBar.wordmarkAlt}
        className="flex h-14 shrink-0 items-center border-b px-4 text-lg font-semibold tracking-normal transition-colors duration-150 hover:bg-slate-50"
        style={{ color: "var(--lfb-primary)", borderColor: "var(--lfb-border)" }}
      >
        {leftBar.wordmark}
      </Link>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto py-2">
        {leftBar.navItems.map((item) => {
          const active = isActive(item.route);
          const isIpfs = item.id === "ipfs";
          const isStorages = item.id === "storages";
          // Generic STATIC yaml children (left_bar.yaml `children:` — e.g. Videos → Duplicates/Subsets,
          // videos.mdx §1). Storages is excluded: its disclosure list is runtime-composed above (per-Company
          // children); everything else renders its fixed children straight from the yaml while active.
          const staticChildren = !isStorages && item.children?.length ? item.children : null;
          // The IPFS parent is "selected" (unfiltered) only when on /ipfs with no ?repo filter.
          // The Storages parent is "selected" only on the /storages index, not a child detail page.
          const parentSelected = isIpfs ? onIpfs && !activeRepo : isStorages ? path === "/storages" : active;
          return (
            <div key={item.id}>
              <Link
                to={item.route}
                title={item.description}
                aria-current={parentSelected ? "page" : undefined}
                className={navRowClass(parentSelected)}
              >
                <NavIcon name={item.icon} className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {item.id === "todo" && todoCount > 0 && (
                  <span className={NAV_BADGE} style={{ background: "var(--lfb-primary)" }}>
                    {todoCount}
                  </span>
                )}
                {isStorages && pendingMappingCount > 0 && (
                  <span
                    role="button"
                    title="Review company repo mappings — a teammate asserted repos belong to a company"
                    onClick={(e) => {
                      // The row itself links to /storages; the badge routes to the review page instead
                      // (repo_owner_propagation.mdx §4) without nesting an anchor inside the row's Link.
                      e.preventDefault();
                      e.stopPropagation();
                      navigate({ to: "/company-mappings/review" });
                    }}
                    className={`${NAV_BADGE} cursor-pointer`}
                    style={{ background: "var(--lfb-primary)" }}
                  >
                    {pendingMappingCount}
                  </span>
                )}
                {isIpfs && onIpfs && pinningRepos.length > 0 && (
                  <NavIcon name="ChevronDown" className="h-3.5 w-3.5 shrink-0 text-black/40" />
                )}
                {isStorages && onStorages && (
                  <NavIcon name="ChevronDown" className="h-3.5 w-3.5 shrink-0 text-black/40" />
                )}
                {staticChildren && active && (
                  <NavIcon name="ChevronDown" className="h-3.5 w-3.5 shrink-0 text-black/40" />
                )}
              </Link>

              {/* Static yaml children (left_bar.yaml `children:`) — the same indented disclosure-group
                  treatment as Storages' children; the active child additionally highlights (videos.mdx §1). */}
              {staticChildren && active &&
                staticChildren.map((child) => {
                  const childActive =
                    path === child.route || (child.route !== "/" && path.startsWith(child.route));
                  return (
                    <Link
                      key={child.id}
                      to={child.route}
                      title={child.description ?? child.label}
                      aria-current={childActive ? "page" : undefined}
                      className={navChildClass(childActive)}
                    >
                      <span className="flex-1 truncate">{child.label}</span>
                    </Link>
                  );
                })}

              {/* Storages disclosure children (storages.mdx §2): Personal · companies · Repos · Communities. */}
              {isStorages && onStorages &&
                storageChildren.map((child) => {
                  const childActive = path === child.route || (child.route !== "/" && path.startsWith(child.route));
                  return (
                    <Link
                      key={child.key}
                      to={child.route}
                      title={child.label}
                      aria-current={childActive ? "page" : undefined}
                      className={navChildClass(childActive)}
                    >
                      <span className="flex-1 truncate">{child.label}</span>
                    </Link>
                  );
                })}

              {/* IPFS disclosure children — pinning repos that filter the table (ipfs.mdx §2.1). */}
              {isIpfs && onIpfs &&
                pinningRepos.map((repo) => {
                  const childActive = activeRepo === repo.repoId;
                  return (
                    <Link
                      key={repo.repoId}
                      to="/ipfs/pins"
                      search={{ repo: repo.repoId }}
                      title={`${repo.name} — ${repo.pinnedCount} pinned`}
                      aria-current={childActive ? "page" : undefined}
                      className={navChildClass(childActive)}
                    >
                      <span className="flex-1 truncate">{repo.name}</span>
                      <span className="text-xs text-black/40">{repo.pinnedCount}</span>
                    </Link>
                  );
                })}
            </div>
          );
        })}

        {/* Conditional "Processing" item (processing.mdx §2): the LAST item of the top nav list, shown
            while background work runs (a running job, a pending backlog, or an active batch) AND for a
            short LINGER after the last batch settles (§2.1). The linger is what makes a FAST run
            reachable: a 16-image OCR batch finishes in ~4s, so a strictly-live gate meant the only route
            to /processing blinked past between two polls and the result — kept on the server for 24h —
            could not be opened by any means. Runtime-injected, NOT a static yaml row (documented as a
            comment in left_bar.yaml). Routes to the Processing page. */}
        {(processing || recentlyFinished) && (
          <Link
            to="/processing"
            title={recentlyFinished ? "Background work just finished" : "Background work in progress"}
            aria-current={path.startsWith("/processing") ? "page" : undefined}
            className={navRowClass(path.startsWith("/processing"))}
          >
            {/* The icon carries the live/settled distinction — a spinner over finished work would be
                fake progress (processing.mdx §1's never-fake rule). */}
            {processing ? (
              <NavIcon name="Loader2" className="h-4 w-4 animate-spin" />
            ) : (
              <NavIcon name="Check" className="h-4 w-4" />
            )}
            <span className="flex-1">Processing</span>
            {processingCount > 0 && <span className="text-xs text-black/40">{processingCount}</span>}
          </Link>
        )}
      </nav>

      {/* External product links (left_bar.mdx §4.2): outbound links to our other products, in the space
          between the bottom of the nav list and the account slot. Each opens in a NEW browser tab
          (target=_blank, rel=noopener) — the ONLY bar entries that leave the app. Data-driven from
          left_bar.yaml `external_links`; an empty list renders nothing. Not part of the active-route
          machinery — they never highlight as active.

          LEFT-ALIGNED, on the SAME grid as the nav items above (§4.2). These used to be `justify-center`,
          which made them the only rows in the bar whose text floated to a different x on every label — a
          ragged edge against an otherwise straight column. They now carry the nav item's exact geometry
          (mx-2 / px-3 / py-2 / gap-2.5 with a LEADING h-4 icon), so the label starts at the identical x as
          "Repos" or "Devices / Peers". The ExternalLink glyph moves to the leading icon slot: it is still
          the outbound hint §4.2 asks for, now doing double duty as the icon every other row has. */}
      {leftBar.externalLinks.length > 0 && (
        <div className="border-t py-1.5" style={{ borderColor: "var(--lfb-border)" }}>
          {leftBar.externalLinks.map((link) => (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${link.label} — opens in a new tab`}
              className="mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-black transition-colors duration-150 hover:bg-slate-100"
            >
              <NavIcon name="ExternalLink" className="h-4 w-4 text-black/40" />
              <span className="flex-1 truncate">{link.label}</span>
            </a>
          ))}
        </div>
      )}

      {/* Non-intrusive hover-info panel (left_bar.mdx §4.1 / non_intrusive_tooltip.mdx): a FIXED block of
          always-white space (~two nav-item rows tall) reserved between the nav list and the account slot.
          Because nav is flex-1 and this block + the account slot are fixed-height siblings, the space is
          carved out above the slot and the slot never jumps when a hover starts/ends. Blank white at rest. */}
      <div className="border-t" style={{ borderColor: "var(--lfb-border)" }}>
        <HoverInfoPanel />
      </div>

      {/* Account slot (bottom; menu expands upward) */}
      <div className="relative border-t p-2" style={{ borderColor: "var(--lfb-border)" }}>
        {menuOpen && (
          <div
            role="menu"
            className="lfb-popover absolute bottom-full left-2 right-2 mb-1 py-1"
            style={{ animation: "lfb-modal-in 120ms cubic-bezier(0.16,1,0.3,1)" }}
          >
            {leftBar.accountMenu
              .filter((m) => !m.permissionGate || (m.permissionGate === "role:admin" && user.roles.includes("admin")))
              .map((m) =>
                m.action === "sign_out" ? (
                  <a key={m.id} href="/api/v1/client/sessions/current/remove"
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-black transition-colors duration-150 hover:bg-slate-100">
                    {m.icon && <NavIcon name={m.icon} className="h-4 w-4" />} {m.label}
                  </a>
                ) : (
                  <Link key={m.id} to={m.route ?? "/"} onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-black transition-colors duration-150 hover:bg-slate-100">
                    {m.icon && <NavIcon name={m.icon} className="h-4 w-4" />} {m.label}
                  </Link>
                ),
              )}
          </div>
        )}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-slate-100"
        >
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--lfb-primary-tint)] text-sm font-semibold text-[var(--lfb-primary)]">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm text-black">{user.name || "Signed in"}</div>
            <div className="truncate text-xs text-black">{user.email}</div>
          </div>
          {/* The slot is a menu trigger; without a chevron it reads as a static identity card. */}
          <NavIcon
            name="ChevronDown"
            className={`h-4 w-4 shrink-0 text-black/40 transition-transform duration-150 ${menuOpen ? "" : "rotate-180"}`}
          />
        </button>
      </div>
    </aside>
  );
}

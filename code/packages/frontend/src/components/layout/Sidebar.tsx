// The one left bar (left_bar.mdx). 256px, white, right border. Content from pm/left_bar.yaml.
// Color rules: all text black; wordmark + active item + sign-in accent stay accent.
// The IPFS item is the one DISCLOSURE parent (ipfs.mdx §2.1): while active it expands into a child
// list of the repos that hold pinned content; a child filters /ipfs to that repo, the parent clears it.
import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { leftBar } from "../../config/left_bar.js";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { useProgress } from "../../progress/ProgressContext.js";
import { NavIcon } from "./NavIcon.js";
import { HoverInfoPanel } from "../hoverinfo/HoverInfoPanel.js";

export function Sidebar({ user }: { user: CurrentUser }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Background-work state for the conditional "Processing" item (processing.mdx §2).
  const { processing, jobs, queued } = useProgress();
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

  return (
    <aside
      className="flex flex-col h-full border-r bg-white"
      style={{ width: leftBar.sidebarWidth, borderColor: "var(--lfb-border)" }}
    >
      {/* Wordmark */}
      <Link
        to={leftBar.clickRoute}
        title={leftBar.wordmarkAlt}
        className="h-14 flex items-center px-4 border-b text-lg font-semibold"
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
          // The IPFS parent is "selected" (unfiltered) only when on /ipfs with no ?repo filter.
          // The Storages parent is "selected" only on the /storages index, not a child detail page.
          const parentSelected = isIpfs ? onIpfs && !activeRepo : isStorages ? path === "/storages" : active;
          return (
            <div key={item.id}>
              <Link
                to={item.route}
                title={item.description}
                className="mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-slate-100"
                style={
                  parentSelected
                    ? { color: "var(--lfb-primary)", background: "var(--lfb-primary-tint)", fontWeight: 500 }
                    : { color: "#000" }
                }
              >
                <NavIcon name={item.icon} className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {isIpfs && onIpfs && pinningRepos.length > 0 && (
                  <NavIcon name="ChevronDown" className="h-3.5 w-3.5 text-black/40" />
                )}
                {isStorages && onStorages && (
                  <NavIcon name="ChevronDown" className="h-3.5 w-3.5 text-black/40" />
                )}
              </Link>

              {/* Storages disclosure children (storages.mdx §2): Personal · companies · Repos · Communities. */}
              {isStorages && onStorages &&
                storageChildren.map((child) => {
                  const childActive = path === child.route || (child.route !== "/" && path.startsWith(child.route));
                  return (
                    <Link
                      key={child.key}
                      to={child.route}
                      title={child.label}
                      className="mx-2 my-0.5 flex items-center gap-2 rounded-md py-1.5 pl-9 pr-3 text-sm hover:bg-slate-100"
                      style={
                        childActive
                          ? { color: "var(--lfb-primary)", background: "var(--lfb-primary-tint)", fontWeight: 500 }
                          : { color: "#000" }
                      }
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
                      className="mx-2 my-0.5 flex items-center gap-2 rounded-md py-1.5 pl-9 pr-3 text-sm hover:bg-slate-100"
                      style={
                        childActive
                          ? { color: "var(--lfb-primary)", background: "var(--lfb-primary-tint)", fontWeight: 500 }
                          : { color: "#000" }
                      }
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
            ONLY while background work runs (a running job, a pending backlog, or an active batch), and
            gone the moment it finishes. Runtime-injected — NOT a static yaml row (documented as a comment
            in left_bar.yaml). Routes to the Processing page. */}
        {processing && (
          <Link
            to="/processing"
            title="Background work in progress"
            className="mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-slate-100"
            style={
              path.startsWith("/processing")
                ? { color: "var(--lfb-primary)", background: "var(--lfb-primary-tint)", fontWeight: 500 }
                : { color: "#000" }
            }
          >
            <NavIcon name="Loader2" className="h-4 w-4 animate-spin" />
            <span className="flex-1">Processing</span>
            {processingCount > 0 && <span className="text-xs text-black/40">{processingCount}</span>}
          </Link>
        )}
      </nav>

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
          <div className="absolute bottom-full left-2 right-2 mb-1 rounded-lg border bg-white shadow-lg py-1"
            style={{ borderColor: "var(--lfb-border)" }}>
            {leftBar.accountMenu
              .filter((m) => !m.permissionGate || (m.permissionGate === "role:admin" && user.roles.includes("admin")))
              .map((m) =>
                m.action === "sign_out" ? (
                  <a key={m.id} href="/api/v1/client/sessions/current/remove"
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-black hover:bg-slate-100">
                    {m.icon && <NavIcon name={m.icon} className="h-4 w-4" />} {m.label}
                  </a>
                ) : (
                  <Link key={m.id} to={m.route ?? "/"} onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-black hover:bg-slate-100">
                    {m.icon && <NavIcon name={m.icon} className="h-4 w-4" />} {m.label}
                  </Link>
                ),
              )}
          </div>
        )}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-100"
        >
          <div className="h-8 w-8 rounded-full bg-[var(--lfb-primary-tint)] text-[var(--lfb-primary)] grid place-items-center text-sm font-semibold">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm text-black">{user.name || "Signed in"}</div>
            <div className="truncate text-xs text-black">{user.email}</div>
          </div>
        </button>
      </div>
    </aside>
  );
}

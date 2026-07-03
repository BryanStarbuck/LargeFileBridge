// The one left bar (left_bar.mdx). 256px, white, right border. Content from pm/left_bar.yaml.
// Color rules: all text black; wordmark + active item + sign-in accent stay accent.
// The IPFS item is the one DISCLOSURE parent (ipfs.mdx §2.1): while active it expands into a child
// list of the repos that hold pinned content; a child filters /ipfs to that repo, the parent clears it.
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { leftBar } from "../../config/left_bar.js";
import { api } from "../../api/client.js";
import { NavIcon } from "./NavIcon.js";

export function Sidebar({ user }: { user: CurrentUser }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const activeRepo = useRouterState({
    select: (s) => (s.location.search as { repo?: string } | undefined)?.repo,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (route: string) => (route === "/" ? path === "/" : path.startsWith(route));
  const onIpfs = path.startsWith("/ipfs");

  // Left-bar children (ipfs.mdx §2.1): the repos that actually hold pins. Fetched only while the IPFS
  // section is active; shares the ["ipfs"] cache with the page so there's no extra request.
  // Subscribe to ONLY the pinning-repos slice of the (potentially large) IPFS payload via `select`
  // (performance.mdx P-09), so the sidebar re-renders only when that list changes — not on every pin
  // update. Shares the ["ipfs"] cache with the page, so there's still no extra request.
  const { data: pinningRepos = [] } = useQuery({
    queryKey: ["ipfs"],
    queryFn: api.ipfs,
    enabled: onIpfs,
    select: (d) => d.repos,
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
          // The IPFS parent is "selected" (unfiltered) only when on /ipfs with no ?repo filter.
          const parentSelected = isIpfs ? onIpfs && !activeRepo : active;
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
              </Link>

              {/* IPFS disclosure children — pinning repos that filter the table (ipfs.mdx §2.1). */}
              {isIpfs && onIpfs &&
                pinningRepos.map((repo) => {
                  const childActive = activeRepo === repo.repoId;
                  return (
                    <Link
                      key={repo.repoId}
                      to="/ipfs"
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
      </nav>

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

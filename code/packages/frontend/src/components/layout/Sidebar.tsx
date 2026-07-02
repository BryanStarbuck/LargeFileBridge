// The one left bar (left_bar.mdx). 256px, white, right border. Content from pm/left_bar.yaml.
// Color rules: all text black; wordmark + active item + sign-in accent stay accent.
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { CurrentUser } from "@lfb/shared";
import { leftBar } from "../../config/left_bar.js";
import { NavIcon } from "./NavIcon.js";

export function Sidebar({ user }: { user: CurrentUser }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (route: string) => (route === "/" ? path === "/" : path.startsWith(route));

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
          return (
            <Link
              key={item.id}
              to={item.route}
              title={item.description}
              className="mx-2 my-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-slate-100"
              style={
                active
                  ? { color: "var(--lfb-primary)", background: "var(--lfb-primary-tint)", fontWeight: 500 }
                  : { color: "#000" }
              }
            >
              <NavIcon name={item.icon} className="h-4 w-4" />
              {item.label}
            </Link>
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

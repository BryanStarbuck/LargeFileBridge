// The app frame: the one left bar + the routed content column (repos.mdx §2 layout).
import { Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Sidebar } from "../../components/layout/Sidebar.js";

const FALLBACK: CurrentUser = {
  authenticated: false,
  email: null,
  name: null,
  roles: [],
  permissions: [],
  allowListed: false,
};

export function AppShell() {
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: api.me });
  return (
    <div className="flex h-full">
      <Sidebar user={user ?? FALLBACK} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

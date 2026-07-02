// Code-based TanStack Router (sister convention). Auth gating happens in main.tsx (outside the tree).
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "./pages/app/AppShell.js";
import { ReposPage } from "./pages/repos/ReposPage.js";
import { OneRepoPage } from "./pages/repos/OneRepoPage.js";
import { RepoSettingsPage } from "./pages/repos/RepoSettingsPage.js";
import { PeersPage } from "./pages/peers/PeersPage.js";
import { SyncPage } from "./pages/sync/SyncPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { AllowListPage } from "./pages/settings/AllowListPage.js";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const reposRoute = createRoute({ getParentRoute: () => appLayout, path: "/", component: ReposPage });
const repoSettingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId/settings",
  component: RepoSettingsPage,
});
const oneRepoRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId",
  component: OneRepoPage,
});
const peersRoute = createRoute({ getParentRoute: () => appLayout, path: "/peers", component: PeersPage });
const syncRoute = createRoute({ getParentRoute: () => appLayout, path: "/sync", component: SyncPage });
const allowListRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings/allow-list",
  component: AllowListPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  appLayout.addChildren([
    reposRoute,
    repoSettingsRoute,
    oneRepoRoute,
    peersRoute,
    syncRoute,
    allowListRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

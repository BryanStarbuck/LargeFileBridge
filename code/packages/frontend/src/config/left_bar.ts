// Render the left bar straight from pm/left_bar.yaml (left_bar.mdx §AC4 — no code copy of the nav).
import YAML from "yaml";
import { clientLog } from "../lib/clientLog.js";
// Vite ?raw import; fs.allow grants read access to the repo root (vite.config.ts).
import rawYaml from "../../../../../pm/left_bar.yaml?raw";

export interface NavChild {
  id: string;
  label: string;
  route: string;
  description?: string;
}
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  route: string;
  order: number;
  description?: string;
  children?: NavChild[]; // static disclosure children (e.g. Storages → Personal/Repos/Communities)
}
export interface AccountMenuItem {
  id: string;
  label: string;
  icon?: string;
  route?: string;
  action?: string;
  permissionGate?: string;
}
export interface LeftBar {
  wordmark: string;
  wordmarkAlt: string;
  clickRoute: string;
  navItems: NavItem[];
  accountMenu: AccountMenuItem[];
  sidebarWidth: string;
}

interface RawBar {
  Location?: string;
  header?: { label?: string; alt_text?: string; click_route?: string };
  sidebar_width?: string;
  nav_items?: Array<{
    id: string;
    label: string;
    icon: string;
    route: string;
    order: number;
    description?: string;
    children?: Array<{ id: string; label: string; route: string; description?: string }>;
  }>;
  footer?: Array<{
    menu_items?: Array<{
      id: string;
      label: string;
      icon?: string;
      route?: string;
      action?: string;
      permission_gate?: string;
    }>;
  }>;
}

// A safe, empty-nav fallback so a malformed left_bar.yaml degrades the sidebar instead of crashing
// the whole app at import time (this parse() runs at module load).
const FALLBACK: LeftBar = {
  wordmark: "Large File Bridge",
  wordmarkAlt: "Large File Bridge",
  clickRoute: "/",
  navItems: [],
  accountMenu: [],
  sidebarWidth: "256px",
};

function parse(): LeftBar {
  try {
    const doc = YAML.parse(rawYaml) as { Left_Nav?: { Left_bars?: RawBar[] } };
    const bars = doc.Left_Nav?.Left_bars ?? [];
    const app = bars.find((b) => b.Location === "app") ?? bars[0] ?? {};
    const navItems = (app.nav_items ?? [])
      .map((n) => ({ ...n }))
      .sort((a, b) => a.order - b.order);
    const accountMenu = (app.footer?.[0]?.menu_items ?? []).map((m) => ({
      id: m.id,
      label: m.label,
      icon: m.icon,
      route: m.route,
      action: m.action,
      permissionGate: m.permission_gate,
    }));
    return {
      wordmark: app.header?.label ?? "Large File Bridge",
      wordmarkAlt: app.header?.alt_text ?? "Large File Bridge",
      clickRoute: app.header?.click_route ?? "/",
      navItems,
      accountMenu,
      sidebarWidth: app.sidebar_width ?? "256px",
    };
  } catch (e) {
    // Malformed / missing YAML — log and fall back so the app still boots with a bare sidebar.
    clientLog.error("leftBar.parse", e);
    return FALLBACK;
  }
}

export const leftBar: LeftBar = parse();

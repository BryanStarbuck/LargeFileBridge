// Global keyboard shortcuts + the "?" help overlay (hotkeys.mdx). Every page can register a scope of
// hotkeys while it is mounted; a single window listener matches keystrokes against all live scopes.
//
// The modifier is platform-aware (hotkeys.mdx §1): a hotkey like "R" fires on **Control+R on macOS** and
// **Alt+R on Windows/Linux** — chosen because those combos don't collide with the OS/browser shortcuts
// (⌘ on Mac, Ctrl on Windows). Two keys are "bare" (no modifier): **?** toggles the help overlay and
// **/** focuses the page's search box.
//
// Scopes are matched most-recently-registered first, so a page scope (mounted later) wins a key
// collision with the always-present global scope — hotkeys are context-sensitive to the current page.
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// ── platform modifier ──────────────────────────────────────────────────────────────
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(`${navigator.platform} ${navigator.userAgent}`);
/** The word the help overlay prints for the modifier ("Control" on Mac, "Alt" elsewhere). */
export const MODIFIER_LABEL = IS_MAC ? "Control" : "Alt";
/** The compact symbol used in chips ("⌃" on Mac, "Alt" elsewhere). */
export const MODIFIER_SYMBOL = IS_MAC ? "⌃" : "Alt";

/** True when exactly the platform hotkey modifier is held (Control on Mac, Alt on Win/Linux) and no
 *  other modifier — so it never clobbers ⌘/Ctrl browser shortcuts. */
function platformModifier(e: KeyboardEvent): boolean {
  return IS_MAC
    ? e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

// ── the hotkey model ────────────────────────────────────────────────────────────────
export interface Hotkey {
  /** The character to match, case-insensitive (e.g. "r", "?", "/"). */
  keys: string;
  /** What the hotkey does — shown in the help overlay. */
  label: string;
  /** The action to run. */
  run: () => void;
  /** Rare: a bare key with NO platform modifier (only "?" and "/" globally). Default false. */
  bare?: boolean;
}
export interface HotkeyGroup {
  id: string;
  title: string; // "Global" | "Media viewer" | …
  hotkeys: Hotkey[];
}

// ── the live registry (module singleton) ────────────────────────────────────────────
// A getter is stored (not a snapshot) so the matcher and the overlay always call the LATEST closures,
// even if a page re-renders with new handlers without re-registering.
interface RegEntry { id: string; title: string; get: () => Hotkey[]; }
const registry: RegEntry[] = [];
const membershipListeners = new Set<() => void>();
let membershipVersion = 0;
function notifyMembership() {
  membershipVersion++;
  membershipListeners.forEach((l) => l());
}
function registerGroup(entry: RegEntry): () => void {
  registry.push(entry);
  notifyMembership();
  return () => {
    const i = registry.indexOf(entry);
    if (i >= 0) registry.splice(i, 1);
    notifyMembership();
  };
}
function subscribeMembership(cb: () => void): () => void {
  membershipListeners.add(cb);
  return () => membershipListeners.delete(cb);
}

// ── the "/" search-focus fallback (hotkeys.mdx §2) ──────────────────────────────────
// A generic win: "/" focuses the first search box on the page — no per-page wiring needed.
function focusPageSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>(
    'input[type="search"], input[role="searchbox"], input[placeholder*="earch"]',
  );
  if (el) { el.focus(); el.select(); return true; }
  return false;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// ── context (only exposes the help-overlay toggle to consumers) ──────────────────────
interface HotkeyCtx { openHelp: () => void; }
const HotkeyContext = createContext<HotkeyCtx | null>(null);

/** Mount once near the app root. Installs the single global key listener and hosts the help overlay. */
export function HotkeyProvider({ children }: { children: ReactNode }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target);

      // Escape closes the overlay (even while typing, so it's always dismissible).
      if (e.key === "Escape") { if (helpOpenRef.current) { e.preventDefault(); setHelpOpen(false); } return; }

      if (typing) return; // never fire app hotkeys while the user is typing in a field

      // Bare "?" (Shift+/) toggles the help overlay.
      if (e.key === "?") { e.preventDefault(); setHelpOpen((o) => !o); return; }
      // Bare "/" focuses the page's search box.
      if (e.key === "/" && !platformModifier(e) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (focusPageSearch()) e.preventDefault();
        return;
      }

      const mod = platformModifier(e);
      // Most-recently-registered scope first → a page scope wins a collision with the global scope.
      for (let i = registry.length - 1; i >= 0; i--) {
        for (const h of registry[i].get()) {
          if (h.keys === "?" || h.keys === "/") continue; // reserved, handled above
          const wantsMod = !h.bare;
          if (wantsMod && !mod) continue;
          if (!wantsMod && (e.ctrlKey || e.altKey || e.metaKey)) continue;
          if (e.key.toLowerCase() === h.keys.toLowerCase()) {
            e.preventDefault();
            h.run();
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openHelp = useCallback(() => setHelpOpen(true), []);

  return (
    <HotkeyContext.Provider value={{ openHelp }}>
      {children}
      {/* A small always-present affordance so the shortcut is discoverable without knowing "?". */}
      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        title={`Keyboard shortcuts (?)  ·  modifier: ${MODIFIER_LABEL}`}
        aria-label="Keyboard shortcuts"
        className="fixed bottom-3 right-3 z-40 grid h-7 w-7 place-items-center rounded-full border border-[var(--lfb-border)] bg-white text-sm font-semibold text-black/50 shadow-sm hover:text-black"
      >
        ?
      </button>
      {helpOpen && <HotkeyHelpOverlay onClose={() => setHelpOpen(false)} />}
    </HotkeyContext.Provider>
  );
}

/** Toggle the help overlay imperatively (e.g. from a menu item). */
export function useHotkeyHelp(): () => void {
  const ctx = useContext(HotkeyContext);
  return ctx?.openHelp ?? (() => {});
}

/** Register a scope of hotkeys for the lifetime of the calling component (hotkeys.mdx §2). The array
 *  may hold fresh closures each render — they are read live via a ref, so you do NOT need to memoize it. */
export function useHotkeys(id: string, title: string, hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys);
  ref.current = hotkeys; // keep the latest closures without re-registering
  useEffect(() => {
    return registerGroup({ id, title, get: () => ref.current });
  }, [id, title]);
}

// ── the help overlay (hotkeys.mdx §3) ────────────────────────────────────────────────
function HotkeyHelpOverlay({ onClose }: { onClose: () => void }) {
  // Re-read the registry whenever scopes mount/unmount while the overlay is open.
  useSyncExternalStore(subscribeMembership, () => membershipVersion, () => membershipVersion);
  // Merge scopes that share a title (a page may register more than one), preserving first-seen order.
  const byTitle = new Map<string, Hotkey[]>();
  for (const entry of registry) {
    const list = byTitle.get(entry.title) ?? [];
    list.push(...entry.get().filter((h) => h.keys !== "/" && h.keys !== "?"));
    byTitle.set(entry.title, list);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-[var(--lfb-border)] bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-black">Keyboard shortcuts</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-black/50 hover:bg-slate-100 hover:text-black">Esc</button>
        </div>
        <p className="mb-4 text-xs text-black/50">
          Modifier on this computer: <KeyCap>{MODIFIER_LABEL}</KeyCap>. Press a shortcut with the modifier
          held (e.g. <KeyCap>{MODIFIER_SYMBOL}</KeyCap>+<KeyCap>R</KeyCap>). <KeyCap>?</KeyCap> opens this
          list; <KeyCap>/</KeyCap> jumps to search; <KeyCap>Esc</KeyCap> closes.
        </p>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {[...byTitle.entries()].map(([title, hotkeys]) => (
            <section key={title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/40">{title}</h3>
              <ul className="space-y-1.5">
                {hotkeys.map((h, i) => (
                  <li key={`${h.keys}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-black/80">{h.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {!h.bare && <><KeyCap>{MODIFIER_SYMBOL}</KeyCap><span className="text-black/30">+</span></>}
                      <KeyCap>{h.keys.length === 1 ? h.keys.toUpperCase() : h.keys}</KeyCap>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-black/15 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-black/70 shadow-[0_1px_0_rgba(0,0,0,0.08)]">
      {children}
    </kbd>
  );
}

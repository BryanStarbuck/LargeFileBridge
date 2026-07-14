// Imperative in-app modal helpers (dialogs.mdx §1–§3) — the app NEVER calls window.confirm / window.alert
// / window.prompt. Those OS "hard" dialogs can't be themed, block the whole tab, and carry no preview or
// count. Instead a click handler `await`s one of these promise-returning helpers, which push a request onto
// a single-slot bus; the ModalHost mounted once at the app root renders the matching ConfirmDialog /
// PromptDialog and resolves the promise on the user's choice. Same pattern as setupWizard.ts /
// lib/transcribe.ts requestModelConsent — no per-call-site React state.
import type { ReactNode } from "react";

export interface ConfirmRequest {
  kind: "confirm";
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Resolved true = confirmed, false = cancelled / Esc / backdrop. */
  resolve: (ok: boolean) => void;
}

export interface PromptRequest {
  kind: "prompt";
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error string to block Confirm (kept enabled only when this returns null/empty). */
  validate?: (v: string) => string | null;
  /** Resolved with the typed value, or null on cancel / Esc / backdrop. */
  resolve: (value: string | null) => void;
}

export type ModalRequest = ConfirmRequest | PromptRequest;
type Listener = (req: ModalRequest) => void;

// Exactly one ModalHost is mounted, so a single-slot listener is all we need.
let listener: Listener | null = null;

/** The ModalHost registers here; returns an unsubscribe for its effect cleanup. */
export function onModalRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/**
 * Open an in-app confirm modal (ConfirmDialog) and resolve true/false. Replaces every `window.confirm`:
 *   if (!(await confirmModal({ title: "…", danger: true }))) return;
 * If no host is mounted (shouldn't happen in the signed-in app), resolves false — a safe "cancelled".
 */
export function confirmModal(opts: Omit<ConfirmRequest, "kind" | "resolve">): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!listener) {
      resolve(false);
      return;
    }
    listener({ kind: "confirm", ...opts, resolve });
  });
}

/**
 * Open an in-app single-text-input modal (PromptDialog) and resolve the typed string, or null on cancel.
 * Replaces every `window.prompt`:  const dest = await promptModal({ title: "…", defaultValue: cur });
 */
export function promptModal(opts: Omit<PromptRequest, "kind" | "resolve">): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (!listener) {
      resolve(null);
      return;
    }
    listener({ kind: "prompt", ...opts, resolve });
  });
}

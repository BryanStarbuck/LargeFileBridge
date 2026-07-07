// Central registry of AI-description model defaults + the Gemini models Google has RETIRED. Both the
// adapter (which calls the model, adapters.ts) and the config loader (which heals a stale pinned model,
// config.service.ts) import from here so there is ONE source of truth. This file imports nothing, so it
// can't create an import cycle. See ai_description.mdx §5.1 (model lifecycle / deprecation handling).
//
// Why this exists: Google hard-retires older Gemini versions on a schedule (e.g. gemini-2.0-flash on
// 2026-06-01). After the retirement date generateContent returns `404 NOT_FOUND ... is no longer
// available`, so a config that stays pinned to a retired model can NEVER succeed. We keep the retired set
// here and auto-upgrade a pinned retired model to the current default on load.

/** Default Gemini model — the only provider that describes BOTH image and video. We default to the
 *  `gemini-flash-latest` ALIAS on purpose: Google hot-swaps it to the newest GA Flash (with 2-week
 *  notice) so this app auto-tracks new releases and NEVER hard-breaks on a model retirement the way a
 *  pinned id does. As of 2026-07 the alias resolves to Gemini 3.5 Flash. A user can still pin a concrete
 *  id in Settings → AI; only RETIRED ids get force-upgraded (see RETIRED_GEMINI_MODELS). */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
export const DEFAULT_GROK_MODEL = "grok-2-vision-1212";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** Gemini model ids Google has RETIRED. A config pinned to one of these returns 404 forever, so we
 *  auto-heal it to DEFAULT_GEMINI_MODEL on load. Append-only — add ids here as Google retires more. */
export const RETIRED_GEMINI_MODELS = new Set<string>([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
  "gemini-1.5-flash",
  "gemini-1.5-flash-002",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-1.5-pro-002",
  "gemini-pro-vision",
]);

/** True when `msg` (a provider error string) looks like a retired / unknown-model failure — a 404 or a
 *  Google "no longer available" / NOT_FOUND response. Drives the actionable error we surface. */
export function looksLikeModelRetired(msg: string): boolean {
  return /\b404\b/.test(msg) || /no longer available|not[_\s]?found|is not found/i.test(msg);
}

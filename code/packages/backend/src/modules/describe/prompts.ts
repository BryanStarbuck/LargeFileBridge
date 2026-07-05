// The AI-description PROMPT files (ai_description.mdx §4). One prompt per media kind (image, video) is
// checked into the repo beside this module (./prompts/{image,video}.md). The user can CUSTOMIZE a prompt
// from their settings: doing so COPIES the checked-in default into a per-computer override under the
// state dir (<state>/describe/prompts/<kind>.md) and, once that copy exists, it is the prompt that is
// used. Reset deletes the override and falls back to the shipped default. Nothing here touches the
// network — it only resolves which text is passed to an adapter (adapters.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DescribeKind, DescribePromptView } from "@lfb/shared";
import { resolveStateDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

// The checked-in defaults live next to this file (works under tsx + a compiled build via import.meta.url).
const SHIPPED_DIR = fileURLToPath(new URL("./prompts/", import.meta.url));

function shippedPath(kind: DescribeKind): string {
  return path.join(SHIPPED_DIR, `${kind}.md`);
}
function overrideDir(): string {
  return path.join(resolveStateDir(), "describe", "prompts");
}
function overridePath(kind: DescribeKind): string {
  return path.join(overrideDir(), `${kind}.md`);
}
function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The prompt TEXT actually used for a kind: the per-computer override if present, else the shipped default. */
export function getPrompt(kind: DescribeKind): string {
  const ov = overridePath(kind);
  if (exists(ov)) {
    try {
      return fs.readFileSync(ov, "utf8");
    } catch (e) {
      log.warn("describe", `override prompt unreadable (${ov}), using default: ${(e as Error).message}`);
    }
  }
  return fs.readFileSync(shippedPath(kind), "utf8");
}

/** The prompt as the settings UI sees it: its text, whether it is an override, and where it lives. */
export function promptView(kind: DescribeKind): DescribePromptView {
  const ov = overridePath(kind);
  const isOverride = exists(ov);
  return { kind, text: getPrompt(kind), isOverride, path: isOverride ? ov : shippedPath(kind) };
}

/** Copy the shipped default into the per-computer override so the user can edit it, then return the view. */
export function customizePrompt(kind: DescribeKind): DescribePromptView {
  const ov = overridePath(kind);
  if (!exists(ov)) {
    fs.mkdirSync(overrideDir(), { recursive: true });
    fs.writeFileSync(ov, fs.readFileSync(shippedPath(kind), "utf8"), "utf8");
    log.info("describe", `prompt customized (copied default → ${ov})`);
  }
  return promptView(kind);
}

/** Save edited override text for a kind (creates the override if it didn't exist). */
export function savePrompt(kind: DescribeKind, text: string): DescribePromptView {
  fs.mkdirSync(overrideDir(), { recursive: true });
  fs.writeFileSync(overridePath(kind), text, "utf8");
  return promptView(kind);
}

/** Delete the override for a kind, reverting to the shipped default. */
export function resetPrompt(kind: DescribeKind): DescribePromptView {
  try {
    fs.unlinkSync(overridePath(kind));
  } catch {
    /* already default */
  }
  return promptView(kind);
}

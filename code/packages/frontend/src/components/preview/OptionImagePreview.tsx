// The Option-key floating image preview (option_image_preview.mdx). Hold Option (Alt) while hovering a
// file row that is an image and a floating preview appears, placed by the four-corner biggest-fit
// geometry (§2); release Option → gone, press again while still hovering → back, hover off → gone (§1).
// One layer is mounted app-wide (AppShell); surfaces opt in by publishing their hover target through
// setOptionPreviewTarget — the same singleton-publisher pattern as the hover-info region, so a generic
// table row doesn't need context plumbing to participate.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";

// ── The four-corner geometry test (option_image_preview.mdx §2) ────────────────

export interface PreviewPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  corner: "tl" | "tr" | "bl" | "br";
}

// Near point: the cursor moved 10px TOWARD the corner under test, on both axes. Far point: the screen
// corner inset 5px toward the center — the closest the preview ever gets to the physical corner.
const NEAR_GAP = 10;
const CORNER_INSET = 5;

/**
 * Pick the screen corner whose candidate rectangle — spanning from the cursor (moved 10px toward that
 * corner) to the corner itself (inset 5px) — fits the LARGEST aspect-true preview. The fitted image is
 * anchored at the far point (it hugs the corner) and extends toward the cursor; it is never upscaled
 * past the image's natural size. Returns null when no corner has any room (degenerate cursor position).
 */
export function bestPreviewPlacement(
  cursor: { x: number; y: number },
  viewport: { w: number; h: number },
  natural: { w: number; h: number },
): PreviewPlacement | null {
  if (natural.w <= 0 || natural.h <= 0) return null;
  const corners: { corner: PreviewPlacement["corner"]; left: boolean; top: boolean }[] = [
    { corner: "tl", left: true, top: true },
    { corner: "tr", left: false, top: true },
    { corner: "bl", left: true, top: false },
    { corner: "br", left: false, top: false },
  ];
  let best: PreviewPlacement | null = null;
  for (const c of corners) {
    // Available span between the near point and the far point, per axis. A cursor already within
    // 15px of a corner leaves that corner no room — the candidate collapses to zero.
    const nearX = cursor.x + (c.left ? -NEAR_GAP : NEAR_GAP);
    const nearY = cursor.y + (c.top ? -NEAR_GAP : NEAR_GAP);
    const availW = c.left ? nearX - CORNER_INSET : viewport.w - CORNER_INSET - nearX;
    const availH = c.top ? nearY - CORNER_INSET : viewport.h - CORNER_INSET - nearY;
    if (availW <= 0 || availH <= 0) continue;
    // Aspect-true fit, capped at natural size (never upscale — §2).
    const scale = Math.min(availW / natural.w, availH / natural.h, 1);
    const width = natural.w * scale;
    const height = natural.h * scale;
    if (width < 1 || height < 1) continue;
    if (best && width * height <= best.width * best.height) continue;
    best = {
      corner: c.corner,
      width,
      height,
      // Anchored at the far point: the preview hugs the winning corner, 5px in, on both axes.
      left: c.left ? CORNER_INSET : viewport.w - CORNER_INSET - width,
      top: c.top ? CORNER_INSET : viewport.h - CORNER_INSET - height,
    };
  }
  return best;
}

// ── The singleton hover-target publisher ───────────────────────────────────────
// Rows publish "the pointer is over THIS image file" (absolute path) or null on leave. Coordinates come
// from the enter event so the very first frame can place the preview before any mousemove arrives.

type TargetListener = (path: string | null) => void;
let currentTarget: string | null = null;
let listener: TargetListener | null = null;

export function setOptionPreviewTarget(path: string | null, x?: number, y?: number): void {
  currentTarget = path;
  if (x !== undefined && y !== undefined) lastCursor = { x, y };
  listener?.(path);
}

let lastCursor: { x: number; y: number } | null = null;

// ── The layer ──────────────────────────────────────────────────────────────────

export function OptionImagePreviewLayer() {
  const [target, setTarget] = useState<string | null>(currentTarget);
  const [altDown, setAltDown] = useState(false);
  const [grantUrl, setGrantUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [, forceTick] = useState(0); // re-render on cursor moves while visible (placement follows the cursor)

  useEffect(() => {
    listener = setTarget;
    return () => {
      listener = null;
    };
  }, []);

  // Option/Alt tracking (§1). Keydown/keyup carry key === "Alt"; a window blur (e.g. ⌥-Tab away) resets
  // so the preview can't stick on. Mousemove also syncs from e.altKey — the authoritative live state —
  // covering a keydown that happened while the window wasn't focused.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(false);
    };
    const blur = () => setAltDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Cursor tracking — only while a target is hovered, so the app pays nothing the rest of the time.
  useEffect(() => {
    if (!target) return;
    const move = (e: MouseEvent) => {
      lastCursor = { x: e.clientX, y: e.clientY };
      setAltDown(e.altKey);
      forceTick((t) => t + 1);
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, [target]);

  const wantShow = altDown && !!target;

  // Resolve the signed media grant per shown target (option_image_preview.mdx §4) — the same short-lived
  // same-origin URL the media viewer loads from, so the preview is exactly as private as opening the file.
  const grantFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wantShow || !target) return;
    if (grantFor.current === target && grantUrl) return; // already resolved for this hover
    let cancelled = false;
    grantFor.current = target;
    setGrantUrl(null);
    setNatural(null);
    api
      .mediaGrant(target)
      .then((g) => {
        if (!cancelled && grantFor.current === target) setGrantUrl(g.url);
      })
      .catch(() => {
        // A failed grant (file gone, not allow-listed) simply shows no preview (§3).
        if (!cancelled && grantFor.current === target) setGrantUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wantShow, target, grantUrl]);

  // Drop the resolved bytes when the hover target changes/clears (a re-press on the SAME row reuses them).
  useEffect(() => {
    if (target !== grantFor.current) {
      grantFor.current = null;
      setGrantUrl(null);
      setNatural(null);
    }
  }, [target]);

  if (!wantShow || !grantUrl) return null;

  const placement =
    natural && lastCursor
      ? bestPreviewPlacement(lastCursor, { w: window.innerWidth, h: window.innerHeight }, natural)
      : null;

  return (
    <img
      src={grantUrl}
      alt=""
      // Natural size arrives with the bytes; until then the img is parked offscreen (nothing renders
      // while loading — §3). onError clears the grant so an undecodable file shows nothing, ever.
      onLoad={(e) => {
        const el = e.currentTarget;
        if (el.naturalWidth > 0) setNatural({ w: el.naturalWidth, h: el.naturalHeight });
      }}
      onError={() => setGrantUrl(null)}
      style={
        placement
          ? {
              position: "fixed",
              left: placement.left,
              top: placement.top,
              width: placement.width,
              height: placement.height,
              zIndex: 90,
              pointerEvents: "none", // an overlay, not an obstacle (§3)
              borderRadius: 6,
              border: "1px solid rgba(0,0,0,0.15)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
              background: "white",
              objectFit: "contain",
            }
          : { position: "fixed", left: -10000, top: -10000, width: 1, height: 1, pointerEvents: "none" }
      }
    />
  );
}

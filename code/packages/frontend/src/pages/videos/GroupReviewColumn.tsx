// The right review column (duplicates.mdx §4, LOCKED; subsets.mdx §4 deltas): the group's members for
// side-by-side review. Its own overflow-y scroll region, independent of the table and page.
// Top-to-bottom: the action-links row (exactly "Done" for now) → the literal "All files are the same:"
// block listing the COMMON attributes comma-space separated → one FILE BLOCK per member — the five icon
// controls, then the file name, then a full-column-width aspect-preserving preview, then that member's
// DIFFERING attributes. An attribute appears in the common block OR under the previews — never both
// (§4.2/§4.3).
//
// Print rules (LOCKED): resolution and codec strings come ONLY from the shared helpers
// resolutionLabel() / codecLabel() (duplicates.mdx §4.4–§4.5); sizes via the house formatBytes.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Play } from "lucide-react";
import { codecLabel, formatBytes, mediaKindForName, resolutionLabel } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageActions } from "../../components/menu/PageActions.js";
import { TaskIconCell } from "../../components/table/taskIcons.js";
import { clientLog } from "../../lib/clientLog.js";
import { ICON_KINDS, formatClock, formatOffset, memberTaskState, type VideoMember } from "./videoGroups.js";

export type ReviewVariant = "duplicates" | "subsets";

interface AttributeSplit {
  /** The comma-space list after "All files are the same:" (§4.2 vocabulary + order). */
  common: string[];
  /** The differing attributes printed for one member, in §4.3 order (codec, duration, size, resolution). */
  differingOf: (m: VideoMember) => string[];
}

const DURATION_TOLERANCE_S = 0.5; // durations equal within ±0.5 s count as the same (§4.2)

/**
 * Split the §4.2 attribute vocabulary into common vs differing, computed client-side from the group's
 * rows. SHA-256 and Fingerprint only ever surface in the common block (the §4.2 example for a
 * fingerprint-basis group lists the differing sha nowhere) — the other four print per member when they
 * differ, using the member's own value.
 */
export function computeAttributeSplit(members: VideoMember[], variant: ReviewVariant): AttributeSplit {
  const allEqual = <V,>(vals: V[]): boolean => vals.every((v) => v === vals[0]);

  const sizeCommon = allEqual(members.map((m) => m.sizeBytes));
  const shaCommon = allEqual(members.map((m) => m.sha256));
  // Duplicates: a fingerprint-basis group matched within threshold by definition; byte-identical groups
  // count when the stored strings agree AND exist — an all-empty column (fingerprinting failed or was
  // skipped) must not read as "same fingerprint". Subsets: the signature references always differ — never listed.
  const fpCommon =
    variant === "duplicates" &&
    (members[0]?.matchBasis === "fingerprint" ||
      (members.every((m) => m.fingerprint !== "") && allEqual(members.map((m) => m.fingerprint))));

  const durations = members.map((m) => m.durationS);
  const durationsKnown = durations.every((d): d is number => d != null);
  const durationCommon =
    durationsKnown &&
    durations.length > 0 &&
    Math.max(...durations) - Math.min(...durations) <= DURATION_TOLERANCE_S;
  const durationApplies = members.some((m) => m.durationS != null); // videos only — absent for images

  const dims = members.map((m) => (m.width != null && m.height != null ? `${m.width}x${m.height}` : null));
  const resolutionKnown = dims.every((d) => d != null);
  const resolutionCommon = resolutionKnown && allEqual(dims);
  const resolutionApplies = dims.some((d) => d != null);

  const codecs = members.map((m) => m.codec);
  const codecCommon = codecs.every((c) => c != null) && allEqual(codecs);
  const codecApplies = codecs.some((c) => c != null);

  const common: string[] = [];
  if (sizeCommon) common.push("File size");
  if (shaCommon) common.push("SHA-256 hash");
  if (fpCommon) common.push("Fingerprint");
  if (durationApplies && durationCommon) common.push("duration");
  if (resolutionCommon && members[0]?.width != null && members[0]?.height != null)
    common.push(`resolution ${resolutionLabel(members[0].width, members[0].height)}`);
  if (codecCommon && members[0]?.codec) common.push(codecLabel(members[0].codec));

  const differingOf = (m: VideoMember): string[] => {
    const out: string[] = [];
    if (codecApplies && !codecCommon && m.codec) out.push(codecLabel(m.codec));
    if (durationApplies && !durationCommon && m.durationS != null)
      out.push(`duration ${formatClock(m.durationS)}`);
    if (!sizeCommon) out.push(formatBytes(m.sizeBytes));
    if (resolutionApplies && !resolutionCommon && m.width != null && m.height != null)
      out.push(resolutionLabel(m.width, m.height));
    return out;
  };

  return { common, differingOf };
}

export function GroupReviewColumn({
  variant,
  members,
  onDone,
}: {
  variant: ReviewVariant;
  /** The group's members in display order (subsets: superset first — subsets.mdx §4). */
  members: VideoMember[];
  /** "Done" — deselects the group and clears the column (duplicates.mdx §4.1). */
  onDone: () => void;
}) {
  const { common, differingOf } = computeAttributeSplit(members, variant);
  const supersetName = members.find((m) => m.role === "superset")?.name ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* §4.1 — the action-links row pinned at the top; exactly "Done" for now (the reserved home for
          future per-group actions). House action-link styling via PageActions. */}
      <div className="relative z-30 shrink-0 border-b border-[var(--lfb-border)] pb-2">
        <PageActions
          actions={[
            {
              id: "done",
              label: "Done",
              icon: <Check className="h-3.5 w-3.5" />,
              group: "Work",
              onSelect: onDone,
            },
          ]}
        />
      </div>

      {/* The column's OWN scroll region (§4) — the table and page never move while this scrolls. */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {common.length > 0 && (
          <div className="border-b border-[var(--lfb-border)] py-3 text-sm text-black/70">
            <span className="font-medium text-black">All files are the same:</span> {common.join(", ")}
          </div>
        )}

        {members.map((m) => {
          const isSuperset = variant === "subsets" && m.role === "superset";
          const isSubset = variant === "subsets" && m.role === "subset";
          const differing = differingOf(m);
          return (
            <div key={m.fullPath} className="border-b border-[var(--lfb-border)] py-3">
              {/* §4.3 header line: the five icon controls, then the bold basename (subsets label the
                  superset block — subsets.mdx §4). The icons live HERE, with the file they describe,
                  because the table's rows are GROUPS now and have no per-file line to carry them. */}
              <div className="flex items-start gap-2">
                <span className="flex shrink-0 items-center gap-0.5 pt-0.5">
                  {ICON_KINDS.map((kind) => (
                    <TaskIconCell key={kind} kind={kind} state={memberTaskState(m, kind)} />
                  ))}
                </span>
                <span className="min-w-0 break-words text-sm font-semibold text-black">
                  {isSuperset && (
                    <span className="mr-1.5 rounded bg-[var(--lfb-primary-tint)] px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-wide text-[var(--lfb-primary)]">
                      SUPERSET
                    </span>
                  )}
                  {m.name}
                </span>
              </div>
              <div className="break-all text-xs text-black/45">{m.fullPath}</div>
              {isSubset && m.startOffsetS != null && m.endOffsetS != null && (
                <div className="mt-0.5 text-xs text-black/60">
                  Contained at {formatOffset(m.startOffsetS)}–{formatOffset(m.endOffsetS)} of {supersetName}
                </div>
              )}
              <MemberPreview member={m} />
              {differing.length > 0 && (
                <div className="mt-1.5 text-sm text-black/70">{differing.join(", ")}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The media preview (§4.3, LOCKED): full column width, aspect ratio ALWAYS kept — never cropped,
 * stretched, or fixed-height.
 *
 * POSTER FIRST, PLAYER ON CLICK (§4.3a — the fix for "the previews never load"). A group holds up to a
 * dozen members and this column renders them ALL. Mounting a dozen live <video src="/api/media/raw">
 * elements is self-defeating: a browser allows ~6 connections per origin over HTTP/1.1 and a media
 * element HOLDS its connection while it buffers, so the first few players consume every socket, the rest
 * never start, and the page's own /api calls (the grants for those very members) queue behind them. So
 * each block loads ONE small cached JPEG from /api/media/poster — which also renders formats the browser
 * cannot decode at all (HEIC, ProRes, HEVC), because the backend does the decoding. Clicking a video's
 * poster swaps in the real <video autoPlay controls>, and only then does a stream get opened.
 */
function MemberPreview({ member }: { member: VideoMember }) {
  const kind = mediaKindForName(member.name);
  const previewable = kind === "image" || kind === "video";
  const [playing, setPlaying] = useState(false);
  // Native decode failed → retry through the backend transcode pipe, exactly as the media viewer does
  // (codecs.mdx §6). Only if THAT fails do we say the preview is unavailable.
  const [videoFallback, setVideoFallback] = useState(false);
  const [failed, setFailed] = useState(false);

  const {
    data: grant,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["media-grant", member.fullPath], // shares the MediaViewer's grant cache
    queryFn: () => api.mediaGrant(member.fullPath),
    enabled: previewable,
    // A grant is a 10-minute capability (media.service.ts GRANT_TTL_MS). Refetch inside that window so a
    // review column left open on screen never starts serving 403s from expired URLs.
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
  });

  // A new file in the block resets the transient player state (React reuses the component by position).
  useEffect(() => {
    setPlaying(false);
    setVideoFallback(false);
    setFailed(false);
  }, [member.fullPath]);

  if (!previewable) return null;
  const ratio = member.width && member.height ? `${member.width} / ${member.height}` : "16 / 9";

  if (isError || failed) {
    return (
      <div
        className="mt-2 grid w-full place-items-center rounded bg-slate-50 px-3 text-center text-xs text-black/45"
        style={{ aspectRatio: ratio }}
      >
        <span>
          Preview unavailable —{" "}
          <button
            className="text-[var(--lfb-primary)] underline underline-offset-2"
            onClick={() => {
              setFailed(false);
              setVideoFallback(false);
              void refetch();
            }}
          >
            try again
          </button>
        </span>
      </div>
    );
  }
  if (!grant) {
    return <div className="mt-2 w-full animate-pulse rounded bg-slate-100" style={{ aspectRatio: ratio }} />;
  }

  // Both derived from the ONE signed grant — same token, different endpoint (media.router.ts).
  const posterUrl = `${grant.url.replace("/api/media/raw", "/api/media/poster")}&w=640`;
  const streamUrl = grant.url.replace("/api/media/raw", "/api/media/stream");

  if (kind === "video" && playing) {
    return (
      <video
        // Remount when we swap native → transcode stream so the element reloads the new source.
        key={videoFallback ? "stream" : "native"}
        src={videoFallback ? streamUrl : grant.url}
        poster={posterUrl}
        controls
        autoPlay
        playsInline
        preload="metadata"
        aria-label={member.name}
        onError={() => {
          if (!videoFallback) {
            clientLog.warn("GroupReviewColumn.video", `native decode failed, trying transcode: ${member.name}`);
            setVideoFallback(true);
          } else {
            clientLog.warn("GroupReviewColumn.video", `transcode stream failed: ${member.name}`);
            setFailed(true);
          }
        }}
        className="mt-2 h-auto w-full rounded bg-black"
      />
    );
  }

  return (
    <div className="relative mt-2">
      <img
        src={posterUrl}
        alt={member.name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-auto w-full rounded bg-slate-50"
        style={{ aspectRatio: ratio, objectFit: "contain" }}
      />
      {kind === "video" && (
        // Videos do not autoplay on arrival — a dozen simultaneous streams is exactly the problem the
        // poster solves. Click to play (duplicates.mdx §4.3a).
        <button
          onClick={() => setPlaying(true)}
          aria-label={`Play ${member.name}`}
          title="Play this video"
          className="absolute inset-0 grid place-items-center rounded bg-black/0 transition hover:bg-black/20"
        >
          <span className="grid h-12 w-12 place-items-center rounded-full bg-black/55 text-white">
            <Play className="ml-0.5 h-6 w-6" fill="currentColor" />
          </span>
        </button>
      )}
    </div>
  );
}

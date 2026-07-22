// The right review column (duplicates.mdx §4, LOCKED; subsets.mdx §4 deltas): the selected group's
// members for side-by-side review. Its own overflow-y scroll region, independent of the table and page.
// Top-to-bottom: the action-links row (exactly "Done" for now) → the literal "All files are the same:"
// block listing the COMMON attributes comma-space separated → one preview block per member (full column
// width, aspect ratio kept) with that member's DIFFERING attributes comma-separated beneath it. An
// attribute appears in the common block OR under the previews — never both (§4.2/§4.3).
//
// Print rules (LOCKED): resolution and codec strings come ONLY from the shared helpers
// resolutionLabel() / codecLabel() (duplicates.mdx §4.4–§4.5); sizes via the house formatBytes.
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { codecLabel, formatBytes, mediaKindForName, resolutionLabel } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageActions } from "../../components/menu/PageActions.js";
import { formatClock, formatOffset, type VideoMember } from "./videoGroups.js";

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
  // count when the stored strings agree. Subsets: the signature references always differ — never listed.
  const fpCommon =
    variant === "duplicates" &&
    (members[0]?.matchBasis === "fingerprint" || allEqual(members.map((m) => m.fingerprint)));

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
  /** The selected group's members in display order (subsets: superset first — subsets.mdx §4). */
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
      <div className="shrink-0 border-b border-[var(--lfb-border)] pb-2">
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
              {/* §4.3 header line: bold basename (subsets label the superset block — subsets.mdx §4). */}
              <div className="break-words text-sm font-semibold text-black">
                {isSuperset && (
                  <span className="mr-1.5 rounded bg-[var(--lfb-primary-tint)] px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-wide text-[var(--lfb-primary)]">
                    SUPERSET
                  </span>
                )}
                {m.name}
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

/** The media preview (§4.3, LOCKED): full column width, aspect ratio ALWAYS kept — never cropped,
 *  stretched, or fixed-height. Loads via the same signed media grant the media viewer uses. */
function MemberPreview({ member }: { member: VideoMember }) {
  const kind = mediaKindForName(member.name);
  const previewable = kind === "image" || kind === "video";
  const { data: grant, isError } = useQuery({
    queryKey: ["media-grant", member.fullPath], // shares the MediaViewer's grant cache
    queryFn: () => api.mediaGrant(member.fullPath),
    enabled: previewable,
    staleTime: 60_000,
    retry: false,
  });
  if (!previewable) return null;
  const ratio = member.width && member.height ? `${member.width} / ${member.height}` : "16 / 9";
  if (isError) {
    return (
      <div
        className="mt-2 grid w-full place-items-center rounded bg-slate-50 text-xs text-black/40"
        style={{ aspectRatio: ratio }}
      >
        Preview unavailable
      </div>
    );
  }
  if (!grant) {
    return <div className="mt-2 w-full animate-pulse rounded bg-slate-100" style={{ aspectRatio: ratio }} />;
  }
  return kind === "image" ? (
    <img src={grant.url} alt={member.name} className="mt-2 h-auto w-full rounded" />
  ) : (
    <video
      src={grant.url}
      controls
      playsInline
      preload="metadata"
      aria-label={member.name}
      className="mt-2 h-auto w-full rounded"
    />
  );
}

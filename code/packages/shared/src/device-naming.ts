// Auto-naming + disambiguation for devices (devices.mdx §8, knowledge/device_identification.md).
// PURE logic — no I/O — so the backend and any client agree on the label a device shows. Two jobs:
//   (a) defaultDeviceName(hw)      — a sensible seed name for a fresh computer: <username>-<model-slug>.
//   (b) disambiguateDevices(list)  — append ONLY the attributes that differ across similar machines,
//       in the fixed priority order screen → year → disk → RAM → chip → hostname.
import type { DeviceHardware } from "./types.js";

/** Lower-kebab a string: "MacBook Pro" → "macbook-pro"; strips anything non-alphanumeric. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The default nice name for a fresh computer (devices.mdx §8): `<username>-<model-slug>`, e.g.
 * bryan + "MacBook Pro" → "bryan-macbook-pro". Falls back to the hostname (or "this-computer") when the
 * model is unknown, and to just the model slug when there is no username.
 */
export function defaultDeviceName(hw: Partial<DeviceHardware> | null | undefined): string {
  const user = hw?.username ? slug(hw.username) : "";
  const model = hw?.modelName ? slug(hw.modelName) : "";
  if (user && model) return `${user}-${model}`;
  if (model) return model;
  if (user && hw?.hostname) return `${user}-${slug(hw.hostname)}`;
  if (hw?.hostname) return slug(hw.hostname);
  return user || "this-computer";
}

// Human-formatted values for each disambiguation attribute (used in the "(…)" suffix).
function fmtScreen(hw: DeviceHardware): string | null {
  return hw.screenInches != null ? `${hw.screenInches}-inch` : null;
}
function fmtYear(hw: DeviceHardware): string | null {
  return hw.year != null ? String(hw.year) : null;
}
function fmtSize(gb: number | null): string | null {
  if (gb == null) return null;
  return gb >= 1000 ? `${+(gb / 1000).toFixed(gb % 1000 === 0 ? 0 : 1)} TB` : `${gb} GB`;
}
function fmtDisk(hw: DeviceHardware): string | null {
  return fmtSize(hw.diskTotalGb);
}
function fmtRam(hw: DeviceHardware): string | null {
  return hw.ramGb != null ? `${hw.ramGb} GB` : null;
}
function fmtChip(hw: DeviceHardware): string | null {
  // "Apple M2 Pro" → "M2 Pro" (drop the vendor prefix so the suffix stays short).
  return hw.chip ? hw.chip.replace(/^Apple\s+/i, "").trim() || hw.chip : null;
}
function fmtHost(hw: DeviceHardware): string | null {
  return hw.hostname || null;
}

// The disambiguation attributes, in the priority order the spec locks (devices.mdx §8):
// screen → year → disk → RAM → chip → hostname. Each returns a human string or null (unknown/absent).
const ATTRS: Array<(hw: DeviceHardware) => string | null> = [
  fmtScreen,
  fmtYear,
  fmtDisk,
  fmtRam,
  fmtChip,
  fmtHost,
];

/**
 * A few salient, human hardware facts for one device, in display order (devices.mdx §6): the model
 * first, then the specs that USED to be their own table columns (screen, chip, RAM, disk). Now that
 * those columns are gone, the Devices table rolls these into the Device cell — the disambiguated name
 * plus this descriptor. Unknown facts are skipped, so a bare/headless device returns a short list (or
 * `[]`). Pure — the backend and any client build the identical descriptor.
 */
export function deviceDescriptor(hw: DeviceHardware | null | undefined): string[] {
  if (!hw) return [];
  const out: string[] = [];
  const model = hw.marketingName || hw.modelName;
  if (model) out.push(model);
  const screen = fmtScreen(hw);
  if (screen) out.push(screen);
  const chip = fmtChip(hw);
  if (chip) out.push(chip);
  const ram = fmtRam(hw);
  if (ram) out.push(`${ram} RAM`);
  const disk = fmtDisk(hw);
  if (disk) out.push(`${disk} disk`);
  return out;
}

// The minimal shape disambiguateDevices needs from a device row.
export interface Disambiguatable {
  name: string; // the nice name
  hardware: DeviceHardware | null;
}

/** The base key devices collide on: same nice name, or same username+model when the name is generic. */
function baseKey(d: Disambiguatable): string {
  const hw = d.hardware;
  const byName = slug(d.name || "");
  const byModel = hw ? `${slug(hw.username || "")}|${slug(hw.modelName || "")}` : "";
  return byName || byModel || "device";
}

/**
 * Compute the display label for each device (devices.mdx §8). A device with no colliding twin keeps its
 * bare nice name. Within a colliding group, append the attributes that DIFFER across the group — only
 * those, in priority order, adding just enough to make every label unique. Returns labels aligned to the
 * input order. Pure and order-stable.
 */
export function disambiguateDevices(devices: Disambiguatable[]): string[] {
  const labels = devices.map((d) => d.name || "device");

  // Group indices by their base key.
  const groups = new Map<string, number[]>();
  devices.forEach((d, i) => {
    const k = baseKey(d);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
  });

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue; // no twin → bare name

    // For each attribute (in priority order), the value per member; include the attribute only if it
    // actually VARIES across the group AND is known for the members. Stop once all labels are unique.
    const suffixParts: Map<number, string[]> = new Map(idxs.map((i) => [i, []]));
    for (const attr of ATTRS) {
      const values = idxs.map((i) => (devices[i].hardware ? attr(devices[i].hardware!) : null));
      const known = values.filter((v) => v != null) as string[];
      const distinct = new Set(known);
      // Only useful if the attribute differs among the members (more than one distinct known value).
      if (distinct.size < 2) continue;
      idxs.forEach((i, j) => {
        const v = values[j];
        if (v != null) suffixParts.get(i)!.push(v);
      });
      // Are labels now unique across the group?
      const composed = idxs.map((i) => `${devices[i].name} (${suffixParts.get(i)!.join(", ")})`);
      if (new Set(composed).size === idxs.length) break;
    }

    idxs.forEach((i) => {
      const parts = suffixParts.get(i)!;
      labels[i] = parts.length ? `${devices[i].name} (${parts.join(", ")})` : devices[i].name;
    });
  }

  return labels;
}

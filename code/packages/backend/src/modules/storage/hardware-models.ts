// The built-in Mac model table (devices.mdx §7, knowledge/device_identification.md). macOS exposes a
// model IDENTIFIER (`sysctl -n hw.model` → "Mac14,7") but not a clean marketing name, year, or built-in
// screen size. This table resolves the identifier to those human facts LOCALLY — no networking. An
// unknown identifier degrades gracefully (the caller leaves marketing_name "" and year/screen null).
//
// Coverage is the common recent Apple-silicon + late-Intel machines; extend as needed. Keep entries
// terse: [marketingName, year, screenInches|null, kind]. `screenInches` is the BUILT-IN display (null
// for headless desktops); `kind` is laptop | desktop | server.

export interface ModelFacts {
  marketingName: string;
  year: number | null;
  screenInches: number | null;
  kind: "laptop" | "desktop" | "server";
}

type Row = readonly [name: string, year: number | null, screen: number | null, kind: ModelFacts["kind"]];

const TABLE: Record<string, Row> = {
  // ── MacBook Pro (Apple silicon) ──
  "Mac16,7": ["MacBook Pro (16-inch, 2024)", 2024, 16, "laptop"],
  "Mac16,5": ["MacBook Pro (16-inch, 2024)", 2024, 16, "laptop"],
  "Mac16,1": ["MacBook Pro (14-inch, 2024)", 2024, 14, "laptop"],
  "Mac16,6": ["MacBook Pro (14-inch, 2024)", 2024, 14, "laptop"],
  "Mac16,8": ["MacBook Pro (14-inch, 2024)", 2024, 14, "laptop"],
  "Mac15,3": ["MacBook Pro (14-inch, Nov 2023)", 2023, 14, "laptop"],
  "Mac15,6": ["MacBook Pro (14-inch, Nov 2023)", 2023, 14, "laptop"],
  "Mac15,8": ["MacBook Pro (14-inch, Nov 2023)", 2023, 14, "laptop"],
  "Mac15,10": ["MacBook Pro (14-inch, Nov 2023)", 2023, 14, "laptop"],
  "Mac15,7": ["MacBook Pro (16-inch, Nov 2023)", 2023, 16, "laptop"],
  "Mac15,9": ["MacBook Pro (16-inch, Nov 2023)", 2023, 16, "laptop"],
  "Mac15,11": ["MacBook Pro (16-inch, Nov 2023)", 2023, 16, "laptop"],
  "Mac14,5": ["MacBook Pro (14-inch, 2023)", 2023, 14, "laptop"],
  "Mac14,9": ["MacBook Pro (14-inch, 2023)", 2023, 14, "laptop"],
  "Mac14,6": ["MacBook Pro (16-inch, 2023)", 2023, 16, "laptop"],
  "Mac14,10": ["MacBook Pro (16-inch, 2023)", 2023, 16, "laptop"],
  "Mac14,7": ["MacBook Pro (13-inch, M2, 2022)", 2022, 13, "laptop"],
  "MacBookPro18,3": ["MacBook Pro (14-inch, 2021)", 2021, 14, "laptop"],
  "MacBookPro18,4": ["MacBook Pro (14-inch, 2021)", 2021, 14, "laptop"],
  "MacBookPro18,1": ["MacBook Pro (16-inch, 2021)", 2021, 16, "laptop"],
  "MacBookPro18,2": ["MacBook Pro (16-inch, 2021)", 2021, 16, "laptop"],
  "MacBookPro17,1": ["MacBook Pro (13-inch, M1, 2020)", 2020, 13, "laptop"],

  // ── MacBook Air ──
  "Mac16,12": ["MacBook Air (13-inch, M4, 2025)", 2025, 13, "laptop"],
  "Mac16,13": ["MacBook Air (15-inch, M4, 2025)", 2025, 15, "laptop"],
  "Mac15,12": ["MacBook Air (13-inch, M3, 2024)", 2024, 13, "laptop"],
  "Mac15,13": ["MacBook Air (15-inch, M3, 2024)", 2024, 15, "laptop"],
  "Mac14,15": ["MacBook Air (15-inch, M2, 2023)", 2023, 15, "laptop"],
  "Mac14,2": ["MacBook Air (M2, 2022)", 2022, 13, "laptop"],
  "MacBookAir10,1": ["MacBook Air (M1, 2020)", 2020, 13, "laptop"],

  // ── Mac mini ──
  "Mac16,10": ["Mac mini (2024)", 2024, null, "desktop"],
  "Mac16,11": ["Mac mini (2024)", 2024, null, "desktop"],
  "Mac14,3": ["Mac mini (M2, 2023)", 2023, null, "desktop"],
  "Mac14,12": ["Mac mini (M2 Pro, 2023)", 2023, null, "desktop"],
  "Macmini9,1": ["Mac mini (M1, 2020)", 2020, null, "desktop"],

  // ── Mac Studio ──
  "Mac16,9": ["Mac Studio (2025)", 2025, null, "desktop"],
  "Mac15,14": ["Mac Studio (2025)", 2025, null, "desktop"],
  "Mac14,13": ["Mac Studio (M2 Max, 2023)", 2023, null, "desktop"],
  "Mac14,14": ["Mac Studio (M2 Ultra, 2023)", 2023, null, "desktop"],
  "Mac13,1": ["Mac Studio (M1 Max, 2022)", 2022, null, "desktop"],
  "Mac13,2": ["Mac Studio (M1 Ultra, 2022)", 2022, null, "desktop"],

  // ── iMac ──
  "Mac16,3": ["iMac (24-inch, 2024)", 2024, 24, "desktop"],
  "Mac16,2": ["iMac (24-inch, 2024)", 2024, 24, "desktop"],
  "Mac15,4": ["iMac (24-inch, 2023)", 2023, 24, "desktop"],
  "Mac15,5": ["iMac (24-inch, 2023)", 2023, 24, "desktop"],
  "iMac21,1": ["iMac (24-inch, M1, 2021)", 2021, 24, "desktop"],
  "iMac21,2": ["iMac (24-inch, M1, 2021)", 2021, 24, "desktop"],

  // ── Mac Pro ──
  "Mac14,8": ["Mac Pro (2023)", 2023, null, "desktop"],
  "MacPro7,1": ["Mac Pro (2019)", 2019, null, "desktop"],
};

/** Resolve a `hw.model` identifier to marketing facts, or null when unknown. */
export function lookupModel(identifier: string): ModelFacts | null {
  const row = TABLE[identifier];
  if (!row) return null;
  const [marketingName, year, screenInches, kind] = row;
  return { marketingName, year, screenInches, kind };
}

/**
 * Best-effort `kind` from the model identifier alone (used when the table has no exact row): MacBook* →
 * laptop; Macmini/iMac/MacStudio/MacPro/Mac Pro → desktop; otherwise "" (caller may decide server).
 */
export function kindFromIdentifier(identifier: string): ModelFacts["kind"] | "" {
  const id = identifier.toLowerCase();
  if (id.startsWith("macbook")) return "laptop";
  if (/^(mac13|mac14,1[34]|mac15,14|mac16,9)/.test(id)) return "desktop"; // Mac Studio families
  if (id.startsWith("macmini") || id.startsWith("imac") || id.startsWith("macpro")) return "desktop";
  return "";
}

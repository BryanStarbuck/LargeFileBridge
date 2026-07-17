// PDF-as-an-OCR-kind classification tests (ocr.mdx §1.7.1 / scan.mdx §4.1 rule 5). These lock the two
// predicate changes that make "open the OCR tab, turn off Large files, and OCR a PDF" work end to end:
//
//   1. The scanner admits a PDF as an ANALYSIS CANDIDATE (rule 5) — `isAnalysisCandidate` = media OR pdf —
//      but a PDF is NOT media, so it must never be treated as pin payload or a compress candidate.
//   2. The File-type classifier tags a `.pdf` as `pdf` (facet + Kind column), and `isPdfName` is the shared
//      discriminator OCR and the scanner both agree on.
import { describe, it, expect } from "vitest";
import { isMediaFile, isPdfFile, isAnalysisCandidate } from "../../shared/scan-filters.js";
import { fileTypeForName, isPdfName, mediaKindForName } from "@lfb/shared";

describe("PDF classification (ocr.mdx §1.7.1)", () => {
  it("a PDF is an analysis candidate but NOT media (never pin payload / compress)", () => {
    expect(isMediaFile("contract.pdf")).toBe(false); // NOT media → not payload, not compressible
    expect(isPdfFile("contract.pdf")).toBe(true);
    expect(isAnalysisCandidate("contract.pdf")).toBe(true); // rule 5 admits it for OCR
  });

  it("media files remain analysis candidates (rule 5 is a widening, not a replacement)", () => {
    for (const name of ["shot.mp4", "clip.mov", "note.mp3", "screenshot.png", "photo.jpg"]) {
      expect(isAnalysisCandidate(name)).toBe(true);
    }
  });

  it("a non-media, non-PDF file is NOT admitted by rule 5", () => {
    for (const name of ["notes.txt", "deck.pptx", "sheet.xlsx", "code.ts", "data.json"]) {
      expect(isAnalysisCandidate(name)).toBe(false);
    }
  });

  it("the File-type facet tags a PDF as `pdf`, media by family, and everything else `other`", () => {
    expect(fileTypeForName("contract.PDF")).toBe("pdf"); // case-insensitive
    expect(fileTypeForName("shot.mp4")).toBe("video");
    expect(fileTypeForName("photo.jpg")).toBe("image");
    expect(fileTypeForName("note.mp3")).toBe("audio");
    expect(fileTypeForName("notes.txt")).toBe("other");
  });

  it("isPdfName is the shared discriminator; a PDF is not a media KIND", () => {
    expect(isPdfName("a.pdf")).toBe(true);
    expect(isPdfName("a.mp4")).toBe(false);
    expect(mediaKindForName("a.pdf")).toBeNull(); // no player/viewer — it routes to /file
  });
});

// SpeechAnalyzerCLI.swift
//
// A tiny command-line front-end to Apple's on-device SpeechAnalyzer /
// SpeechTranscriber (macOS 26 / "Tahoe"+). Transcribes ONE audio file to a
// plain-text file, fully on-device. This is the NEW Apple speech engine — it
// deliberately does NOT use the legacy SFSpeechRecognizer.
//
// Usage:  SpeechAnalyzerCLI --input <audio> --output <txt> [--locale en-US]
//
// Exit codes (Transcribe.js relies on these):
//   0  success
//   2  bad arguments
//   3  SpeechAnalyzer API unavailable (macOS < 26) — caller should warn + fall back
//   4  locale not supported by SpeechTranscriber
//   1  any other runtime failure — caller should fall back
//
// Compile (single file, no SwiftPM):
//   swiftc -O -parse-as-library -o SpeechAnalyzerCLI SpeechAnalyzerCLI.swift

import Foundation
import AVFoundation
import Speech

@main
struct SpeechAnalyzerCLI {
    static func main() async {
        var input: String?
        var output: String?
        var localeId = "en-US"

        var i = 1
        let args = CommandLine.arguments
        while i < args.count {
            switch args[i] {
            case "--input", "-i":  i += 1; if i < args.count { input = args[i] }
            case "--output", "-o": i += 1; if i < args.count { output = args[i] }
            case "--locale", "-l": i += 1; if i < args.count { localeId = args[i] }
            default: break
            }
            i += 1
        }

        guard let inPath = input, let outPath = output else {
            err("usage: SpeechAnalyzerCLI --input <audio> --output <txt> [--locale en-US]")
            exit(2)
        }

        guard #available(macOS 26.0, *) else {
            err("SpeechAnalyzer requires macOS 26.0 or later")
            exit(3)
        }

        do {
            let text = try await transcribe(inputPath: inPath, localeId: localeId)
            try text.write(toFile: outPath, atomically: true, encoding: .utf8)
            exit(0)
        } catch let e as CLIError {
            err(e.message)
            exit(e.code)
        } catch {
            err("SpeechAnalyzer failed: \(error.localizedDescription)")
            exit(1)
        }
    }

    static func err(_ s: String) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}

struct CLIError: Error { let code: Int32; let message: String }

@available(macOS 26.0, *)
func transcribe(inputPath: String, localeId: String) async throws -> String {
    let locale = Locale(identifier: localeId)

    // The transcription module, tuned for offline file transcription.
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)

    // 1) Is this locale supported at all by the on-device transcriber?
    let supported = await SpeechTranscriber.supportedLocales
    let wantBCP47 = locale.identifier(.bcp47)
    let isSupported = supported.contains { $0.identifier(.bcp47) == wantBCP47 }
    guard isSupported else {
        throw CLIError(code: 4, message: "Locale \(localeId) is not supported by SpeechTranscriber")
    }

    // 2) Ensure the locale model is installed; download it on-device if missing.
    let installed = await SpeechTranscriber.installedLocales
    let isInstalled = installed.contains { $0.identifier(.bcp47) == wantBCP47 }
    if !isInstalled {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    // 3) Analyze the whole file, then finish so the results stream terminates.
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: inputPath))

    // Collect the final results concurrently with analysis so a large file's
    // buffered results never stall the pipeline.
    var finalText = AttributedString("")
    let collector = Task {
        var acc = AttributedString("")
        for try await result in transcriber.results where result.isFinal {
            acc.append(result.text)
        }
        return acc
    }

    if let _ = try await analyzer.analyzeSequence(from: audioFile) {
        // last processed sample time is available here if we wanted coverage info
    }
    try await analyzer.finalizeAndFinishThroughEndOfInput()

    finalText = try await collector.value
    return String(finalText.characters)
}

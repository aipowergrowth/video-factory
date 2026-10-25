import Foundation
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("Usage: trim_audio <input> <output.m4a> [durationSeconds] [startSeconds]")
    exit(1)
}

let inputPath = args[1]
let outputPath = args[2]
let duration = args.count > 3 ? (Double(args[3]) ?? 90.0) : 90.0
let start = args.count > 4 ? (Double(args[4]) ?? 0.0) : 0.0

let url = URL(fileURLWithPath: inputPath)
let asset = AVURLAsset(url: url)

let semaphore = DispatchSemaphore(value: 0)

guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
    print("ERROR: could not create export session")
    exit(1)
}

let outURL = URL(fileURLWithPath: outputPath)
try? FileManager.default.removeItem(at: outURL)

exportSession.outputURL = outURL
exportSession.outputFileType = .m4a

let timescale: CMTimeScale = 600
exportSession.timeRange = CMTimeRange(
    start: CMTime(seconds: start, preferredTimescale: timescale),
    duration: CMTime(seconds: duration, preferredTimescale: timescale)
)

exportSession.exportAsynchronously {
    switch exportSession.status {
    case .completed:
        print("OK")
    case .failed:
        print("ERROR: \(exportSession.error?.localizedDescription ?? "unknown")")
    case .cancelled:
        print("CANCELLED")
    default:
        print("STATUS: \(exportSession.status.rawValue)")
    }
    semaphore.signal()
}

semaphore.wait()

import Foundation
import FluidAudio

// One process per call: model state and anonymous speaker identities persist
// across incoming chunks. No recording files or network inference.
@main struct Worker {
    static let outputLock = NSLock()
    static func reply(_ value: [String: Any]) throws {
        outputLock.lock(); defer { outputLock.unlock() }
        let data = try JSONSerialization.data(withJSONObject: value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    static func main() async {
        do {
            let diarizer = LSEENDDiarizer()
            try await diarizer.initialize(variant: .ami, stepSize: .step500ms, computeUnits: .cpuOnly, progressHandler: { progress in
                let phase: String
                switch progress.phase {
                case .listing: phase = "Checking speaker model"
                case .downloading: phase = "Downloading speaker model"
                case .compiling: phase = "Compiling speaker model"
                }
                try? reply(["progress": true, "percent": progress.fractionCompleted * 100, "message": phase])
            })
            try reply(["ready": true, "model": "LS-EEND AMI", "maxSpeakers": 4])
            var samplesReceived = 0
            while let line = readLine() {
                guard line.utf8.count <= 1_500_000,
                      let data = line.data(using: .utf8),
                      let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = request["id"] as? Int else { throw NSError(domain: "Invalid request", code: 1) }
                if let encoded = request["audio"] as? String {
                    guard let pcm = Data(base64Encoded: encoded), pcm.count % 2 == 0,
                          pcm.count <= 24_000 * 2 * 8 else { throw NSError(domain: "Invalid audio", code: 1) }
                    let bytes = [UInt8](pcm)
                    var samples = [Float](); samples.reserveCapacity(bytes.count / 2)
                    for i in stride(from: 0, to: bytes.count, by: 2) {
                        samples.append(Float(Int16(bitPattern: UInt16(bytes[i]) | UInt16(bytes[i+1]) << 8)) / 32768)
                    }
                    samplesReceived += samples.count
                    try diarizer.addAudio(samples, sourceSampleRate: 24_000)
                    _ = try diarizer.process()
                }
                let final = request["final"] as? Bool == true
                if final { _ = try diarizer.finalizeSession() }
                let through = Double(samplesReceived) / 24_000
                let from = max(0, through - 60)
                var segments = [[String: Any]]()
                for (_, speaker) in diarizer.timeline.speakers {
                    for segment in speaker.finalizedSegments where Double(segment.endTime) > from {
                        segments.append(["start": max(from, Double(segment.startTime)),
                                         "end": min(through, Double(segment.endTime)),
                                         "speaker": segment.speakerIndex])
                    }
                }
                try reply(["id": id, "from": from, "through": through, "segments": segments])
                if final { break }
            }
        } catch {
            try? reply(["error": "Local speaker analysis failed. Check the model download and restart the call."])
        }
    }
}

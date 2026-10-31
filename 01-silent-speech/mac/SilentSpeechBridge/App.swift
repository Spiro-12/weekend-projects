// SilentSpeechBridge: streams AirPods head motion to the web dashboard over ws://localhost:8765.
// See PROTOCOL.md §2. Everything that touches UI state runs on the main queue.
import Foundation
import SwiftUI

@main
struct SilentSpeechBridgeApp: App {
    @StateObject private var bridge = BridgeModel()

    var body: some Scene {
        Window("Silent Speech Bridge", id: "main") {
            ContentView(motion: bridge.motion, server: bridge.server, log: bridge.log)
        }
    }
}

/// Owns the parts of the app and keeps them alive for as long as the app runs.
final class BridgeModel: ObservableObject {
    let log: LogStore
    let runner: ActionRunner
    let motion: MotionStreamer
    let server: WebSocketServer
    private var activity: NSObjectProtocol?

    init() {
        let log = LogStore()
        let runner = ActionRunner(log: log)
        let motion = MotionStreamer(log: log)
        self.log = log
        self.runner = runner
        self.motion = motion
        self.server = WebSocketServer(motion: motion, runner: runner, log: log)

        // Keep streaming while the window is in the background: no App Nap.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "Streaming AirPods head motion to the Silent Speech dashboard"
        )
        motion.start()
        server.start()
    }
}

/// The last 20 log lines shown in the window (connections, actions, errors). Main queue only.
final class LogStore: ObservableObject {
    struct Line: Identifiable {
        let id: Int
        let text: String
    }

    static let maxLines = 20

    @Published private(set) var lines: [Line] = []
    private var nextID = 0
    private let timeFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    func add(_ text: String) {
        nextID += 1
        let line = "\(timeFormat.string(from: Date()))  \(text)"
        print(line)
        lines.append(Line(id: nextID, text: line))
        if lines.count > LogStore.maxLines {
            lines.removeFirst(lines.count - LogStore.maxLines)
        }
    }
}

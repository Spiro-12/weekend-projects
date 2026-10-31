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
        applyLaunchOptions(ProcessInfo.processInfo.arguments)
    }

    /// Read once at startup, so setup can run without clicking: `open SilentSpeechBridge.app --args --simulate`.
    /// `--simulate` turns on Simulate motion; `--allow-no-origin` turns on "Allow non browser clients" (dev).
    /// There is deliberately no option that arms actions: Armed is only ever switched on by hand.
    private func applyLaunchOptions(_ arguments: [String]) {
        if arguments.contains("--simulate") {
            log.add("Launch option --simulate")
            motion.simulate = true
        }
        if arguments.contains("--allow-no-origin") {
            log.add("Launch option --allow-no-origin")
            server.allowNonBrowserClients = true
        }
    }
}

/// The last 20 log lines shown in the window (connections, actions, errors). Main queue only.
/// Every line also goes to ~/Library/Logs/SilentSpeechBridge.log (new file each launch), so a setup
/// session can read what happened without looking at the window.
final class LogStore: ObservableObject {
    struct Line: Identifiable {
        let id: Int
        let text: String
    }

    static let maxLines = 20
    static let filePath = NSHomeDirectory() + "/Library/Logs/SilentSpeechBridge.log"

    @Published private(set) var lines: [Line] = []
    private var nextID = 0
    private let file: FileHandle?
    private let timeFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    init() {
        _ = FileManager.default.createFile(atPath: LogStore.filePath, contents: nil)
        file = FileHandle(forWritingAtPath: LogStore.filePath)
    }

    func add(_ text: String) {
        nextID += 1
        let line = "\(timeFormat.string(from: Date()))  \(text)"
        print(line)
        try? file?.write(contentsOf: Data((line + "\n").utf8))
        lines.append(Line(id: nextID, text: line))
        if lines.count > LogStore.maxLines {
            lines.removeFirst(lines.count - LogStore.maxLines)
        }
    }
}

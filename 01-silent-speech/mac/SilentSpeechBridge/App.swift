// SilentSpeechBridge: streams AirPods head motion to the web dashboard over ws://127.0.0.1:8765.
// See PROTOCOL.md §2. Everything that touches UI state runs on the main queue.
import Foundation
import SwiftUI

@main
struct SilentSpeechBridgeApp: App {
    @StateObject private var bridge = BridgeModel()

    var body: some Scene {
        Window("Silent Speech Bridge", id: "main") {
            ContentView(motion: bridge.motion, server: bridge.server, runner: bridge.runner, pairing: bridge.pairing, log: bridge.log)
        }
    }
}

/// Owns the parts of the app and keeps them alive for as long as the app runs.
final class BridgeModel: ObservableObject {
    let log: LogStore
    let pairing: Pairing
    let runner: ActionRunner
    let motion: MotionStreamer
    let server: WebSocketServer
    private var activity: NSObjectProtocol?

    init() {
        let log = LogStore()
        let pairing = Pairing(log: log)
        let runner = ActionRunner(log: log)
        let motion = MotionStreamer(log: log)
        self.log = log
        self.pairing = pairing
        self.runner = runner
        self.motion = motion
        let server = WebSocketServer(motion: motion, runner: runner, pairing: pairing, log: log)
        self.server = server
        // Background steps of an action (AppleScript, Spotify play, speaking the calendar) check this right before
        // they run, so switching Armed off cancels them.
        runner.isArmed = { [weak server] in server?.armed ?? false }
        runner.armedGeneration = { [weak server] in server?.armedGeneration ?? -1 }

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
    /// `--simulate` turns on Simulate motion; `--allow-no-origin` turns on "Allow non browser clients" (dev);
    /// `--print-pair-url` writes the dashboard link with `#pair=<token>` to the log file (only there, not the
    /// window), so the setup session can open it. It does nothing else.
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
        if arguments.contains("--print-pair-url") {
            if pairing.token != nil {
                log.addFileOnly("Pair URL: \(pairing.dashboardURL.absoluteString)",
                                windowText: "Launch option --print-pair-url: the pair link is in the log file")
            } else {
                log.add("Launch option --print-pair-url: no pairing token, nothing to print")
            }
        }
    }
}

/// The last 20 log lines shown in the window (connections, actions, errors). Main queue only.
/// Every line also goes to ~/Library/Logs/SilentSpeechBridge.log (new file each launch, mode 600), so a setup
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
        f.locale = Locale(identifier: "en_US_POSIX") // always 24 h ASCII digits: setup greps anchor on it
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    init() {
        let fm = FileManager.default
        _ = fm.createFile(atPath: LogStore.filePath, contents: nil, attributes: [.posixPermissions: 0o600])
        // createFile may keep an old file's mode: only this user may read the log (it can hold the pair link).
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: LogStore.filePath)
        file = FileHandle(forWritingAtPath: LogStore.filePath)
    }

    func add(_ text: String) {
        let line = stamp(text)
        print(line)
        write(line)
        show(line)
    }

    /// For the pair link: the full text goes only to the log file; the window shows `windowText` instead.
    func addFileOnly(_ text: String, windowText: String) {
        write(stamp(text))
        show(stamp(windowText))
    }

    /// "HH:mm:ss  text", always one line: control characters (newlines too) become spaces, so nothing can fake a
    /// line of its own. Setup greps anchor on this start of line.
    private func stamp(_ text: String) -> String {
        let flat = String(String.UnicodeScalarView(text.unicodeScalars.map {
            $0.properties.generalCategory == .control ? Unicode.Scalar(32) : $0
        }))
        return "\(timeFormat.string(from: Date()))  \(flat)"
    }

    private func write(_ line: String) {
        try? file?.write(contentsOf: Data((line + "\n").utf8))
    }

    private func show(_ line: String) {
        nextID += 1
        lines.append(Line(id: nextID, text: line))
        if lines.count > LogStore.maxLines {
            lines.removeFirst(lines.count - LogStore.maxLines)
        }
    }
}

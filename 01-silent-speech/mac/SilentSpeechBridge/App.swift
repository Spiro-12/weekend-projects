// SilentSpeechBridge: streams AirPods head motion to the web dashboard over ws://127.0.0.1:8765.
// See PROTOCOL.md §2. Everything that touches UI state runs on the main queue.
import Foundation
import SwiftUI

@main
struct SilentSpeechBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var bridge = BridgeModel()

    var body: some Scene {
        Window("Silent Speech Bridge", id: "main") {
            MainWindowContent(bridge: bridge, appDelegate: appDelegate)
        }
    }
}

/// Closing the window keeps the app (and the server) running; only Quit (menu or Cmd+Q) ends it. Clicking the Dock
/// icon brings the window back.
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Opens (or brings forward) the main window. Set once the window has appeared.
    var onReopen: (() -> Void)?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        onReopen?()
        return true
    }
}

/// The window's content, plus the hooks that can open the window again after it was closed.
private struct MainWindowContent: View {
    @Environment(\.openWindow) private var openWindow
    let bridge: BridgeModel
    let appDelegate: AppDelegate

    var body: some View {
        ContentView(motion: bridge.motion, server: bridge.server, runner: bridge.runner, pairing: bridge.pairing, log: bridge.log)
            .onAppear {
                let open = openWindow
                bridge.openMainWindow = { open(id: "main") }
                appDelegate.onReopen = { open(id: "main") }
            }
            .onDisappear {
                bridge.log.add("Window closed, still running (Dock icon opens it again; Quit with Cmd+Q)")
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
    /// Opens (or brings forward) the main window, also after it was closed. Set by the window when it appears.
    var openMainWindow: (() -> Void)?
    private let helpPanel: HelpPanel
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
        // Help must be impossible to miss: the app comes forward, its window opens, a floating panel shows on top of
        // everything, and the Dock icon bounces. Dismiss (window or panel) hides the panel.
        let helpPanel = HelpPanel(runner: runner)
        self.helpPanel = helpPanel
        runner.onHelpNotice = { [weak self] raised in
            guard let self = self else { return }
            if raised {
                NSApplication.shared.activate()
                self.openMainWindow?()
                self.helpPanel.show()
                NSApplication.shared.requestUserAttention(.criticalRequest)
            } else {
                self.helpPanel.hide()
            }
        }

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
                log.add("Launch option --print-pair-url: the pair link is in the log file")
                log.addFileOnly("Pair URL: \(pairing.dashboardURL.absoluteString)")
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

    /// For the pair link: this line goes only to the log file, never to the window (or stdout).
    func addFileOnly(_ text: String) {
        write(stamp(text))
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

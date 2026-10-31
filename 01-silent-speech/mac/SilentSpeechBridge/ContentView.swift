// The one window: AirPods state, live rate, dashboard connection, toggles and the last log lines.
import SwiftUI

struct ContentView: View {
    @ObservedObject var motion: MotionStreamer
    @ObservedObject var server: WebSocketServer
    @ObservedObject var log: LogStore

    private let dashboardURL = URL(string: "https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live")!

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Silent Speech Bridge")
                .font(.title2)
                .bold()

            GroupBox("AirPods") {
                VStack(alignment: .leading, spacing: 6) {
                    InfoRow(label: "Headphones", value: headphonesText, good: motion.headphones == .connected)
                    InfoRow(label: "Motion permission", value: authText, good: motion.auth == .authorized)
                    InfoRow(label: "Sensor bud", value: motion.loc.rawValue, good: nil)
                    InfoRow(label: "Live rate", value: String(format: "%.1f Hz", motion.hz), good: motion.hz >= 20)
                    InfoRow(label: "Gaps", value: String(format: "%.1f %%", motion.gapPct), good: motion.gapPct < 5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Dashboard") {
                VStack(alignment: .leading, spacing: 6) {
                    InfoRow(label: "Server", value: server.portStatus, good: server.listening)
                    InfoRow(label: "Dashboards open", value: "\(server.clientCount)", good: server.clientCount > 0)
                    HStack(spacing: 16) {
                        Link("Open dashboard", destination: dashboardURL)
                        if !server.listening {
                            Button("Retry") { server.restart() }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Settings") {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Simulate motion (no AirPods needed)", isOn: $motion.simulate)
                    Toggle("Armed (let actions really run)", isOn: $server.armed)
                    Toggle("Allow non browser clients (dev only)", isOn: $server.allowNonBrowserClients)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Log") {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(log.lines.reversed())) { line in
                            Text(line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .frame(minHeight: 160)
            }
        }
        .padding(16)
        .frame(minWidth: 480, minHeight: 640)
    }

    private var headphonesText: String {
        switch motion.headphones {
        case .connected: return "Connected"
        case .disconnected: return "Not connected (put the AirPods in)"
        case .unavailable: return "Not available on this Mac"
        }
    }

    private var authText: String {
        switch motion.auth {
        case .authorized: return "Allowed"
        case .denied: return "Denied (System Settings > Privacy & Security)"
        case .notDetermined: return "Not asked yet"
        case .restricted: return "Restricted"
        }
    }
}

/// One "label: value" line with a small colored dot (green = good, orange = needs attention).
private struct InfoRow: View {
    let label: String
    let value: String
    let good: Bool?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 140, alignment: .leading)
            Text(value)
            Spacer(minLength: 0)
        }
    }

    private var dotColor: Color {
        guard let good = good else { return Color.clear }
        return good ? Color.green : Color.orange
    }
}

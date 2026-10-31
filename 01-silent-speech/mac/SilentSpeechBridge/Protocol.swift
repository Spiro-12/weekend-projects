// Protocol v1 between SilentSpeechBridge (this app) and the web dashboard.
// Mirrors web/src/core/contracts.ts and PROTOCOL.md. Lead owned: change all three together.
import Foundation

enum ProtocolV1 {
    static let version = 1
    static let port: UInt16 = 8765
    static let allowedOrigins: Set<String> = [
        "https://spiro-12.github.io",
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    ]
    /// Origin header names must be compared case insensitively. Missing Origin is rejected
    /// unless the "Allow non browser clients" dev toggle is on.
    static let actionCooldown: TimeInterval = 3
    /// Actions that message real people get a longer cooldown.
    static let sensitiveActions: Set<String> = ["text_mom", "call_back", "help"]
    static let sensitiveCooldown: TimeInterval = 30
}

/// Rounds to 5 decimals to keep frames small.
@inline(__always) func r5(_ x: Double) -> Double { (x * 100_000).rounded() / 100_000 }

enum HeadphoneState: String, Codable { case connected, disconnected, unavailable }
enum AuthState: String, Codable { case authorized, denied, notDetermined, restricted }
enum BudLocation: String, Codable { case left, right, `default`, unknown }
enum ErrorCode: String, Codable { case bad_json, unknown_action, cooldown }

// MARK: Mac -> browser

struct HelloMessage: Codable {
    var type = "hello"
    var v = ProtocolV1.version
    var app = "SilentSpeechBridge"
    let version: String
    let actions: [String]
    let armed: Bool
}

struct StatusMessage: Codable {
    var type = "status"
    let headphones: HeadphoneState
    let auth: AuthState
    let loc: BudLocation
    let hz: Double
    let gapPct: Double
    let clients: Int
    let armed: Bool
    let simulated: Bool
}

struct MotionMessage: Codable {
    var type = "motion"
    let seq: Int
    let t: Double          // CMLogItem.timestamp (seconds since boot). Simulate mode uses ProcessInfo.processInfo.systemUptime (same clock) and keeps seq counting
    let q: [Double]        // [w, x, y, z]
    let rr: [Double]       // rotationRate rad/s [x, y, z]
    let ua: [Double]       // userAcceleration g [x, y, z]
    var g: [Double]? = nil // gravity g [x, y, z], optional
}

struct ActionResultMessage: Codable {
    var type = "actionResult"
    let id: String
    let action: String
    let ok: Bool
    let dryRun: Bool
    let message: String
    var error: String? = nil
    let ms: Double
}

struct ErrorMessage: Codable {
    var type = "error"
    let code: ErrorCode
    let message: String
    var id: String? = nil
}

// MARK: browser -> Mac

struct ActionRequest: Codable {
    let type: String // "action"
    let id: String
    let action: String
    let label: String
    let confidence: Double
}

enum ProtocolCoding {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    static func encode<T: Encodable>(_ value: T) -> String? {
        guard let data = try? encoder.encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Returns nil for anything that is not a valid action request.
    static func decodeRequest(_ text: String) -> ActionRequest? {
        guard let data = text.data(using: .utf8),
              let req = try? JSONDecoder().decode(ActionRequest.self, from: data),
              req.type == "action" else { return nil }
        return req
    }
}

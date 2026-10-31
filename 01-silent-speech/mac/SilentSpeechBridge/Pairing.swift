// Pairing, PROTOCOL.md §2: every `action` must carry the token from ~/.silentspeech/token.
// The token lives only in that file (folder 0700, file 0600), in the "Open dashboard" link, and (only with the
// --print-pair-url launch option) in the log file. It is never shown in the window or logged anywhere else.
import Foundation
import Security

final class Pairing {
    /// 32 lowercase hex chars. nil if the file could not be read or made: then every action is refused (fail closed).
    let token: String?

    static let dashboardBase = "https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live"
    static let tokenFile = (ProtocolV1.tokenPath as NSString).expandingTildeInPath
    static let tokenBytes = 16 // 16 random bytes = 32 hex chars

    init(log: LogStore) {
        token = Pairing.loadOrCreate(log: log)
    }

    /// The dashboard link with `#pair=<token>` (the dashboard keeps it and removes it from the address bar).
    var dashboardURL: URL {
        if let token = token, let url = URL(string: Pairing.dashboardBase + "#pair=" + token) {
            return url
        }
        return URL(string: Pairing.dashboardBase)!
    }

    /// Constant time compare. Missing, empty or wrong token: false. No token on this Mac: always false.
    func matches(_ given: String?) -> Bool {
        guard let expected = token, let given = given else { return false }
        let a = Array(expected.utf8)
        let b = Array(given.utf8)
        // The length (32) is not a secret. The content is compared without stopping at the first difference.
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count {
            diff |= a[i] ^ b[i]
        }
        return diff == 0
    }

    // MARK: Token file

    private static func loadOrCreate(log: LogStore) -> String? {
        let path = tokenFile
        let dir = (path as NSString).deletingLastPathComponent
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            // A folder that already existed keeps its old mode: make it private too.
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
        } catch {
            log.add("Pairing: could not make ~/.silentspeech (\(error.localizedDescription)). Every action will be refused.")
            return nil
        }

        if let existing = readToken(at: path) {
            if let mode = (try? fm.attributesOfItem(atPath: path))?[.posixPermissions] as? NSNumber, mode.intValue & 0o777 != 0o600 {
                do {
                    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
                    log.add("Pairing: made ~/.silentspeech/token private again (mode 600)")
                } catch {
                    log.add("Pairing: could not make ~/.silentspeech/token private. Every action will be refused.")
                    return nil
                }
            }
            log.add("Pairing: token ready (~/.silentspeech/token)")
            return existing
        }

        guard let fresh = randomHex(bytes: tokenBytes) else {
            log.add("Pairing: no random bytes from the system. Every action will be refused.")
            return nil
        }
        // Replace a broken file (or a link) with a new private one. O_EXCL + O_NOFOLLOW: never write through a link.
        _ = unlink(path)
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else {
            log.add("Pairing: could not write ~/.silentspeech/token (error \(errno)). Every action will be refused.")
            return nil
        }
        let bytes = Array((fresh + "\n").utf8)
        let written = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
        _ = fsync(fd)
        _ = close(fd)
        guard written == bytes.count, readToken(at: path) == fresh else {
            log.add("Pairing: could not save ~/.silentspeech/token. Every action will be refused.")
            return nil
        }
        log.add("Pairing: made a new token (~/.silentspeech/token). Open the dashboard with this app's link to pair it.")
        return fresh
    }

    /// The token in the file, if the file is a plain file holding exactly 32 lowercase hex chars (plus a newline).
    private static func readToken(at path: String) -> String? {
        let fm = FileManager.default
        // attributesOfItem does not follow a symbolic link, so a link shows up as a link and is rejected.
        guard let attributes = try? fm.attributesOfItem(atPath: path),
              (attributes[.type] as? FileAttributeType) == .typeRegular,
              let data = fm.contents(atPath: path), data.count <= 256,
              let text = String(data: data, encoding: .utf8) else { return nil }
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return isToken(token) ? token : nil
    }

    static func isToken(_ text: String) -> Bool {
        text.utf8.count == tokenBytes * 2 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func randomHex(bytes count: Int) -> String? {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return nil }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

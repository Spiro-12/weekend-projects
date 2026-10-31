// Automation (Apple Events) permission for another app, without freezing the app: the popup that asks Spiro waits
// on a background queue, so motion and status keep flowing to the dashboard while it is on screen.
import AppKit
import CoreServices

enum Automation {
    enum Permission: Equatable {
        case allowed
        case denied      // the answer was Don't Allow (errAEEventNotPermitted)
        case wouldAsk    // not asked yet (errAEEventWouldRequireUserConsent)
        case notRunning  // the app is not running, so macOS can't tell (procNotFound)
        case other(Int32)
    }

    /// With `ask: false` this never shows a popup and answers quickly (fine on the main thread).
    /// With `ask: true` it may show the popup and wait for the click: call it off the main thread only.
    /// No event given: asks about any event (wildcards).
    static func permission(_ bundleID: String, ask: Bool, eventClass: AEEventClass? = nil, eventID: AEEventID? = nil) -> Permission {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        let anyEvent = AEEventClass(typeWildCard)
        let status: OSStatus = withExtendedLifetime(target) {
            AEDeterminePermissionToAutomateTarget(target.aeDesc, eventClass ?? anyEvent, eventID ?? AEEventID(typeWildCard), ask)
        }
        switch status {
        case 0: return .allowed
        case -1743: return .denied
        case -1744: return .wouldAsk
        case -600: return .notRunning
        default: return .other(status)
        }
    }

    /// Asks with the popup if needed (off the main thread only). If macOS still says "would ask" for the wildcard
    /// question (it may show no popup for that), asks once more for one concrete event: Get Data ('core'/'getd').
    /// Still "would ask" after that: the caller fails safe (runs nothing).
    static func askPermission(_ bundleID: String) -> Permission {
        let first = permission(bundleID, ask: true)
        guard first == .wouldAsk else { return first }
        return permission(bundleID, ask: true, eventClass: fourCharCode("core"), eventID: fourCharCode("getd"))
    }

    /// "core" -> 0x636F7265.
    static func fourCharCode(_ text: String) -> FourCharCode {
        text.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) }
    }

    static func isRunning(_ bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }
}

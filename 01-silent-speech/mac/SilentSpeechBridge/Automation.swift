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
    static func permission(_ bundleID: String, ask: Bool) -> Permission {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        let status: OSStatus = withExtendedLifetime(target) {
            AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
        }
        switch status {
        case 0: return .allowed
        case -1743: return .denied
        case -1744: return .wouldAsk
        case -600: return .notRunning
        default: return .other(status)
        }
    }

    static func isRunning(_ bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }
}

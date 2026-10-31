// The help notice as a floating panel above every app's windows and on every Space, so it can't be missed even when
// the app's own window is behind other windows or closed. Not modal: nothing waits for it, the server keeps running.
// Non activating: showing it or clicking Dismiss never takes the focus from the dashboard in Chrome.
import AppKit
import SwiftUI

final class HelpPanel {
    private let runner: ActionRunner
    private var panel: NSPanel?

    init(runner: ActionRunner) {
        self.runner = runner
    }

    func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.center()
        panel.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let hosting = NSHostingView(rootView: HelpPanelView(runner: runner))
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 180),
            styleMask: [.titled, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Silent Speech: help"
        panel.level = .statusBar // above the normal and floating windows of every app
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true // a click on Dismiss does not make it the key window
        panel.isReleasedWhenClosed = false
        panel.contentView = hosting
        panel.setContentSize(hosting.fittingSize)
        return panel
    }
}

/// What the panel shows: the same red notice as the window, bigger. Dismiss here also clears the window's one.
private struct HelpPanelView: View {
    @ObservedObject var runner: ActionRunner

    var body: some View {
        Group {
            if let notice = runner.helpNotice {
                HelpBanner(notice: notice, large: true) { runner.dismissHelp() }
            } else {
                Text("No help request right now.")
            }
        }
        .padding(14)
        .frame(width: 520)
    }
}

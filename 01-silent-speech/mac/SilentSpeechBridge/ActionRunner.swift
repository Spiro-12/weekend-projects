// Runs the action a paired dashboard asks for (PROTOCOL.md §2). Not Armed: a dry run, nothing happens.
// Armed: the real thing. Settings come from ~/.silentspeech/actions.json (never in the repo; the contact is written
// by mac/set-contact.sh). Texts only ever go to the `to` contacts in that file. Every real action is logged, with
// contacts masked to the last 2 digits. Main queue only.
import AppKit
import EventKit
import Foundation

/// What an action answers right away (PROTOCOL.md §2 `actionResult`).
struct ActionOutcome {
    let ok: Bool
    let dryRun: Bool
    let message: String
    var error: String? = nil
}

/// The kinds of real actions. Each action id may only have the kinds in `ActionRunner.allowedKinds`, so only the
/// actions with the 30 s cooldown (ProtocolV1.sensitiveActions) can ever send a text.
enum ActionKind: String {
    case imessage   // send `text` to `to` with Messages
    case volume     // turn the system volume up by `step` percent
    case applemusic // play the library `playlist`, else open `url` (an Apple Music playlist) and play
    case spotify    // play `uri` in Spotify
    case say      // speak `text` out loud (through the AirPods when they are the sound output)
    case calendar // read today's events, summarize, speak (long: replies "Working on it" first)
}

/// One entry of ~/.silentspeech/actions.json. `kind` must be one the action allows (nil: the action's default).
/// Missing fields use the defaults, except `to`: there is never a default contact.
struct ActionConfig {
    var kind: ActionKind?
    var to: String?
    var text: String?
    var step: Double?
    var uri: String?
    var playlist: String?
    var url: String?
}

/// Shown in the window when `help` runs, until dismissed.
struct HelpNotice {
    let time: Date
    var detail: String
}

/// For log lines: only a-z, 0-9 and _ (at most 32), so a made up action name can't fake a log line.
func logSafeName(_ name: String) -> String {
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789_")
    let kept = String(name.filter { allowed.contains($0) }.prefix(32))
    return kept.isEmpty ? "?" : kept
}

final class ActionRunner: ObservableObject {
    /// The `action` ids from shared/classes.json (everything except `none`). Sent in `hello.actions`.
    static let actionKeys = ["text_mom", "volume_up", "call_back", "demo_48h", "help", "calendar", "focus_music"]
    static let textingActions = ["text_mom", "call_back", "help"]
    static let configPath = NSHomeDirectory() + "/.silentspeech/actions.json"

    /// The kinds each action may have; the first one is its default.
    static let allowedKinds: [String: [ActionKind]] = [
        "text_mom": [.imessage], "call_back": [.imessage], "help": [.imessage],
        "volume_up": [.volume], "focus_music": [.applemusic, .spotify], "demo_48h": [.say], "calendar": [.calendar],
    ]
    static let defaultTexts = [
        "text_mom": "On my way!",
        "call_back": "Can't talk now, call me back later",
        "help": "I need help right now",
        "demo_48h": "I created this demo in 48 hours",
    ]
    static let defaultStep: Double = 15
    /// Spotify's public "Deep Focus" playlist.
    static let defaultSpotifyURI = "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ"
    static let spotifyBundleID = "com.spotify.client"
    /// Apple Music's public "Pure Focus" playlist (not checked from here: the real test confirms it).
    static let defaultAppleMusicURL = "https://music.apple.com/us/playlist/pure-focus/pl.f54198ad42404535be13eabf3835fb22"
    static let musicBundleID = "com.apple.Music"
    /// After `open location`, wait this long before `play`; after `play`, this long before checking it plays.
    static let musicOpenWait: TimeInterval = 3
    static let musicLaunchWait: TimeInterval = 4
    static let musicPlayCheck: TimeInterval = 5
    static let messagesBundleID = "com.apple.MobileSMS"
    static let maxTextLength = 300
    /// AppleScript runs this long after the reply went out (see `runScriptSoon`).
    static let scriptDelay: TimeInterval = 0.15
    /// After opening an app, wait this long before asking it to do something.
    static let messagesLaunchWait: TimeInterval = 3
    static let spotifyLaunchWait: TimeInterval = 5
    /// The on device model gets this long for the calendar summary, then the plain readout is used.
    static let summaryTimeout: TimeInterval = 10
    /// A calendar run that never finished (speech stuck) stops blocking new ones after this long.
    static let calendarMaxBusy: TimeInterval = 60

    @Published private(set) var helpNotice: HelpNotice? = nil
    /// Called when `help` raises its alarm (true) and when the notice is dismissed (false). BridgeModel uses it
    /// to bring the app forward and show the floating help panel.
    var onHelpNotice: ((Bool) -> Void)?

    /// Asked again right before anything runs in the background (an AppleScript, Spotify play, speaking the
    /// calendar), so switching Armed off cancels what has not started yet. Set by BridgeModel; until then: off.
    var isArmed: () -> Bool = { false }
    /// Goes up on every Armed change. A request remembers it, so off and on again also cancels a waiting request.
    var armedGeneration: () -> Int = { -1 }
    /// A request that has waited this long (for example on a permission popup) is dropped instead of run.
    static let maxWait: TimeInterval = 60

    private(set) var configs: [String: ActionConfig] = [:]
    private var configData: Data?
    private var configLoaded = false
    private let log: LogStore
    private let speaker = Speaker()
    private var eventStore: EKEventStore?
    private var calendarBusySince: TimeInterval?
    private var alertSound: NSSound?
    /// Apps with a request waiting to use them (opening, or a permission popup on screen), since when. Only one
    /// request may wait per app: no two texts can run back to back from one popup.
    private var waitingApps: [String: TimeInterval] = [:]

    init(log: LogStore) {
        self.log = log
        reloadIfChanged()
    }

    // MARK: actions.json

    /// Reads ~/.silentspeech/actions.json at launch and before every armed action (cheap, and an edit works
    /// without a relaunch). Only logs when the file changed. A bad entry is skipped (that action uses the
    /// defaults); a broken file is ignored as a whole.
    func reloadIfChanged() {
        let data = FileManager.default.contents(atPath: ActionRunner.configPath)
        if configLoaded && data == configData { return }
        configLoaded = true
        configData = data
        configs = [:]
        guard let data = data else {
            log.add("No ~/.silentspeech/actions.json: texts have no contact (run mac/set-contact.sh), the rest uses defaults")
            return
        }
        guard let all = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            log.add("Could not read ~/.silentspeech/actions.json (not a JSON object), ignoring it")
            return
        }
        for (action, value) in all.sorted(by: { $0.key < $1.key }) {
            guard let kinds = ActionRunner.allowedKinds[action] else {
                log.add("actions.json: unknown action \(logSafeName(action)), skipped")
                continue
            }
            if let config = parseEntry(action, kinds: kinds, value) {
                configs[action] = config
            }
        }
        log.add("Loaded actions.json: \(configs.keys.sorted().joined(separator: ", "))")
        let contacts = ActionRunner.textingActions.map { "\($0) → \(contactSummary(configs[$0]?.to))" }
        log.add("Contacts: \(contacts.joined(separator: ", "))")
    }

    private func contactSummary(_ raw: String?) -> String {
        guard let raw = raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return "no contact" }
        guard let clean = ActionRunner.cleanContact(raw) else { return "not a + and country code number" }
        return ActionRunner.mask(clean)
    }

    private func parseEntry(_ action: String, kinds: [ActionKind], _ value: Any) -> ActionConfig? {
        func skip(_ why: String) -> ActionConfig? {
            log.add("actions.json: \(action) skipped (\(why))")
            return nil
        }
        guard let entry = value as? [String: Any] else { return skip("not an object") }
        let names = kinds.map { "\"\($0.rawValue)\"" }.joined(separator: " or ")
        guard let kindText = entry["kind"] as? String, let kind = ActionKind(rawValue: kindText), kinds.contains(kind) else {
            return skip("kind must be \(names)")
        }
        var config = ActionConfig()
        config.kind = kind
        for (key, field) in entry where key != "kind" {
            switch key {
            case "to", "text", "uri", "playlist", "url":
                guard let text = field as? String else { return skip("\(key) must be text") }
                switch key {
                case "to": config.to = text
                case "text": config.text = text
                case "uri": config.uri = text
                case "playlist": config.playlist = text
                default: config.url = text
                }
            case "step":
                guard let number = field as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
                    return skip("step must be a number")
                }
                config.step = number.doubleValue
            default:
                log.add("actions.json: \(action) has an unknown field \(logSafeName(key)), ignored")
            }
        }
        return config
    }

    // MARK: Running

    /// Answers one action request. Called on the main queue. Calls `reply` once, on the main queue, right away
    /// (the server sends it as `actionResult`; the Mac must reply within 1 s). Actions that talk to other apps
    /// (Messages, Spotify) or take long (calendar) reply first and finish in the background; the end is logged
    /// as "<action> done: ...", "<action> failed: ..." or "<action> cancelled: not armed".
    func run(_ action: String, armed: Bool, reply: @escaping (ActionOutcome) -> Void) {
        guard let defaultKind = ActionRunner.allowedKinds[action]?.first else {
            log.add("No such action: \(logSafeName(action))")
            reply(ActionOutcome(ok: false, dryRun: !armed, message: "No such action", error: "unknown_action"))
            return
        }
        reloadIfChanged()
        let config = configs[action] ?? ActionConfig()
        let kind = config.kind ?? defaultKind
        guard armed else {
            log.add("Dry run: \(action) (not armed, would run \(kind.rawValue))")
            reply(ActionOutcome(ok: true, dryRun: true, message: "Dry run: \(action)"))
            return
        }
        switch kind {
        case .imessage: runText(action, config, reply)
        case .volume: runVolume(action, config, reply)
        case .applemusic: runAppleMusic(action, config, reply)
        case .spotify: runSpotify(action, config, reply)
        case .say: runSay(action, config, reply)
        case .calendar: runCalendar(action, reply)
        }
    }

    private func logDone(_ action: String, _ text: String, contact: String? = nil) {
        log.add("\(action) done: \(ActionRunner.scrubContacts(text, contact: contact))")
    }

    /// Logs "<action> failed: ...". For help, the notice in the window says it too.
    private func logFailed(_ action: String, _ text: String, contact: String? = nil) {
        let clean = ActionRunner.scrubContacts(text, contact: contact)
        log.add("\(action) failed: \(clean)")
        if action == "help" { setHelpDetail("The text did not go out: \(clean)") }
    }

    /// Logs "<action> cancelled: ...". For help, the notice in the window says it too.
    private func logCancelled(_ action: String, _ why: String) {
        log.add("\(action) cancelled: \(why)")
        if action == "help" { setHelpDetail("The text did not go out: cancelled (\(why))") }
    }

    /// One armed request on its way through background steps.
    struct Ticket {
        let action: String
        let generation: Int
        let started: TimeInterval
    }

    private func makeTicket(_ action: String) -> Ticket {
        Ticket(action: action, generation: armedGeneration(), started: ProcessInfo.processInfo.systemUptime)
    }

    /// True if the request may still run now: still Armed, Armed not switched off and on since, and at most 60 s
    /// old. Otherwise logs "<action> cancelled: not armed" / "cancelled: too late" (unless quiet) and says false.
    private func mayRun(_ ticket: Ticket, quiet: Bool = false) -> Bool {
        if !isArmed() || armedGeneration() != ticket.generation {
            if !quiet { logCancelled(ticket.action, "not armed") }
            return false
        }
        if ProcessInfo.processInfo.systemUptime - ticket.started > ActionRunner.maxWait {
            if !quiet { logCancelled(ticket.action, "too late (waited over \(Int(ActionRunner.maxWait)) s)") }
            return false
        }
        return true
    }

    /// Logs the failure and replies ok:false.
    private func refuse(_ action: String, _ message: String, error: String, logDetail: String? = nil,
                        _ reply: (ActionOutcome) -> Void) {
        logFailed(action, logDetail ?? message)
        reply(ActionOutcome(ok: false, dryRun: false, message: ActionRunner.scrubContacts(message, contact: nil), error: error))
    }

    /// Quick, no popup: true only when macOS already knows the answer is Don't Allow.
    private func knownDenied(_ bundleID: String) -> Bool {
        guard Automation.isRunning(bundleID) else { return false } // not running: macOS can't tell yet
        return Automation.permission(bundleID, ask: false) == .denied
    }

    /// True while another request waits to use this app (at most 60 s, then it no longer counts).
    private func someoneWaits(for bundleID: String) -> Bool {
        guard let since = waitingApps[bundleID] else { return false }
        return ProcessInfo.processInfo.systemUptime - since <= ActionRunner.maxWait
    }

    private static func notAllowedDetail(_ app: String) -> String {
        "Not allowed to control \(app): System Settings > Privacy & Security > Automation > Silent Speech Bridge > \(app)"
    }

    // MARK: Texts (Messages)

    private func runText(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        let isHelp = action == "help"
        if isHelp { raiseHelpAlarm() } // the sound and the notice happen even when no text can go out
        let raw = config.to?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !raw.isEmpty else {
            refuse(action, "No contact set for \(action)", error: "no_contact",
                   logDetail: "No contact set for \(action) (run mac/set-contact.sh)", reply)
            return
        }
        guard let to = ActionRunner.cleanContact(raw) else {
            refuse(action, "The contact for \(action) must start with + and the country code", error: "bad_contact",
                   logDetail: "The contact for \(action) must start with + and the country code (run mac/set-contact.sh)", reply)
            return
        }
        guard !someoneWaits(for: ActionRunner.messagesBundleID) else {
            refuse(action, "Still waiting for Messages (is a popup open?)", error: "busy", reply)
            return
        }
        guard !knownDenied(ActionRunner.messagesBundleID) else {
            refuse(action, "Not allowed to control Messages", error: "not_allowed",
                   logDetail: ActionRunner.notAllowedDetail("Messages"), reply)
            return
        }
        let text = ActionRunner.cleanText(config.text) ?? ActionRunner.defaultTexts[action] ?? "Hi"
        let masked = ActionRunner.mask(to)
        let ticket = makeTicket(action)
        log.add("Real action: \(action): handing a text for \(masked) to Messages")
        if isHelp { setHelpDetail("Sending a text to \(masked)…") }
        reply(ActionOutcome(ok: true, dryRun: false, message: "Sending a text to \(masked)…"))

        // Messages (macOS 11 and later): the first iMessage account, the contact as a participant of it.
        let source = """
        with timeout of 20 seconds
            tell application id "\(ActionRunner.messagesBundleID)"
                set targetAccount to 1st account whose service type = iMessage
                set targetParticipant to participant "\(ActionRunner.appleScriptEscape(to))" of targetAccount
                send "\(ActionRunner.appleScriptEscape(text))" to targetParticipant
            end tell
        end timeout
        """
        prepareApp(ticket, bundleID: ActionRunner.messagesBundleID, appName: "Messages",
                   launchWait: ActionRunner.messagesLaunchWait) { [weak self] in
            self?.runScriptSoon(ticket, source) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success:
                    // Messages took it. Whether it was delivered shows only in Messages and on the phone.
                    self.logDone(action, "handed to Messages for \(masked)", contact: to)
                    if isHelp { self.setHelpDetail("Text handed to Messages for \(masked)") }
                case .failure(let failure):
                    self.logFailed(action, failure.explained(app: "Messages"), contact: to)
                }
            }
        }
    }

    private func raiseHelpAlarm() {
        if alertSound == nil { alertSound = NSSound(named: "Sosumi") }
        if let sound = alertSound {
            sound.stop()
            sound.play()
        } else {
            NSSound.beep()
        }
        helpNotice = HelpNotice(time: Date(), detail: "")
        NSApplication.shared.activate()
        onHelpNotice?(true)
        log.add("Help: alert sound played, notice shown in the window and a floating panel")
    }

    private func setHelpDetail(_ detail: String) {
        guard var notice = helpNotice else { return }
        notice.detail = detail
        helpNotice = notice
    }

    func dismissHelp() {
        guard helpNotice != nil else { return }
        helpNotice = nil
        onHelpNotice?(false)
    }

    // MARK: Other apps, without freezing

    /// Gets another app ready for AppleScript without blocking the main thread: opens it with NSWorkspace if it
    /// is not running, then asks for the Automation permission on a background queue (the popup waits there; motion
    /// and status keep flowing). While this runs the app counts as waited on (`someoneWaits`). Calls `ready` on the
    /// main queue only when the permission is given and the request may still run (`mayRun`); otherwise logs why not.
    private func prepareApp(_ ticket: Ticket, bundleID: String, appName: String, launchWait: TimeInterval,
                            ready: @escaping () -> Void) {
        let action = ticket.action
        let since = ProcessInfo.processInfo.systemUptime
        waitingApps[bundleID] = since
        let finish: () -> Void = { [weak self] in
            if self?.waitingApps[bundleID] == since { self?.waitingApps[bundleID] = nil }
        }
        let askPermission: () -> Void = { [weak self] in
            DispatchQueue.global(qos: .userInitiated).async {
                let permission = Automation.askPermission(bundleID)
                DispatchQueue.main.async {
                    finish()
                    guard let self = self else { return }
                    switch permission {
                    case .allowed:
                        if self.mayRun(ticket) { ready() }
                    case .denied:
                        self.logFailed(action, ActionRunner.notAllowedDetail(appName))
                    case .wouldAsk:
                        self.logFailed(action, "macOS showed no permission popup for \(appName), so nothing ran. "
                            + "Reset it (tccutil reset AppleEvents com.spiro.SilentSpeechBridge) and try again")
                    case .notRunning:
                        self.logFailed(action, "\(appName) is not running and could not be started")
                    case .other(let code):
                        self.logFailed(action, "Could not check the permission for \(appName) (\(code))")
                    }
                }
            }
        }
        if Automation.isRunning(bundleID) {
            askPermission()
            return
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            finish()
            logFailed(action, "\(appName) is not installed on this Mac")
            return
        }
        log.add("\(action): opening \(appName)")
        let options = NSWorkspace.OpenConfiguration()
        options.activates = false
        NSWorkspace.shared.openApplication(at: appURL, configuration: options) { [weak self] _, error in
            let problem = error?.localizedDescription
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let problem = problem {
                    finish()
                    self.logFailed(action, "Could not open \(appName): \(problem)")
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + launchWait) {
                    guard self.mayRun(ticket) else {
                        finish()
                        return
                    }
                    askPermission()
                }
            }
        }
    }

    // MARK: Volume

    private func runVolume(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        let step = Int(max(1, min(50, (config.step ?? ActionRunner.defaultStep).rounded())))
        log.add("Real action: \(action): volume up \(step)%")
        // Standard Additions run inside this app: quick, and no Automation permission needed.
        let source = """
        set currentSettings to get volume settings
        set oldVolume to output volume of currentSettings
        if oldVolume is missing value then error "This sound output has no volume control" number 9001
        set newVolume to oldVolume + \(step)
        if newVolume > 100 then set newVolume to 100
        set volume output volume newVolume
        if output muted of currentSettings then set volume output muted false
        return (oldVolume as text) & " " & (newVolume as text)
        """
        switch ActionRunner.runScript(source) {
        case .success(let text):
            let parts = text.split(separator: " ").map(String.init)
            let message: String
            if parts.count == 2 {
                message = parts[0] == parts[1] ? "Volume is at \(parts[1])%" : "Volume \(parts[0])% to \(parts[1])%"
            } else {
                message = "Volume up"
            }
            logDone(action, message)
            reply(ActionOutcome(ok: true, dryRun: false, message: message))
        case .failure(let failure):
            refuse(action, "Could not change the volume", error: "script_failed",
                   logDetail: failure.explained(app: "the volume"), reply)
        }
    }

    // MARK: Apple Music

    private func runAppleMusic(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        var playlist: String?
        if let raw = config.playlist {
            guard let clean = ActionRunner.cleanText(raw), clean.count <= 100 else {
                refuse(action, "The playlist name for \(action) is empty or too long", error: "bad_playlist", reply)
                return
            }
            playlist = clean
        }
        let url: String
        if let raw = config.url {
            guard let clean = ActionRunner.appleMusicURL(raw) else {
                refuse(action, "The Apple Music link for \(action) must be a music.apple.com or music:// link", error: "bad_url", reply)
                return
            }
            url = clean
        } else {
            url = ActionRunner.defaultAppleMusicURL
        }
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: ActionRunner.musicBundleID) != nil else {
            refuse(action, "The Music app is not on this Mac", error: "no_music", reply)
            return
        }
        guard !someoneWaits(for: ActionRunner.musicBundleID) else {
            refuse(action, "Still waiting for Music (is a popup open?)", error: "busy", reply)
            return
        }
        guard !knownDenied(ActionRunner.musicBundleID) else {
            refuse(action, "Not allowed to control Music", error: "not_allowed",
                   logDetail: ActionRunner.notAllowedDetail("Music"), reply)
            return
        }
        let ticket = makeTicket(action)
        let plan = playlist.map { "your playlist \"\($0)\" if it exists, else the focus playlist link" } ?? "the focus playlist link"
        log.add("Real action: \(action): Apple Music, \(plan)")
        reply(ActionOutcome(ok: true, dryRun: false, message: "Starting focus music…"))

        prepareApp(ticket, bundleID: ActionRunner.musicBundleID, appName: "Music",
                   launchWait: ActionRunner.musicLaunchWait) { [weak self] in
            guard let self = self else { return }
            if let playlist = playlist {
                self.playLibraryPlaylist(ticket, playlist, url: url)
            } else {
                self.playMusicLink(ticket, url)
            }
        }
    }

    private static let music = "application id \"\(musicBundleID)\""

    /// Step 1 (with a playlist name): play that library playlist; no such playlist: go on with the link.
    private func playLibraryPlaylist(_ ticket: Ticket, _ name: String, url: String) {
        let escaped = ActionRunner.appleScriptEscape(name)
        let source = """
        with timeout of 20 seconds
            tell \(ActionRunner.music)
                if not (exists playlist "\(escaped)") then return "missing"
                play playlist "\(escaped)"
                return "started"
            end tell
        end timeout
        """
        runScriptSoon(ticket, source) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let text) where text == "started":
                self.checkMusicPlays(ticket, after: 2, what: "your playlist \"\(name)\"") { [weak self] in
                    self?.playMusicLink(ticket, url)
                }
            case .success:
                self.log.add("\(ticket.action): no playlist \"\(name)\" in the Music library, using the focus playlist link")
                self.playMusicLink(ticket, url)
            case .failure(let failure):
                self.logFailed(ticket.action, failure.explained(app: "Music"))
            }
        }
    }

    /// Step 2: open the Apple Music link in Music, wait, play. Not playing a few seconds later (no subscription,
    /// not signed in): step 3, shuffle the library.
    private func playMusicLink(_ ticket: Ticket, _ url: String) {
        let open = "with timeout of 20 seconds\n tell \(ActionRunner.music) to open location \"\(ActionRunner.appleScriptEscape(url))\"\nend timeout"
        let play = "with timeout of 20 seconds\n tell \(ActionRunner.music) to play\nend timeout"
        runScriptSoon(ticket, open) { [weak self] result in
            guard let self = self else { return }
            if case .failure(let failure) = result {
                self.log.add("\(ticket.action): Music could not open the focus playlist link (\(failure.number)), shuffling the library")
                self.shuffleLibrary(ticket)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + ActionRunner.musicOpenWait) { [weak self] in
                guard let self = self, self.mayRun(ticket) else { return }
                _ = ActionRunner.runScript(play) // whether it plays is checked below either way
                self.checkMusicPlays(ticket, after: ActionRunner.musicPlayCheck, what: "after opening the focus playlist") { [weak self] in
                    self?.log.add("\(ticket.action): the focus playlist did not start (Apple Music subscription? signed in?), shuffling the library")
                    self?.shuffleLibrary(ticket)
                }
            }
        }
    }

    /// Step 3: shuffle the whole library. Empty library: failed, with a plain message.
    private func shuffleLibrary(_ ticket: Ticket) {
        let source = """
        with timeout of 20 seconds
            tell \(ActionRunner.music)
                if (count of tracks of library playlist 1) is 0 then return "empty"
                set shuffle enabled to true
                play library playlist 1
                return "started"
            end tell
        end timeout
        """
        guard mayRun(ticket) else { return }
        switch ActionRunner.runScript(source) {
        case .success(let text) where text == "started":
            checkMusicPlays(ticket, after: 2, what: "shuffling your library") { [weak self] in
                self?.logFailed(ticket.action, "Music did not start playing (is Apple Music signed in?)")
            }
        case .success:
            logFailed(ticket.action, "No focus music: the focus playlist did not play and your Music library is empty")
        case .failure(let failure):
            logFailed(ticket.action, failure.explained(app: "Music"))
        }
    }

    /// Logs "done: playing <track> by <artist> (<what>)" if Music plays after `delay`; else calls `otherwise`.
    private func checkMusicPlays(_ ticket: Ticket, after delay: TimeInterval, what: String, otherwise: @escaping () -> Void) {
        let source = """
        with timeout of 10 seconds
            tell \(ActionRunner.music)
                if player state is not playing then return "no"
                try
                    return "yes" & (name of current track) & " by " & (artist of current track)
                on error
                    return "yes"
                end try
            end tell
        end timeout
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.mayRun(ticket) else { return }
            switch ActionRunner.runScript(source) {
            case .success(let text) where text.hasPrefix("yes"):
                let track = String(text.dropFirst(3).prefix(80))
                self.logDone(ticket.action, track.isEmpty ? "Music is playing (\(what))" : "playing \(track) (\(what))")
            case .success:
                otherwise()
            case .failure(let failure):
                self.logFailed(ticket.action, failure.explained(app: "Music"))
            }
        }
    }

    // MARK: Spotify

    private func runSpotify(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        let uri: String
        if let configured = config.uri {
            guard let clean = ActionRunner.spotifyURI(configured) else {
                refuse(action, "The Spotify link for \(action) is not a spotify: URI", error: "bad_uri", reply)
                return
            }
            uri = clean
        } else {
            uri = ActionRunner.defaultSpotifyURI
        }
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: ActionRunner.spotifyBundleID) != nil else {
            refuse(action, "Spotify is not installed on this Mac", error: "no_spotify", reply)
            return
        }
        guard !someoneWaits(for: ActionRunner.spotifyBundleID) else {
            refuse(action, "Still waiting for Spotify (is a popup open?)", error: "busy", reply)
            return
        }
        guard !knownDenied(ActionRunner.spotifyBundleID) else {
            refuse(action, "Not allowed to control Spotify", error: "not_allowed",
                   logDetail: ActionRunner.notAllowedDetail("Spotify"), reply)
            return
        }
        let ticket = makeTicket(action)
        log.add("Real action: \(action): playing \(uri) in Spotify")
        reply(ActionOutcome(ok: true, dryRun: false, message: "Starting focus music…"))

        let app = "application id \"\(ActionRunner.spotifyBundleID)\""
        let play = "with timeout of 20 seconds\n tell \(app) to play track \"\(ActionRunner.appleScriptEscape(uri))\"\nend timeout"
        let state = "with timeout of 10 seconds\n tell \(app) to return (player state as string)\nend timeout"
        prepareApp(ticket, bundleID: ActionRunner.spotifyBundleID, appName: "Spotify",
                   launchWait: ActionRunner.spotifyLaunchWait) { [weak self] in
            self?.runScriptSoon(ticket, play) { [weak self] result in
                guard let self = self else { return }
                if case .failure(let failure) = result {
                    self.logFailed(action, failure.explained(app: "Spotify"))
                    return
                }
                // Check that it really plays (Spotify ignores play when nobody is logged in). Read only.
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self = self else { return }
                    switch ActionRunner.runScript(state) {
                    case .success(let text) where text == "playing":
                        self.logDone(action, "Spotify is playing")
                    case .success(let text):
                        self.logFailed(action, "Spotify did not start (player state: \(logSafeName(text))). Is Spotify logged in?")
                    case .failure(let failure):
                        self.logFailed(action, failure.explained(app: "Spotify"))
                    }
                }
            }
        }
    }

    // MARK: Say

    private func runSay(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        let text = ActionRunner.cleanText(config.text) ?? ActionRunner.defaultTexts[action] ?? "Hello"
        log.add("Real action: \(action): saying it out loud")
        speaker.speak(text) { [weak self] finished in
            if finished {
                self?.logDone(action, "said it out loud")
            } else {
                self?.logFailed(action, "the speech was cut off")
            }
        }
        reply(ActionOutcome(ok: true, dryRun: false, message: "Saying: \(text)"))
    }

    // MARK: Calendar

    private func runCalendar(_ action: String, _ reply: (ActionOutcome) -> Void) {
        let now = ProcessInfo.processInfo.systemUptime
        if let since = calendarBusySince, now - since < ActionRunner.calendarMaxBusy {
            refuse(action, "Still reading your calendar", error: "busy", reply)
            return
        }
        calendarBusySince = now
        let ticket = makeTicket(action)
        log.add("Real action: \(action): reading today's events")
        reply(ActionOutcome(ok: true, dryRun: false, message: "Working on it"))

        let store = eventStore ?? EKEventStore()
        eventStore = store
        let status = EKEventStore.authorizationStatus(for: .event)
        if status == .fullAccess {
            readToday(ticket, store)
        } else if status == .notDetermined {
            log.add("Calendar: asking for access (a popup shows; the answer is Allow Full Access)")
            store.requestFullAccessToEvents { [weak self] granted, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if granted {
                        self.readToday(ticket, store)
                    } else {
                        self.calendarFailed(ticket, "Calendar access was not allowed")
                    }
                }
            }
        } else {
            let why = status == .writeOnly ? "Calendar access is add only" : "No calendar access"
            calendarFailed(ticket, "\(why): System Settings > Privacy & Security > Calendars > Silent Speech Bridge > Full Access")
        }
    }

    private func calendarFailed(_ ticket: Ticket, _ why: String) {
        logFailed(ticket.action, why)
        guard mayRun(ticket, quiet: true) else {
            calendarBusySince = nil
            return
        }
        speaker.speak("I can't read your calendar yet.") { [weak self] _ in
            self?.calendarBusySince = nil
        }
    }

    private func readToday(_ ticket: Ticket, _ store: EKEventStore) {
        let action = ticket.action
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else {
            calendarFailed(ticket, "could not work out today's date")
            return
        }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
            .sorted { $0.compareStartDate(with: $1) == .orderedAscending }
            .map { DayEvent(title: ActionRunner.cleanText($0.title) ?? "Something", start: $0.startDate, end: $0.endDate, allDay: $0.isAllDay) }

        let once = ReplyOnce()
        let speakIt: (String, Bool) -> Void = { [weak self] sentence, fromModel in
            guard let self = self, once.claim() else { return }
            guard self.mayRun(ticket) else {
                self.calendarBusySince = nil
                return
            }
            let how = fromModel ? "a summary from the on device model" : "the plain list"
            self.speaker.speak(sentence) { [weak self] _ in
                guard let self = self else { return }
                self.calendarBusySince = nil
                // Event titles stay out of the log (private): only the count and how the sentence was made.
                self.logDone(action, "\(events.count) event(s) today, said \(how)")
            }
        }
        let plain = DaySummary.plainReadout(events)
        if events.isEmpty {
            speakIt(plain, false)
            return
        }
        DaySummary.modelSummary(events) { sentence in
            if let sentence = sentence {
                speakIt(sentence, true)
            } else {
                speakIt(plain, false)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + ActionRunner.summaryTimeout) {
            speakIt(plain, false)
        }
    }

    // MARK: AppleScript

    struct ScriptFailure: Error {
        let number: Int
        let message: String

        /// A plain sentence for the log. Callers mask contacts.
        func explained(app: String) -> String {
            switch number {
            case -1743: return ActionRunner.notAllowedDetail(app)
            case -600, -609: return "\(app) is not running and could not be started"
            case -1712: return "\(app) took too long to answer"
            default: return "\(app) said: \(message) (\(number))"
            }
        }
    }

    /// Runs AppleScript on the main thread (NSAppleScript is main thread only). Blocks until the script ends, so
    /// scripts for other apps only run after `prepareApp` (app open, permission given): then it is quick.
    static func runScript(_ source: String) -> Result<String, ScriptFailure> {
        guard let script = NSAppleScript(source: source) else {
            return .failure(ScriptFailure(number: 0, message: "could not make the script"))
        }
        var errorInfo: NSDictionary?
        let result = script.executeAndReturnError(&errorInfo)
        if let errorInfo = errorInfo {
            let number = (errorInfo[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
            let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "unknown error"
            return .failure(ScriptFailure(number: number, message: String(message.prefix(200))))
        }
        return .success(result.stringValue ?? "")
    }

    /// Runs a script on the main thread a moment later (the reply goes out first), but only if the request may
    /// still run then (`mayRun`); else logs "<action> cancelled: ..." and runs nothing.
    private func runScriptSoon(_ ticket: Ticket, _ source: String, then: @escaping (Result<String, ScriptFailure>) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + ActionRunner.scriptDelay) { [weak self] in
            guard let self = self, self.mayRun(ticket) else { return }
            then(ActionRunner.runScript(source))
        }
    }

    /// Inside an AppleScript "..." string only backslash and double quote are special.
    static func appleScriptEscape(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    // MARK: Cleaning and masking

    /// A phone number that starts with + and the country code, kept as + and 8 to 15 digits. Anything else (a
    /// number without the country code, an email, a name): nil.
    static func cleanContact(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        let phoneChars = Set("+0123456789 ()-.")
        guard text.hasPrefix("+"), text.allSatisfy({ phoneChars.contains($0) }), !text.dropFirst().contains("+") else { return nil }
        let digits = text.filter { $0.isASCII && $0.isNumber }
        guard !digits.hasPrefix("0"), (8...15).contains(digits.count) else { return nil }
        return "+" + digits
    }

    /// Control characters (Unicode Cc) become spaces, then trim and cut to 300 characters. Emoji joiners and
    /// variation selectors stay. Nothing left: nil.
    static func cleanText(_ raw: String?) -> String? {
        guard let raw = raw else { return nil }
        var scalars = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars {
            scalars.append(scalar.properties.generalCategory == .control ? " " : scalar)
        }
        let text = String(String(scalars).trimmingCharacters(in: .whitespaces).prefix(maxTextLength))
        return text.isEmpty ? nil : text
    }

    /// "+15551234567" -> "••67" (anything with @ -> "•••@•••"). Logs and replies never show a whole contact.
    static func mask(_ contact: String) -> String {
        if contact.contains("@") { return "•••@•••" }
        let digits = contact.filter { $0.isASCII && $0.isNumber }
        return "••" + String(digits.suffix(2))
    }

    /// Masks the configured contact and anything that looks like a phone number (5 or more digits, maybe with
    /// + ( ) - . or spaces) or an email in free text, such as an AppleScript error.
    static func scrubContacts(_ text: String, contact: String?) -> String {
        var out = text
        if let contact = contact, !contact.isEmpty {
            out = out.replacingOccurrences(of: contact, with: mask(contact))
        }
        out = replaceMatches(in: out, pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}") { _ in "•••@•••" }
        out = replaceMatches(in: out, pattern: "\\+?\\d[\\d ().-]{3,}\\d") { found in
            found.filter({ $0.isNumber }).count >= 5 ? mask(found) : nil
        }
        return out
    }

    private static func replaceMatches(in text: String, pattern: String, with replacement: (String) -> String?) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let ns = text as NSString
        var out = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let new = replacement(ns.substring(with: match.range)), let range = Range(match.range, in: out) else { continue }
            out.replaceSubrange(range, with: new)
        }
        return out
    }

    /// An Apple Music link: https://music.apple.com/... or music://... with only plain URL characters. Else nil.
    static func appleMusicURL(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        let pattern = "^(https://music\\.apple\\.com/|music://)[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{1,300}$"
        guard text.range(of: pattern, options: .regularExpression) != nil, URL(string: text) != nil else { return nil }
        return text
    }

    /// "spotify:playlist:<id>" (or album, track, artist, show, episode), or an open.spotify.com link to one.
    static func spotifyURI(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        let kinds = "(playlist|album|track|artist|show|episode)"
        if text.range(of: "^spotify:\(kinds):[A-Za-z0-9]{10,40}$", options: .regularExpression) != nil {
            return text
        }
        let link = "^https://open\\.spotify\\.com/(intl-[a-z-]+/)?\(kinds)/[A-Za-z0-9]{10,40}(\\?.*)?$"
        if text.range(of: link, options: .regularExpression) != nil, let url = URL(string: text) {
            let parts = url.path.split(separator: "/").filter { !$0.hasPrefix("intl-") }
            if parts.count == 2 { return "spotify:\(parts[0]):\(parts[1])" }
        }
        return nil
    }
}

/// Lets only the first of several callers through (the model's answer or the timeout).
final class ReplyOnce {
    private var taken = false

    func claim() -> Bool {
        if taken { return false }
        taken = true
        return true
    }
}

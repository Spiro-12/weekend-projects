// Runs the action a paired dashboard asks for (PROTOCOL.md §2). Not Armed: a dry run, nothing happens.
// Armed: the real thing. Settings come from ~/.silentspeech/actions.json (never in the repo; see
// mac/actions.example.json). Texts only ever go to the `to` contacts in that file. Every real action is logged,
// with phone numbers masked to the last 2 digits. Main queue only.
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

/// The kinds of real actions. Each action id has exactly one kind (`ActionRunner.kinds`), so only the actions
/// with the 30 s cooldown (ProtocolV1.sensitiveActions) can ever send a text.
enum ActionKind: String {
    case imessage // send `text` to `to` with Messages
    case volume   // turn the system volume up by `step` percent
    case spotify  // play `uri` in Spotify
    case say      // speak `text` out loud (through the AirPods when they are the sound output)
    case calendar // read today's events, summarize, speak (long: replies "Working on it" first)
}

/// One entry of ~/.silentspeech/actions.json. `kind` must match the action's kind. Missing fields use the
/// defaults, except `to`: there is never a default contact.
struct ActionConfig {
    var to: String?
    var text: String?
    var step: Double?
    var uri: String?
}

/// Shown in the window when `help` runs, until dismissed.
struct HelpNotice {
    let time: Date
    var detail: String
}

final class ActionRunner: ObservableObject {
    /// The `action` ids from shared/classes.json (everything except `none`). Sent in `hello.actions`.
    static let actionKeys = ["text_mom", "volume_up", "call_back", "demo_48h", "help", "calendar", "focus_music"]
    static let configPath = NSHomeDirectory() + "/.silentspeech/actions.json"

    static let kinds: [String: ActionKind] = [
        "text_mom": .imessage, "call_back": .imessage, "help": .imessage,
        "volume_up": .volume, "focus_music": .spotify, "demo_48h": .say, "calendar": .calendar,
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
    static let messagesBundleID = "com.apple.MobileSMS"
    static let maxTextLength = 300
    /// AppleScript to other apps runs this long after the reply went out (see `runScriptSoon`).
    static let scriptDelay: TimeInterval = 0.15
    /// Spotify needs a moment after it opens before it takes a play command.
    static let spotifyLaunchWait: TimeInterval = 5
    /// The on device model gets this long for the calendar summary, then the plain readout is used.
    static let summaryTimeout: TimeInterval = 10
    /// A calendar run that never finished (speech stuck) stops blocking new ones after this long.
    static let calendarMaxBusy: TimeInterval = 60

    @Published private(set) var helpNotice: HelpNotice? = nil

    private(set) var configs: [String: ActionConfig] = [:]
    private var configData: Data?
    private var configLoaded = false
    private let log: LogStore
    private let speaker = Speaker()
    private var eventStore: EKEventStore?
    private var calendarBusySince: TimeInterval?
    private var alertSound: NSSound?

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
            log.add("No ~/.silentspeech/actions.json: texts have no contact, the other actions use defaults")
            return
        }
        guard let all = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            log.add("Could not read ~/.silentspeech/actions.json (not a JSON object), ignoring it")
            return
        }
        for (action, value) in all.sorted(by: { $0.key < $1.key }) {
            guard let kind = ActionRunner.kinds[action] else {
                log.add("actions.json: unknown action \(String(action.prefix(40))), skipped")
                continue
            }
            if let config = parseEntry(action, kind: kind, value) {
                configs[action] = config
            }
        }
        log.add("Loaded actions.json: \(configs.keys.sorted().joined(separator: ", "))")
    }

    private func parseEntry(_ action: String, kind: ActionKind, _ value: Any) -> ActionConfig? {
        func skip(_ why: String) -> ActionConfig? {
            log.add("actions.json: \(action) skipped (\(why))")
            return nil
        }
        guard let entry = value as? [String: Any] else { return skip("not an object") }
        guard (entry["kind"] as? String) == kind.rawValue else { return skip("kind must be \"\(kind.rawValue)\"") }
        var config = ActionConfig()
        for (key, field) in entry where key != "kind" {
            switch key {
            case "to", "text", "uri":
                guard let text = field as? String else { return skip("\(key) must be text") }
                if key == "to" {
                    config.to = text
                } else if key == "text" {
                    config.text = text
                } else {
                    config.uri = text
                }
            case "step":
                guard let number = field as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
                    return skip("step must be a number")
                }
                config.step = number.doubleValue
            default:
                log.add("actions.json: \(action) has an unknown field \(String(key.prefix(20))), ignored")
            }
        }
        return config
    }

    // MARK: Running

    /// Answers one action request. Called on the main queue. Calls `reply` once, on the main queue, right away
    /// (the server sends it as `actionResult`; the Mac must reply within 1 s). Actions that talk to other apps
    /// (Messages, Spotify) or take long (calendar) reply first and finish in the background; the end is logged
    /// as "<action> done: ..." or "<action> failed: ...".
    func run(_ action: String, armed: Bool, reply: @escaping (ActionOutcome) -> Void) {
        guard let kind = ActionRunner.kinds[action] else {
            log.add("No such action: \(String(action.prefix(64)))")
            reply(ActionOutcome(ok: false, dryRun: !armed, message: "No such action", error: "unknown_action"))
            return
        }
        guard armed else {
            log.add("Dry run: \(action) (not armed, would run \(kind.rawValue))")
            reply(ActionOutcome(ok: true, dryRun: true, message: "Dry run: \(action)"))
            return
        }
        reloadIfChanged()
        let config = configs[action] ?? ActionConfig()
        switch kind {
        case .imessage: runText(action, config, reply)
        case .volume: runVolume(action, config, reply)
        case .spotify: runSpotify(action, config, reply)
        case .say: runSay(action, config, reply)
        case .calendar: runCalendar(action, reply)
        }
    }

    private func logDone(_ action: String, _ text: String) {
        log.add("\(action) done: \(ActionRunner.scrubNumbers(text))")
    }

    private func logFailed(_ action: String, _ text: String) {
        log.add("\(action) failed: \(ActionRunner.scrubNumbers(text))")
    }

    /// Logs the failure and replies ok:false.
    private func refuse(_ action: String, _ message: String, error: String, logDetail: String? = nil,
                        _ reply: (ActionOutcome) -> Void) {
        logFailed(action, logDetail ?? message)
        reply(ActionOutcome(ok: false, dryRun: false, message: ActionRunner.scrubNumbers(message), error: error))
    }

    // MARK: Texts (Messages)

    private func runText(_ action: String, _ config: ActionConfig, _ reply: (ActionOutcome) -> Void) {
        let isHelp = action == "help"
        if isHelp { raiseHelpAlarm() } // the sound and the notice happen even when no text can go out
        guard let raw = config.to, !raw.trimmingCharacters(in: .whitespaces).isEmpty else {
            if isHelp { setHelpDetail("No text sent: no contact set for help") }
            refuse(action, "No contact set for \(action)", error: "no_contact",
                   logDetail: "No contact set for \(action) (add \"to\" in ~/.silentspeech/actions.json)", reply)
            return
        }
        guard let to = ActionRunner.cleanContact(raw) else {
            if isHelp { setHelpDetail("No text sent: the contact for help is not a phone number or email") }
            refuse(action, "The contact for \(action) is not a phone number or email", error: "bad_contact", reply)
            return
        }
        let text = ActionRunner.cleanText(config.text) ?? ActionRunner.defaultTexts[action] ?? "Hi"
        let masked = ActionRunner.mask(to)
        log.add("Real action: \(action): texting \(masked) with Messages")
        if isHelp { setHelpDetail("Texting \(masked)...") }
        reply(ActionOutcome(ok: true, dryRun: false, message: "Texting \(masked)"))

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
        runScriptSoon(source) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.logDone(action, "sent to \(masked) with Messages")
                if isHelp { self.setHelpDetail("Text sent to \(masked)") }
            case .failure(let failure):
                let why = failure.explained(app: "Messages")
                self.logFailed(action, why)
                if isHelp { self.setHelpDetail("The text did not go out: \(ActionRunner.scrubNumbers(why))") }
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
        log.add("Help: alert sound played, notice shown in the window")
    }

    private func setHelpDetail(_ detail: String) {
        guard var notice = helpNotice else { return }
        notice.detail = detail
        helpNotice = notice
    }

    func dismissHelp() {
        helpNotice = nil
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
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: ActionRunner.spotifyBundleID) else {
            refuse(action, "Spotify is not installed on this Mac", error: "no_spotify", reply)
            return
        }
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: ActionRunner.spotifyBundleID).isEmpty
        log.add("Real action: \(action): playing \(uri) in Spotify\(running ? "" : " (opening Spotify first)")")
        reply(ActionOutcome(ok: true, dryRun: false, message: running ? "Playing focus music" : "Opening Spotify for focus music"))

        if running {
            playSpotify(action, uri: uri, after: ActionRunner.scriptDelay)
            return
        }
        let options = NSWorkspace.OpenConfiguration()
        options.activates = false
        NSWorkspace.shared.openApplication(at: appURL, configuration: options) { [weak self] _, error in
            let problem = error?.localizedDescription
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let problem = problem {
                    self.logFailed(action, "Could not open Spotify: \(problem)")
                    return
                }
                self.playSpotify(action, uri: uri, after: ActionRunner.spotifyLaunchWait)
            }
        }
    }

    private func playSpotify(_ action: String, uri: String, after delay: TimeInterval) {
        let app = "application id \"\(ActionRunner.spotifyBundleID)\""
        let play = "with timeout of 20 seconds\n tell \(app) to play track \"\(ActionRunner.appleScriptEscape(uri))\"\nend timeout"
        let state = "with timeout of 10 seconds\n tell \(app) to return (player state as string)\nend timeout"
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self else { return }
            if case .failure(let failure) = ActionRunner.runScript(play) {
                self.logFailed(action, failure.explained(app: "Spotify"))
                return
            }
            // Check that it really plays (Spotify ignores play when nobody is logged in).
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self = self else { return }
                switch ActionRunner.runScript(state) {
                case .success(let text) where text == "playing":
                    self.logDone(action, "Spotify is playing")
                case .success(let text):
                    self.logFailed(action, "Spotify did not start (player state: \(String(text.prefix(20)))). Is Spotify logged in?")
                case .failure(let failure):
                    self.logFailed(action, failure.explained(app: "Spotify"))
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
        log.add("Real action: \(action): reading today's events")
        reply(ActionOutcome(ok: true, dryRun: false, message: "Working on it"))

        let store = eventStore ?? EKEventStore()
        eventStore = store
        let status = EKEventStore.authorizationStatus(for: .event)
        if status == .fullAccess {
            readToday(action, store)
        } else if status == .notDetermined {
            log.add("Calendar: asking for access (a popup shows; the answer is Allow Full Access)")
            store.requestFullAccessToEvents { [weak self] granted, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if granted {
                        self.readToday(action, store)
                    } else {
                        self.calendarFailed(action, "Calendar access was not allowed")
                    }
                }
            }
        } else {
            let why = status == .writeOnly ? "Calendar access is add only" : "No calendar access"
            calendarFailed(action, "\(why): System Settings > Privacy & Security > Calendars > Silent Speech Bridge > Full Access")
        }
    }

    private func calendarFailed(_ action: String, _ why: String) {
        logFailed(action, why)
        speaker.speak("I can't read your calendar yet.") { [weak self] _ in
            self?.calendarBusySince = nil
        }
    }

    private func readToday(_ action: String, _ store: EKEventStore) {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else {
            calendarFailed(action, "could not work out today's date")
            return
        }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
            .sorted { $0.compareStartDate(with: $1) == .orderedAscending }
            .map { DayEvent(title: ActionRunner.cleanText($0.title) ?? "Something", start: $0.startDate, end: $0.endDate, allDay: $0.isAllDay) }

        let once = ReplyOnce()
        let speakIt: (String, Bool) -> Void = { [weak self] sentence, fromModel in
            guard let self = self, once.claim() else { return }
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

        /// A plain sentence for the log and the dashboard. Callers mask numbers.
        func explained(app: String) -> String {
            switch number {
            case -1743: return "Not allowed to control \(app): System Settings > Privacy & Security > Automation > Silent Speech Bridge"
            case -600, -609: return "\(app) is not running and could not be started"
            case -1712: return "\(app) took too long to answer"
            default: return "\(app) said: \(message) (\(number))"
            }
        }
    }

    /// Runs AppleScript on the main thread (NSAppleScript is main thread only). Blocks until the script ends.
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

    /// For scripts that talk to another app: run them on the main thread a moment after the reply went out. The
    /// other app may have to start, or a permission popup may wait for a click, and the reply must not wait for that.
    private func runScriptSoon(_ source: String, then: @escaping (Result<String, ScriptFailure>) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + ActionRunner.scriptDelay) {
            then(ActionRunner.runScript(source))
        }
    }

    /// Inside an AppleScript "..." string only backslash and double quote are special.
    static func appleScriptEscape(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    // MARK: Cleaning and masking

    /// A phone number (kept as an optional + and 5 to 15 digits) or an email address. Anything else: nil.
    static func cleanContact(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        let phoneChars = Set("+0123456789 ()-.")
        if !text.isEmpty && text.allSatisfy({ phoneChars.contains($0) }) {
            let digits = text.filter { $0.isASCII && $0.isNumber }
            guard !text.dropFirst().contains("+"), (5...15).contains(digits.count) else { return nil }
            return (text.hasPrefix("+") ? "+" : "") + digits
        }
        let email = "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$"
        if text.count <= 100, text.range(of: email, options: .regularExpression) != nil {
            return text
        }
        return nil
    }

    /// Control characters become spaces, then trim and cut to 300 characters. Nothing left: nil.
    static func cleanText(_ raw: String?) -> String? {
        guard let raw = raw else { return nil }
        let flat = String(raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : Character($0) })
        let text = String(flat.trimmingCharacters(in: .whitespaces).prefix(maxTextLength))
        return text.isEmpty ? nil : text
    }

    /// "+15551234567" -> "••67". Emails -> "•••@•••". Logs and replies never show a whole contact.
    static func mask(_ contact: String) -> String {
        if contact.contains("@") { return "•••@•••" }
        let digits = contact.filter { $0.isASCII && $0.isNumber }
        return "••" + String(digits.suffix(2))
    }

    /// Masks anything that looks like a phone number (5 or more digits, maybe with + ( ) - . or spaces) in free
    /// text, such as an AppleScript error that quotes the contact.
    static func scrubNumbers(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "\\+?\\d[\\d ().-]{3,}\\d") else { return text }
        let ns = text as NSString
        var out = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            let found = ns.substring(with: match.range)
            guard found.filter({ $0.isNumber }).count >= 5, let range = Range(match.range, in: out) else { continue }
            out.replaceSubrange(range, with: mask(found))
        }
        return out
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

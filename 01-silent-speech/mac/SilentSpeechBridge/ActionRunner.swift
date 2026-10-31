// Runs the action a dashboard asks for. Phase 1: every action is a dry run (nothing happens).
// Phase 2 adds the real kinds below, read from ~/.silentspeech/actions.json (never in the repo).
import Foundation

/// What an action answers right away (PROTOCOL.md §2 `actionResult`).
struct ActionOutcome {
    let ok: Bool
    let dryRun: Bool
    let message: String
    var error: String? = nil
}

/// The kinds of real actions. Phase 2 implements them; Phase 1 only dry runs.
enum ActionKind: String {
    case imessage // send `text` to `to` with Messages
    case volume   // change system volume by `step` percent
    case music    // play `playlist` in Music
    case shortcut // run the Shortcut called `name`
    case say      // speak `text` out loud
    case calendar // read today's events, summarize, speak (long: replies "Working on it" first)
}

/// One entry of ~/.silentspeech/actions.json. See mac/actions.example.json for the shape.
struct ActionConfig: Decodable {
    let kind: String
    let to: String?
    let text: String?
    let step: Double?
    let playlist: String?
    let name: String?
}

final class ActionRunner {
    /// The `action` ids from shared/classes.json (everything except `none`). Sent in `hello.actions`.
    static let actionKeys = ["text_mom", "volume_up", "call_back", "demo_48h", "help", "calendar", "focus_music"]
    static let configPath = NSHomeDirectory() + "/.silentspeech/actions.json"

    private(set) var configs: [String: ActionConfig] = [:]
    private let log: LogStore

    init(log: LogStore) {
        self.log = log
        reload()
    }

    /// Loads ~/.silentspeech/actions.json if it exists. Any problem: ignore the file.
    func reload() {
        let path = ActionRunner.configPath
        guard let data = FileManager.default.contents(atPath: path) else {
            configs = [:]
            log.add("No ~/.silentspeech/actions.json (fine for now: every action is a dry run)")
            return
        }
        guard let all = try? JSONDecoder().decode([String: ActionConfig].self, from: data) else {
            configs = [:]
            log.add("Could not read ~/.silentspeech/actions.json, ignoring it")
            return
        }
        configs = all.filter { ActionRunner.actionKeys.contains($0.key) }
        log.add("Loaded actions.json: \(configs.keys.sorted().joined(separator: ", "))")
    }

    /// Answers one action request. Called on the main queue. Calls `reply` once, on the main queue,
    /// right away (the server sends it as `actionResult`; the Mac must reply within 1 s).
    /// Phase 1: always a dry run, armed or not.
    /// Phase 2: when `armed`, look up `configs[action]`, switch on `ActionKind`, run it, and reply.
    /// Long kinds (calendar) reply `ok: true, message: "Working on it"` first and finish in the background.
    func run(_ action: String, armed: Bool, reply: @escaping (ActionOutcome) -> Void) {
        let kind = configs[action].flatMap { ActionKind(rawValue: $0.kind) }
        let plan = kind.map { "would run \($0.rawValue)" } ?? "no actions.json entry"
        let armedText = armed ? "armed" : "not armed"
        log.add("Dry run: \(action) (\(armedText), \(plan))")
        reply(ActionOutcome(ok: true, dryRun: true, message: "Dry run: \(action)"))
    }
}

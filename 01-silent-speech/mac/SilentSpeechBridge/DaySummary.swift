// Today's calendar as one spoken sentence. On macOS 26 with Apple Intelligence on, the on device model writes a
// friendly summary; otherwise (or if it fails or is slow) a plain readout. Event titles never leave this Mac
// and never go in the log.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// One calendar event, already cleaned (no control characters).
struct DayEvent {
    let title: String
    let start: Date?
    let end: Date?
    let allDay: Bool
}

enum DaySummary {
    /// The plain readout names at most this many events, then "plus N more".
    static let maxSpoken = 6
    /// The model sees at most this many events.
    static let maxForModel = 12
    static let maxSentenceLength = 400

    private static let timeFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    /// "You have 3 things today: Standup at 9:00 AM, Lunch at 12:30 PM and Gym at 6:00 PM."
    static func plainReadout(_ events: [DayEvent]) -> String {
        if events.isEmpty { return "Your calendar is clear today." }
        let items = events.prefix(maxSpoken).map { event -> String in
            event.allDay ? "\(event.title), all day" : "\(event.title) at \(time(event.start))"
        }
        var list = items[0]
        if items.count > 1 {
            list = items[0..<(items.count - 1)].joined(separator: ", ") + " and " + items[items.count - 1]
        }
        let more = events.count > maxSpoken ? ", plus \(events.count - maxSpoken) more" : ""
        let things = events.count == 1 ? "1 thing" : "\(events.count) things"
        return "You have \(things) today: \(list)\(more)."
    }

    /// What the model is told about the day.
    static func facts(_ events: [DayEvent]) -> String {
        let lines = events.prefix(maxForModel).map { event -> String in
            event.allDay ? "- All day: \(event.title)" : "- \(time(event.start)) to \(time(event.end)): \(event.title)"
        }
        return "Today's events (\(events.count) in total):\n" + lines.joined(separator: "\n")
    }

    /// Calls `then` on the main queue with one sentence from the on device model, or nil when there is no model
    /// (older macOS, Apple Intelligence off or not ready) or it failed. The caller also runs its own timeout.
    static func modelSummary(_ events: [DayEvent], then: @escaping (String?) -> Void) {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                then(nil)
                return
            }
            let prompt = facts(events)
            Task {
                var sentence: String?
                do {
                    let session = LanguageModelSession(instructions: """
                        You turn a list of today's calendar events into one short, friendly sentence that will be \
                        read out loud. Say how many things there are and mention the important ones with their \
                        times. Only use events from the list. No lists, no emoji, no markdown.
                        """)
                    let response = try await session.respond(to: prompt)
                    sentence = clean(response.content)
                } catch {
                    sentence = nil
                }
                let result = sentence
                DispatchQueue.main.async { then(result) }
            }
            return
        }
        #endif
        then(nil)
    }

    /// Trims the model's answer for speaking. Empty: nil.
    static func clean(_ text: String) -> String? {
        let stripped = text.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "#", with: "")
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxSentenceLength))
    }

    private static func time(_ date: Date?) -> String {
        guard let date = date else { return "some time" }
        return timeFormat.string(from: date)
    }
}

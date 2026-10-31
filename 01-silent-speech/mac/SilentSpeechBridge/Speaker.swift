// Speaks text with AVSpeechSynthesizer. It plays through the Mac's current sound output, so through the AirPods
// when they are connected and chosen as the output (SETUP.md step 5.1). Main queue only.
import AVFoundation
import Foundation

// The macOS 26 SDK makes AVSpeechSynthesizerDelegate imply Sendable. @unchecked is honest here: every stored
// property is only touched on the main queue (speak is called there, the delegate callbacks hop there).
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let synthesizer = AVSpeechSynthesizer()
    /// Utterances that are queued or speaking, with what to call when each one ends (true = spoken to the end).
    private var waiting: [(utterance: AVSpeechUtterance, then: (Bool) -> Void)] = []

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String, then: @escaping (Bool) -> Void) {
        let utterance = AVSpeechUtterance(string: text)
        waiting.append((utterance: utterance, then: then))
        synthesizer.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.ended(utterance, spoken: true) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.ended(utterance, spoken: false) }
    }

    private func ended(_ utterance: AVSpeechUtterance, spoken: Bool) {
        guard let index = waiting.firstIndex(where: { $0.utterance === utterance }) else { return }
        let entry = waiting.remove(at: index)
        entry.then(spoken)
    }
}

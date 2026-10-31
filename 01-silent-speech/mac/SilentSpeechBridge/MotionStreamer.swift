// Reads AirPods head motion with CMHeadphoneMotionManager (or simulates it) and hands every
// sample to `onSample`, one by one, as it arrives. PROTOCOL.md §2 `motion` and `status`.
import CoreMotion
import Foundation

final class MotionStreamer: NSObject, ObservableObject, CMHeadphoneMotionManagerDelegate {
    @Published private(set) var headphones: HeadphoneState = .disconnected
    @Published private(set) var auth: AuthState = .notDetermined
    @Published private(set) var loc: BudLocation = .unknown
    @Published private(set) var hz: Double = 0
    @Published private(set) var gapPct: Double = 0

    /// "Simulate motion": 50 Hz sine waves instead of the AirPods, so the WebSocket can be tested without them.
    @Published var simulate = false {
        didSet {
            if simulate != oldValue { simulateChanged() }
        }
    }

    /// Called on the main queue for every sample (real or simulated).
    var onSample: ((MotionMessage) -> Void)?
    /// Called on the main queue when headphones, auth, loc or simulate change.
    var onStateChange: (() -> Void)?

    static let simulateHz: Double = 50

    private let manager = CMHeadphoneMotionManager()
    private let motionQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "SilentSpeechBridge.motion"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private let log: LogStore
    private var seq = 0 // keeps counting across simulate on/off
    private var meter = RateMeter()
    private var statsTimer: Timer?
    private var simTimer: Timer?
    private var simStart: TimeInterval = 0
    private var heardFromDelegate = false
    private var lastErrorText = ""

    init(log: LogStore) {
        self.log = log
        super.init()
    }

    func start() {
        manager.delegate = self
        refreshAuth()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.refreshStats()
        }
        RunLoop.main.add(timer, forMode: .common)
        statsTimer = timer

        if manager.isDeviceMotionAvailable {
            startRealUpdates()
            log.add("Waiting for AirPods head motion")
        } else {
            setHeadphones(.unavailable)
            log.add("Head motion is not available on this Mac. Simulate motion still works.")
        }
    }

    // MARK: Real AirPods

    private func startRealUpdates() {
        manager.startDeviceMotionUpdates(to: motionQueue) { [weak self] motion, error in
            let arrival = ProcessInfo.processInfo.systemUptime
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let motion = motion {
                    self.handleReal(motion, arrival: arrival)
                } else if let error = error {
                    self.reportError(error)
                }
            }
        }
    }

    private func handleReal(_ m: CMDeviceMotion, arrival: TimeInterval) {
        // If the AirPods were already connected before we started, the delegate may never say so.
        if !heardFromDelegate && headphones != .connected {
            setHeadphones(.connected)
        }
        setLoc(MotionStreamer.budLocation(m.sensorLocation))
        if simulate { return } // Simulate mode ignores the real AirPods.

        let q = m.attitude.quaternion
        let rr = m.rotationRate
        let ua = m.userAcceleration
        let g = m.gravity
        emit(t: m.timestamp, arrival: arrival,
             q: [q.w, q.x, q.y, q.z],
             rr: [rr.x, rr.y, rr.z],
             ua: [ua.x, ua.y, ua.z],
             g: [g.x, g.y, g.z])
    }

    private func reportError(_ error: Error) {
        let text = error.localizedDescription
        if text != lastErrorText {
            lastErrorText = text
            log.add("Motion error: \(text)")
        }
    }

    // CMHeadphoneMotionManagerDelegate. The thread is not documented, so hop to main.
    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async {
            self.heardFromDelegate = true
            self.setHeadphones(.connected)
            if !self.manager.isDeviceMotionActive {
                self.startRealUpdates()
            }
        }
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async {
            self.heardFromDelegate = true
            self.setHeadphones(.disconnected)
            self.setLoc(.unknown)
        }
    }

    // MARK: Simulate motion

    private func simulateChanged() {
        simTimer?.invalidate()
        simTimer = nil
        if simulate {
            simStart = ProcessInfo.processInfo.systemUptime
            let timer = Timer(timeInterval: 1 / MotionStreamer.simulateHz, repeats: true) { [weak self] _ in
                self?.simTick()
            }
            RunLoop.main.add(timer, forMode: .common)
            simTimer = timer
            log.add("Simulate motion on (50 Hz sine waves)")
        } else {
            log.add("Simulate motion off (real AirPods)")
        }
        onStateChange?()
    }

    private func simTick() {
        // Same clock as CMLogItem.timestamp (seconds since boot).
        let now = ProcessInfo.processInfo.systemUptime
        let s = MotionStreamer.simulatedSample(at: now - simStart)
        emit(t: now, arrival: now, q: s.q, rr: s.rr, ua: s.ua, g: s.g)
    }

    private struct SimSample {
        let q: [Double]
        let rr: [Double]
        let ua: [Double]
        let g: [Double]
    }

    /// Slow head sway plus a 1.5 s burst of 4 Hz "jaw" wiggle every 4 s, so the charts move.
    private static func simulatedSample(at k: Double) -> SimSample {
        let twoPi: Double = 2 * Double.pi
        let pitch: Double = 0.03 * sin(twoPi * 0.15 * k)
        let roll: Double = 0.02 * sin(twoPi * 0.23 * k + 1)
        let yaw: Double = 0.04 * sin(twoPi * 0.11 * k + 2)
        let pitchRate: Double = 0.03 * twoPi * 0.15 * cos(twoPi * 0.15 * k)
        let rollRate: Double = 0.02 * twoPi * 0.23 * cos(twoPi * 0.23 * k + 1)
        let yawRate: Double = 0.04 * twoPi * 0.11 * cos(twoPi * 0.11 * k + 2)

        let phase: Double = k.truncatingRemainder(dividingBy: 4)
        let envelope: Double = phase < 1.5 ? sin(Double.pi * phase / 1.5) : 0
        let jaw: Double = envelope * sin(twoPi * 4 * phase)
        let jawAcc: Double = envelope * cos(twoPi * 4 * phase)

        let rr: [Double] = [pitchRate + 0.25 * jaw, rollRate + 0.08 * jaw, yawRate]
        let ua: [Double] = [0.003 * sin(twoPi * 1.7 * k), 0.012 * jaw, 0.02 * jawAcc]
        let g: [Double] = [sin(roll), -sin(pitch), -cos(pitch) * cos(roll)]
        return SimSample(q: eulerToQuaternion(pitch: pitch, roll: roll, yaw: yaw), rr: rr, ua: ua, g: g)
    }

    /// [w, x, y, z], same formula as web/src/core/synth.ts.
    private static func eulerToQuaternion(pitch: Double, roll: Double, yaw: Double) -> [Double] {
        let cy = cos(yaw / 2), sy = sin(yaw / 2)
        let cp = cos(pitch / 2), sp = sin(pitch / 2)
        let cr = cos(roll / 2), sr = sin(roll / 2)
        let w: Double = cr * cp * cy + sr * sp * sy
        let x: Double = sr * cp * cy - cr * sp * sy
        let y: Double = cr * sp * cy + sr * cp * sy
        let z: Double = cr * cp * sy - sr * sp * cy
        return [w, x, y, z]
    }

    // MARK: Shared

    private func emit(t: Double, arrival: TimeInterval, q: [Double], rr: [Double], ua: [Double], g: [Double]) {
        let msg = MotionMessage(seq: seq, t: r5(t), q: q.map(r5), rr: rr.map(r5), ua: ua.map(r5), g: g.map(r5))
        seq += 1
        meter.add(arrival: arrival, t: t)
        onSample?(msg)
    }

    private func refreshStats() {
        refreshAuth()
        // In case "available" was false at launch and changes later.
        if headphones == .unavailable && manager.isDeviceMotionAvailable {
            setHeadphones(.disconnected)
            startRealUpdates()
        }
        let stats = meter.stats(now: ProcessInfo.processInfo.systemUptime)
        hz = stats.hz
        gapPct = stats.gapPct
    }

    private func refreshAuth() {
        let newAuth = MotionStreamer.authState(CMHeadphoneMotionManager.authorizationStatus())
        if newAuth != auth {
            auth = newAuth
            log.add("Motion permission: \(newAuth.rawValue)")
            onStateChange?()
        }
    }

    private func setHeadphones(_ state: HeadphoneState) {
        guard state != headphones else { return }
        headphones = state
        log.add("Headphones: \(state.rawValue)")
        onStateChange?()
    }

    private func setLoc(_ newLoc: BudLocation) {
        guard newLoc != loc else { return }
        loc = newLoc
        onStateChange?()
    }

    static func authState(_ status: CMAuthorizationStatus) -> AuthState {
        switch status {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    static func budLocation(_ location: CMDeviceMotion.SensorLocation) -> BudLocation {
        switch location {
        case .default: return .default
        case .headphoneLeft: return .left
        case .headphoneRight: return .right
        @unknown default: return .unknown
        }
    }
}

/// hz = samples that arrived in the last 2 s / 2.
/// gapPct = % of sample intervals (by `t`) longer than 60 ms, over samples that arrived in the last 10 s.
struct RateMeter {
    private var arrivals: [TimeInterval] = []
    private var stamps: [TimeInterval] = []

    mutating func add(arrival: TimeInterval, t: TimeInterval) {
        arrivals.append(arrival)
        stamps.append(t)
        if arrivals.count > 5000 { prune(before: arrival - 10) } // bound memory if stats() is never called
    }

    mutating func stats(now: TimeInterval) -> (hz: Double, gapPct: Double) {
        prune(before: now - 10)
        let recent = arrivals.filter { $0 >= now - 2 }.count
        var gaps = 0
        if stamps.count >= 2 {
            for i in 1..<stamps.count where stamps[i] - stamps[i - 1] > 0.06 {
                gaps += 1
            }
        }
        let pct = stamps.count >= 2 ? 100 * Double(gaps) / Double(stamps.count - 1) : 0
        return (hz: r5(Double(recent) / 2), gapPct: r5(pct))
    }

    private mutating func prune(before cutoff: TimeInterval) {
        let drop = arrivals.firstIndex(where: { $0 >= cutoff }) ?? arrivals.count
        if drop > 0 {
            arrivals.removeFirst(drop)
            stamps.removeFirst(drop)
        }
    }
}

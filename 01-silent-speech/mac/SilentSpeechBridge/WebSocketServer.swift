// WebSocket server on ws://127.0.0.1:8765, PROTOCOL.md §2.
// Bound to 127.0.0.1 only, Origin allowlist, hello + status on connect, status every 1 s, motion per sample,
// actions need the pairing token (checked first) and are answered within 1 s. All Network.framework callbacks
// run on the main queue.
import Foundation
import Network

final class WebSocketServer: ObservableObject {
    @Published private(set) var clientCount = 0
    @Published private(set) var listening = false
    @Published private(set) var portStatus = "Starting..."

    /// Goes up on every Armed change, so a request that waits in the background can tell Armed was switched
    /// (even off and on again) and cancel itself.
    private(set) var armedGeneration = 0

    /// Off by default. Changes go out in `status` right away and in every later `hello`.
    @Published var armed = false {
        didSet {
            guard armed != oldValue else { return }
            armedGeneration += 1
            log.add(armed ? "Armed: actions from the paired dashboard will really run" : "Not armed: actions are dry runs")
            broadcastStatus()
        }
    }

    /// Dev only, off by default: lets clients without an Origin header (node, websocat) connect.
    @Published var allowNonBrowserClients = false {
        didSet {
            guard allowNonBrowserClients != oldValue else { return }
            log.add(allowNonBrowserClients ? "Non browser clients allowed (dev)" : "Non browser clients blocked")
        }
    }

    /// A dashboard that has this many frames waiting is not reading any more (about 10 s of motion).
    static let maxFramesInFlight = 500
    /// PROTOCOL §2: the Mac replies to every action within 1 s.
    static let replyDeadline: TimeInterval = 0.8
    /// While the port can't be opened, try again this often.
    static let retryInterval: TimeInterval = 2
    /// An approved handshake must turn into a ready connection within this time.
    static let approvalLifetime: TimeInterval = 5

    private final class Client {
        let connection: NWConnection
        var ready = false
        var closing = false
        var framesInFlight = 0
        init(connection: NWConnection) {
            self.connection = connection
        }
    }

    /// Set to true by whoever answers an action first: the runner or the 1 s watchdog.
    private final class ReplyFlag {
        var sent = false
    }

    private let motion: MotionStreamer
    private let runner: ActionRunner
    private let pairing: Pairing
    private let log: LogStore
    private let appVersion: String
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]
    private var lastRun: [String: TimeInterval] = [:] // per action, shared by all connections
    private var statusTimer: Timer?
    private var retryScheduled = false
    /// One entry per handshake the Origin check approved. Each ready connection uses one up;
    /// a connection that becomes ready without one is cancelled (fail closed).
    private var approvals: [TimeInterval] = []

    private static let loopbackV4 = IPv4Address("127.0.0.1")?.rawValue
    private static let loopbackV6 = IPv6Address("::1")?.rawValue
    private static let mappedLoopbackV4 = Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])

    init(motion: MotionStreamer, runner: ActionRunner, pairing: Pairing, log: LogStore) {
        self.motion = motion
        self.runner = runner
        self.pairing = pairing
        self.log = log
        self.appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    func start() {
        motion.onSample = { [weak self] sample in
            self?.broadcastMotion(sample)
        }
        motion.onStateChange = { [weak self] in
            self?.broadcastStatus()
        }
        if statusTimer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                self?.broadcastStatus()
            }
            RunLoop.main.add(timer, forMode: .common)
            statusTimer = timer
        }
        openListener()
    }

    /// For the Retry button. While the port can't be opened, the server also retries every 2 s by itself.
    func restart() {
        listener?.cancel()
        listener = nil
        openListener()
    }

    // MARK: Listener

    private func openListener() {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 64 * 1024
        ws.setClientRequestHandler(DispatchQueue.main) { [weak self] _, headers in
            let accept = self?.shouldAccept(headers: headers) ?? false
            let status: NWProtocolWebSocket.Response.Status = accept ? .accept : .reject
            return NWProtocolWebSocket.Response(status: status, subprotocol: nil)
        }

        guard let port = NWEndpoint.Port(rawValue: ProtocolV1.port) else { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredInterfaceType = .loopback
        // Bind to 127.0.0.1 only (not every interface), so nothing outside this Mac can even reach the port.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(IPv4Address.loopback), port: port)
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)

        let newListener: NWListener
        do {
            newListener = try NWListener(using: params)
        } catch {
            setListening(false, "Could not open port \(ProtocolV1.port): \(error). Retrying every 2 s.")
            scheduleRetry()
            return
        }
        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            guard let self = self, let current = newListener, self.listener === current else { return }
            self.listenerChanged(state)
        }
        newListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener = newListener
        setListening(false, "Opening port \(ProtocolV1.port)...")
        newListener.start(queue: DispatchQueue.main)
    }

    private func listenerChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            // Log the port we really got; anything but 8765 counts as a failure.
            let actual = listener?.port?.rawValue ?? 0
            guard actual == ProtocolV1.port else {
                setListening(false, "Opened port \(actual) instead of \(ProtocolV1.port). Retrying every 2 s.")
                listener?.cancel()
                listener = nil
                scheduleRetry()
                return
            }
            setListening(true, "Listening on ws://127.0.0.1:\(actual)")
        case .failed(let error):
            if case .posix(let code) = error, code == .EADDRINUSE {
                setListening(false, "Port \(ProtocolV1.port) is in use. Quit the other copy of the app. Retrying every 2 s.")
            } else {
                setListening(false, "Server stopped: \(error). Retrying every 2 s.")
            }
            listener?.cancel()
            listener = nil
            scheduleRetry()
        case .waiting(let error):
            setListening(false, "Waiting for port \(ProtocolV1.port): \(error)")
        case .cancelled:
            setListening(false, "Server stopped. Press Retry.")
        default:
            break
        }
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + WebSocketServer.retryInterval) { [weak self] in
            guard let self = self else { return }
            self.retryScheduled = false
            if self.listener == nil { self.openListener() }
        }
    }

    private func setListening(_ isListening: Bool, _ text: String) {
        if text != portStatus { log.add(text) }
        listening = isListening
        portStatus = text
    }

    // MARK: Security

    /// Runs during the WebSocket handshake. Records each approval so `.ready` can insist on one.
    private func shouldAccept(headers: [(name: String, value: String)]) -> Bool {
        let accept = originAllowed(headers: headers)
        if accept { approvals.append(ProcessInfo.processInfo.systemUptime) }
        return accept
    }

    /// Origin must be on the allowlist; no Origin only with the dev toggle on.
    private func originAllowed(headers: [(name: String, value: String)]) -> Bool {
        let originHeader = headers.first(where: { $0.name.lowercased() == "origin" })
        guard let header = originHeader else {
            if allowNonBrowserClients {
                log.add("Allowed a client with no Origin (dev toggle is on)")
                return true
            }
            log.add("Blocked a client with no Origin (dev toggle is off)")
            return false
        }
        let origin = header.value.trimmingCharacters(in: .whitespaces)
        if ProtocolV1.allowedOrigins.contains(origin) { return true }
        let shown = String(origin.unicodeScalars.filter { $0.value >= 0x21 && $0.value < 0x7f }.map(Character.init).prefix(80))
        log.add("Blocked a website: \(shown)")
        return false
    }

    /// Uses up one handshake approval (if there is a fresh one).
    private func takeApproval() -> Bool {
        let cutoff = ProcessInfo.processInfo.systemUptime - WebSocketServer.approvalLifetime
        approvals.removeAll(where: { $0 < cutoff })
        guard !approvals.isEmpty else { return false }
        approvals.removeFirst()
        return true
    }

    /// Belt and braces on top of the 127.0.0.1 bind and .loopback interface: only 127.0.0.1 and ::1.
    static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        if case .ipv4(let address) = host {
            return address.rawValue == loopbackV4
        }
        if case .ipv6(let address) = host {
            return address.rawValue == loopbackV6 || address.rawValue == mappedLoopbackV4
        }
        if case .name(let name, _) = host {
            return name == "127.0.0.1" || name == "::1"
        }
        return false
    }

    // MARK: Connections

    private func accept(_ connection: NWConnection) {
        guard WebSocketServer.isLoopback(connection.endpoint) else {
            log.add("Blocked a connection from \(connection.endpoint)")
            connection.cancel()
            return
        }
        let client = Client(connection: connection)
        clients[ObjectIdentifier(connection)] = client
        connection.stateUpdateHandler = { [weak self, weak client] state in
            guard let self = self, let client = client else { return }
            self.connectionChanged(client, state: state)
        }
        connection.start(queue: DispatchQueue.main)
    }

    private func connectionChanged(_ client: Client, state: NWConnection.State) {
        switch state {
        case .ready:
            guard !client.ready else { return }
            // Fail closed: only a handshake that went through the Origin check may become a client.
            guard takeApproval() else {
                log.add("Blocked a connection: handshake not checked")
                client.connection.cancel()
                return
            }
            client.ready = true
            updateClientCount()
            log.add("Dashboard connected (\(clientCount) open)")
            if let hello = ProtocolCoding.encode(makeHello()) {
                send(hello, to: client)
            }
            broadcastStatus()
            receive(on: client)
        case .failed(let error):
            if client.ready { log.add("Dashboard connection failed: \(error)") }
            client.connection.cancel()
            remove(client)
        case .waiting:
            client.connection.cancel()
        case .cancelled:
            remove(client)
        default:
            break
        }
    }

    private func remove(_ client: Client) {
        let key = ObjectIdentifier(client.connection)
        guard clients.removeValue(forKey: key) != nil else { return }
        client.connection.stateUpdateHandler = nil
        if client.ready {
            client.ready = false
            updateClientCount()
            log.add("Dashboard disconnected (\(clientCount) open)")
            broadcastStatus()
        }
    }

    private func updateClientCount() {
        clientCount = clients.values.filter { $0.ready }.count
    }

    private func receive(on client: Client) {
        client.connection.receiveMessage { [weak self, weak client] data, context, _, error in
            guard let self = self, let client = client else { return }
            if let error = error {
                if client.ready { self.log.add("Dashboard connection error: \(error)") }
                client.connection.cancel()
                return
            }
            let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if let meta = meta, meta.opcode == .close {
                self.replyToClose(client)
                return
            }
            if let data = data, !data.isEmpty, let meta = meta, meta.opcode == .text || meta.opcode == .binary {
                self.handleMessage(data, from: client)
            }
            if data == nil && (context?.isFinal == true || meta == nil) {
                client.connection.cancel() // nothing more will come: the other side is gone
                return
            }
            self.receive(on: client)
        }
    }

    /// The browser sent a close frame: answer with a close frame (RFC 6455 §5.5.1), then hang up.
    private func replyToClose(_ client: Client) {
        guard !client.closing else { return }
        client.closing = true
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = .protocolCode(.normalClosure)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        let connection = client.connection
        connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in
            connection.cancel()
        }))
        // In case the send never completes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            connection.cancel()
        }
    }

    // MARK: Messages from the browser

    private func handleMessage(_ data: Data, from client: Client) {
        // A valid JSON object whose type isn't "action" is ignored silently (PROTOCOL §2).
        if let object = try? JSONSerialization.jsonObject(with: data),
           let dict = object as? [String: Any],
           (dict["type"] as? String) != "action" {
            return
        }
        guard let text = String(data: data, encoding: .utf8),
              let request = ProtocolCoding.decodeRequest(text) else {
            sendError(.bad_json, "could not parse message", id: nil, to: client)
            return
        }
        // Pairing comes before anything else about the action (PROTOCOL §2). The token itself is never logged.
        guard pairing.matches(request.token) else {
            sendError(.unpaired, "wrong or missing pairing token: open the dashboard with the Mac app's link", id: request.id, to: client)
            log.add("Refused an unpaired action (\(logSafeName(request.action))): open the dashboard with this app's link")
            return
        }
        let action = request.action
        guard ActionRunner.actionKeys.contains(action) else {
            sendError(.unknown_action, "unknown action \(String(action.prefix(64)))", id: request.id, to: client)
            log.add("Unknown action: \(logSafeName(action))")
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        let cooldown = ProtocolV1.sensitiveActions.contains(action) ? ProtocolV1.sensitiveCooldown : ProtocolV1.actionCooldown
        if let last = lastRun[action], now - last < cooldown {
            sendError(.cooldown, "too soon", id: request.id, to: client)
            log.add("Cooldown: \(action) (wait \(Int(cooldown)) s between runs)")
            return
        }
        lastRun[action] = now
        runAction(request, for: client, started: now)
    }

    private func runAction(_ request: ActionRequest, for client: Client, started: TimeInterval) {
        let flag = ReplyFlag()
        let armedNow = armed
        // Watchdog: if the runner has not answered in time, say "Working on it" so we stay under 1 s.
        DispatchQueue.main.asyncAfter(deadline: .now() + WebSocketServer.replyDeadline) { [weak self, weak client] in
            guard let self = self, let client = client, !flag.sent else { return }
            flag.sent = true
            let working = ActionOutcome(ok: true, dryRun: !armedNow, message: "Working on it")
            self.sendResult(request, working, started: started, to: client)
        }
        runner.run(request.action, armed: armedNow) { [weak self, weak client] outcome in
            guard let self = self else { return }
            if flag.sent {
                self.log.add("\(request.action) finished: \(outcome.message)")
                return
            }
            flag.sent = true
            if let client = client {
                self.sendResult(request, outcome, started: started, to: client)
            }
        }
    }

    // MARK: Messages to the browser

    private func makeHello() -> HelloMessage {
        HelloMessage(version: appVersion, actions: ActionRunner.actionKeys, armed: armed)
    }

    private func makeStatus() -> StatusMessage {
        StatusMessage(
            headphones: motion.headphones,
            auth: motion.auth,
            loc: motion.loc,
            hz: motion.hz,
            gapPct: motion.gapPct,
            clients: clientCount,
            armed: armed,
            simulated: motion.simulate
        )
    }

    private func sendResult(_ request: ActionRequest, _ outcome: ActionOutcome, started: TimeInterval, to client: Client) {
        let ms = (ProcessInfo.processInfo.systemUptime - started) * 1000
        let msg = ActionResultMessage(
            id: request.id,
            action: request.action,
            ok: outcome.ok,
            dryRun: outcome.dryRun,
            message: outcome.message,
            error: outcome.error,
            ms: r5(ms)
        )
        if let text = ProtocolCoding.encode(msg) {
            send(text, to: client)
        }
    }

    private func sendError(_ code: ErrorCode, _ message: String, id: String?, to client: Client) {
        if let text = ProtocolCoding.encode(ErrorMessage(code: code, message: message, id: id)) {
            send(text, to: client)
        }
    }

    func broadcastStatus() {
        guard clientCount > 0, let text = ProtocolCoding.encode(makeStatus()) else { return }
        broadcast(text: text)
    }

    private func broadcastMotion(_ sample: MotionMessage) {
        guard clientCount > 0, let text = ProtocolCoding.encode(sample) else { return }
        broadcast(text: text)
    }

    func broadcast(text: String) {
        for client in clients.values where client.ready {
            send(text, to: client)
        }
    }

    private func send(_ text: String, to client: Client) {
        guard client.ready && !client.closing else { return }
        if client.framesInFlight > WebSocketServer.maxFramesInFlight {
            client.ready = false
            updateClientCount()
            log.add("Dropped a dashboard that stopped reading (\(clientCount) open)")
            client.connection.cancel()
            return
        }
        client.framesInFlight += 1
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [meta])
        client.connection.send(
            content: Data(text.utf8),
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed({ [weak client] _ in
                client?.framesInFlight -= 1
            })
        )
    }
}

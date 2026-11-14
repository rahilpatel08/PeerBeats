import AppKit
import Darwin
import Foundation

/// Runs `Start PeerBeats.command` from the PeerBeats folder and tracks the server it starts.
///
/// The launcher runs in a process group of its own. Stopping signals the whole group, so npm,
/// node and the phone link all stop together, and the app reports "Stopped" only once every one
/// of them has exited.
/// What the server reports about itself: who is connected, and the address phones use.
struct LiveStatus: Decodable, Equatable {
    struct Peer: Decodable, Equatable, Identifiable {
        let name: String
        let chunks: Int
        var id: String { name }
    }
    struct Listener: Decodable, Equatable, Identifiable {
        let name: String
        let trackTitle: String?
        let state: String
        var id: String { name }
    }
    struct Network: Decodable, Equatable {
        let totalChunks: Int
        let peers: [Peer]
        let listeners: [Listener]
    }
    /// The secure address phones use, wherever they are.
    struct Link: Decodable, Equatable {
        let state: String
        let error: String?
        let url: String?
    }
    let network: Network
    let link: Link
}

final class ServerController: ObservableObject {
    enum Phase: Equatable {
        case needsFolder
        case starting
        case running(port: Int)
        case stopping
        case stopped
        case failed(String)
    }

    @Published private(set) var phase: Phase = .stopped
    @Published private(set) var log = ""
    @Published private(set) var folder: URL?
    /// Nil until the running server has answered.
    @Published private(set) var live: LiveStatus?
    /// True when macOS refused the launcher access to the folder, which only the person can fix.
    @Published private(set) var blockedByPrivacy = false

    private static let folderKey = "projectFolder"
    private static let maxLines = 1500
    private static let launcherName = "Start PeerBeats.command"

    private var lines: [String] = []
    private var partialLine: [UInt8] = []
    /// The launcher's pid, which is also its process group id. 0 when nothing is running.
    private var groupID: pid_t = 0
    /// Each start gets a new number, so late callbacks from an earlier run are ignored.
    private var run = 0
    private var port: Int?
    private var stopRequested = false
    private var openLabWhenReady = false
    private var outputClosed = false
    private var exitStatus: Int32?
    private var outputHandle: FileHandle?
    private var healthTimer: Timer?
    private var statusTimer: Timer?
    private var awake: NSObjectProtocol?
    private var whenStopped: [() -> Void] = []

    var isRunning: Bool { groupID != 0 }

    var labURL: URL? {
        guard case .running(let port) = phase else { return nil }
        return URL(string: "http://localhost:\(port)/lab")
    }

    // MARK: Folder

    static func isProjectFolder(_ url: URL) -> Bool {
        let files = FileManager.default
        return files.isExecutableFile(atPath: url.appendingPathComponent(launcherName).path)
            && files.fileExists(atPath: url.appendingPathComponent("server/package.json").path)
    }

    /// Next to the app, then wherever it was last, then the folder the app was built from.
    private static func findFolder() -> URL? {
        var candidates = [Bundle.main.bundleURL.deletingLastPathComponent()]
        if let saved = UserDefaults.standard.string(forKey: folderKey) {
            candidates.append(URL(fileURLWithPath: saved))
        }
        if let built = Bundle.main.object(forInfoDictionaryKey: "PeerBeatsFolder") as? String, !built.isEmpty {
            candidates.append(URL(fileURLWithPath: built).standardizedFileURL)
        }
        return candidates.first(where: isProjectFolder)
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose the peerbeats folder, the one with \(Self.launcherName) in it."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard Self.isProjectFolder(url) else {
            if !isRunning { phase = .failed("\(url.lastPathComponent) doesn't have \(Self.launcherName) in it.") }
            return
        }
        remember(url)
        restart()
    }

    func revealFolder() {
        guard let folder else { return }
        NSWorkspace.shared.activateFileViewerSelecting([folder.appendingPathComponent(Self.launcherName)])
    }

    private func remember(_ url: URL) {
        folder = url
        UserDefaults.standard.set(url.path, forKey: Self.folderKey)
    }

    // MARK: Start and stop

    func startOnLaunch() {
        guard let found = Self.findFolder() else {
            phase = .needsFolder
            return
        }
        remember(found)
        openLabWhenReady = ProcessInfo.processInfo.environment["PEERBEATS_NO_OPEN"] == nil
        start()
    }

    func start() {
        guard groupID == 0 else { return }
        guard let folder, Self.isProjectFolder(folder) else {
            phase = .needsFolder
            return
        }
        run += 1
        lines.removeAll()
        partialLine.removeAll()
        log = ""
        port = nil
        stopRequested = false
        outputClosed = false
        exitStatus = nil
        blockedByPrivacy = false
        phase = .starting
        do {
            try spawnLauncher(folder.appendingPathComponent(Self.launcherName))
        } catch {
            phase = .failed("Could not run \(Self.launcherName): \(error.localizedDescription)")
        }
    }

    func stop(then done: (() -> Void)? = nil) {
        if let done { whenStopped.append(done) }
        guard groupID != 0 else {
            runWhenStopped()
            return
        }
        guard !stopRequested else { return }
        stopRequested = true
        phase = .stopping
        let group = groupID
        kill(-group, SIGTERM)
        // The server closes its database before it exits. Anything still running after 10 seconds is ended.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, self.groupID == group else { return }
            kill(-group, SIGKILL)
        }
    }

    func restart() {
        if isRunning {
            stop { [weak self] in self?.start() }
        } else {
            start()
        }
    }

    func openLab() {
        if let labURL {
            NSWorkspace.shared.open(labURL)
        } else {
            openLabWhenReady = true
            if !isRunning { start() }
        }
    }

    private func runWhenStopped() {
        let callbacks = whenStopped
        whenStopped = []
        callbacks.forEach { $0() }
    }

    // MARK: Launcher process

    private func spawnLauncher(_ script: URL) throws {
        var ends: [Int32] = [-1, -1]
        guard pipe(&ends) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let (readEnd, writeEnd) = (ends[0], ends[1])

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, writeEnd, 1)
        posix_spawn_file_actions_adddup2(&actions, writeEnd, 2)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // A new process group, default signal handling, and no open files from the app other than
        // stdin, stdout and stderr.
        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT
        posix_spawnattr_setflags(&attributes, Int16(flags))
        posix_spawnattr_setpgroup(&attributes, 0)
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        posix_spawnattr_setsigdefault(&attributes, &allSignals)
        var noSignals = sigset_t()
        sigemptyset(&noSignals)
        posix_spawnattr_setsigmask(&attributes, &noSignals)

        var environment = ProcessInfo.processInfo.environment
        // The app opens the Lab itself, once the server answers.
        environment["PEERBEATS_NO_OPEN"] = "1"
        environment["PEERBEATS_FROM_APP"] = "1"
        let arguments = ["/bin/bash", script.path]
        let variables = environment.map { "\($0.key)=\($0.value)" }

        var pid: pid_t = 0
        let result = withCStrings(arguments) { argv in
            withCStrings(variables) { envp in
                posix_spawn(&pid, "/bin/bash", &actions, &attributes, argv, envp)
            }
        }
        close(writeEnd)
        guard result == 0 else {
            close(readEnd)
            throw POSIXError(POSIXErrorCode(rawValue: result) ?? .EIO)
        }
        groupID = pid
        readOutput(from: readEnd, run: run)
        watchExit(of: pid, run: run)
    }

    private func readOutput(from descriptor: Int32, run: Int) {
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        handle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                guard let self, self.run == run else { return }
                if data.isEmpty {
                    self.outputClosed = true
                    self.finishIfDone(run: run)
                } else {
                    self.append(data)
                }
            }
        }
        outputHandle = handle
    }

    private func watchExit(of leader: pid_t, run: Int) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var status: Int32 = 0
            while waitpid(leader, &status, 0) == -1 && errno == EINTR {}
            // npm, tsx and node can outlive the script for a moment while the database closes.
            while kill(-leader, 0) == 0 { usleep(100_000) }
            DispatchQueue.main.async {
                guard let self, self.run == run else { return }
                self.exitStatus = status
                self.finishIfDone(run: run)
                // Output normally ends first. If something else still holds the pipe, don't wait for it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, self.run == run, self.groupID != 0 else { return }
                    self.outputClosed = true
                    self.finishIfDone(run: run)
                }
            }
        }
    }

    private func finishIfDone(run: Int) {
        guard run == self.run, groupID != 0, outputClosed, let status = exitStatus else { return }
        if !partialLine.isEmpty {
            addLine(String(decoding: partialLine, as: UTF8.self))
            partialLine.removeAll()
            publishLog()
        }
        groupID = 0
        outputHandle?.readabilityHandler = nil
        outputHandle = nil
        healthTimer?.invalidate()
        healthTimer = nil
        statusTimer?.invalidate()
        statusTimer = nil
        live = nil
        stayAwake(false)

        let signal = status & 0x7f
        let code = (status >> 8) & 0xff
        if stopRequested || (signal == 0 && code == 0) {
            phase = .stopped
        } else {
            let reason = signal != 0 ? "signal \(signal)" : "exit code \(code)"
            if lines.contains(where: { $0.contains("Operation not permitted") }) {
                blockedByPrivacy = true
                phase = .failed("macOS is blocking PeerBeats from its folder. In System Settings, open Privacy & Security, then Files and Folders, and allow PeerBeats. Then press Start.")
            } else {
                phase = .failed(lastMessage() ?? "PeerBeats stopped unexpectedly (\(reason)).")
            }
        }
        stopRequested = false
        runWhenStopped()
    }

    // MARK: Output

    private func append(_ data: Data) {
        partialLine.append(contentsOf: data)
        while let newline = partialLine.firstIndex(of: 0x0A) {
            addLine(String(decoding: partialLine[..<newline], as: UTF8.self))
            partialLine.removeSubrange(...newline)
        }
        publishLog()
    }

    private func addLine(_ raw: String) {
        let line = raw
            .replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
        lines.append(line)
        if lines.count > Self.maxLines { lines.removeFirst(lines.count - Self.maxLines) }

        // The launcher prints the Lab address once it knows which port it got.
        if port == nil,
           let match = line.range(of: #"http://localhost:(\d+)/lab"#, options: .regularExpression),
           let found = Int(line[match].dropFirst("http://localhost:".count).dropLast("/lab".count)) {
            port = found
            waitForServer(port: found, run: run)
        }
    }

    private func publishLog() {
        log = lines.joined(separator: "\n")
    }

    /// The launcher's last words, which say what went wrong when it fails.
    private func lastMessage() -> String? {
        lines.reversed()
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }

    // MARK: Health

    private func waitForServer(port: Int, run: Int) {
        guard let url = URL(string: "http://localhost:\(port)/api/health") else { return }
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            var request = URLRequest(url: url)
            request.timeoutInterval = 1
            URLSession.shared.dataTask(with: request) { data, response, _ in
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      body["app"] as? String == "peerbeats"
                else { return }
                DispatchQueue.main.async { self?.serverAnswered(port: port, run: run) }
            }.resume()
        }
    }

    private func serverAnswered(port: Int, run: Int) {
        guard run == self.run, phase == .starting else { return }
        healthTimer?.invalidate()
        healthTimer = nil
        phase = .running(port: port)
        stayAwake(true)
        watchStatus(port: port, run: run)
        if openLabWhenReady {
            openLabWhenReady = false
            openLab()
        }
    }

    /// Asks the server who is connected, every 2 seconds while it runs.
    private func watchStatus(port: Int, run: Int) {
        guard let url = URL(string: "http://localhost:\(port)/api/lab/status") else { return }
        let load = { [weak self] in
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            request.cachePolicy = .reloadIgnoringLocalCacheData
            URLSession.shared.dataTask(with: request) { data, _, _ in
                guard let data, let status = try? JSONDecoder().decode(LiveStatus.self, from: data) else { return }
                DispatchQueue.main.async {
                    guard let self, self.run == run, case .running = self.phase else { return }
                    if self.live != status { self.live = status }
                }
            }.resume()
        }
        load()
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in load() }
    }

    func openPrivacySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Keeps the Mac from sleeping on its own while it serves music. Closing the lid still sleeps it.
    private func stayAwake(_ on: Bool) {
        if on, awake == nil {
            awake = ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled, .suddenTerminationDisabled, .automaticTerminationDisabled],
                reason: "PeerBeats is serving music"
            )
        } else if !on, let activity = awake {
            ProcessInfo.processInfo.endActivity(activity)
            awake = nil
        }
    }
}

private func withCStrings<Result>(
    _ strings: [String],
    _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> Result
) -> Result {
    var pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
    pointers.append(nil)
    defer { pointers.forEach { free($0) } }
    return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
}

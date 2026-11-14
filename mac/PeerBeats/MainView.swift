import CoreImage.CIFilterBuiltins
import SwiftUI

struct MainView: View {
    @ObservedObject var server: ServerController
    @State private var showLog = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("PeerBeats").font(.title2.weight(.bold))
                Spacer()
                Text(status).font(.callout.monospaced()).foregroundStyle(statusColor)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            HStack(spacing: 8) {
                Button("Open Lab") { server.openLab() }
                    .keyboardShortcut("l")
                    .disabled(server.phase == .needsFolder || server.phase == .stopping)
                if server.isRunning {
                    Button("Stop") { server.stop() }
                        .disabled(server.phase == .stopping)
                } else {
                    Button("Start") { server.start() }
                        .disabled(server.phase == .needsFolder)
                }
                Button("Restart") { server.restart() }
                    .disabled(!server.isRunning || server.phase == .stopping)
                Spacer()
                Button("Choose Folder…") { server.chooseFolder() }
                Button("Show in Finder") { server.revealFolder() }
                    .disabled(server.folder == nil)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            if let problem {
                HStack(alignment: .firstTextBaseline) {
                    Text(problem)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if server.blockedByPrivacy {
                        Button("Open Privacy Settings") { server.openPrivacySettings() }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            }

            Divider()

            if case .running = server.phase, let live = server.live {
                LivePanel(live: live)
                Divider()
                Button {
                    showLog.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: showLog ? "chevron.down" : "chevron.right").font(.caption2)
                        Text("Log").font(.caption)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 5)
                if showLog {
                    Divider()
                    LogView(text: server.log).frame(height: 150)
                }
            } else {
                LogView(text: server.log)
            }

            Divider()

            HStack {
                Text(server.folder?.path ?? "No folder")
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text("Quitting stops the server")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .frame(minWidth: 640, minHeight: 440)
    }

    private var status: String {
        switch server.phase {
        case .needsFolder: return "No folder"
        case .starting: return "Starting"
        case .running(let port): return "Running, port \(port)"
        case .stopping: return "Stopping"
        case .stopped: return "Stopped"
        case .failed: return "Stopped with an error"
        }
    }

    private var statusColor: Color {
        switch server.phase {
        case .running: return .accentColor
        case .failed, .needsFolder: return .red
        default: return .secondary
        }
    }

    private var problem: String? {
        switch server.phase {
        case .needsFolder:
            return "Can't find the peerbeats folder. Press Choose Folder and pick the one with Start PeerBeats.command in it."
        case .failed(let message):
            return message
        default:
            return nil
        }
    }
}

/// The code a phone scans, beside who is connected right now.
private struct LivePanel: View {
    let live: LiveStatus
    /// The link that was last copied, so the button can say so until the link changes.
    @State private var copied: String?

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Phones").font(.headline)
                if let link = live.link.url, let code = qrCode(link + "/") {
                    Image(nsImage: code)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 176, height: 176)
                        .padding(8)
                        .background(Color.white)
                        .accessibilityLabel("QR code that opens PeerBeats on a phone")
                    Text("Scan with a phone's camera, or send the link. It works anywhere, on Wi-Fi or mobile data.")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(link)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button(copied == link ? "Copied" : "Copy Link") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link + "/", forType: .string)
                        copied = link
                    }
                } else if live.link.state == "starting" {
                    Text("Getting a secure link for phones, about 10 seconds")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if live.link.state == "off" {
                    Text("The phone link is off. Turn it on in the Lab.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text((live.link.error ?? "The phone link isn't working.") + " PeerBeats keeps trying. Check this Mac has internet.")
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .frame(width: 208, alignment: .leading)
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PeopleTable(
                        title: "Contributors",
                        count: "\(live.network.peers.count) online",
                        empty: "None yet. Music plays only while a contributor is online.",
                        rows: live.network.peers.map { ($0.name, "\($0.chunks) of \(live.network.totalChunks) segments") }
                    )
                    PeopleTable(
                        title: "Listeners",
                        count: "\(live.network.listeners.filter { $0.state == "playing" }.count) playing",
                        empty: "None yet.",
                        rows: live.network.listeners.map { ($0.name, describe($0)) }
                    )
                }
                .padding(16)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func describe(_ listener: LiveStatus.Listener) -> String {
        let track = listener.trackTitle ?? "a track"
        switch listener.state {
        case "playing": return "Playing \(track)"
        case "paused": return "Paused, \(track)"
        default: return "Waiting for a contributor, \(track)"
        }
    }

    private func qrCode(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

private struct PeopleTable: View {
    let title: String
    let count: String
    let empty: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer()
                Text(count).font(.callout.monospaced()).foregroundStyle(.secondary)
            }
            .padding(.bottom, 4)
            Divider()
            if rows.isEmpty {
                Text(empty)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline) {
                    Text(row.0)
                    Spacer()
                    Text(row.1).font(.callout.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 5)
                Divider()
            }
        }
    }
}

private struct LogView: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                Color.clear.frame(height: 1).id("end")
            }
            .onChange(of: text) {
                proxy.scrollTo("end", anchor: .bottom)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}

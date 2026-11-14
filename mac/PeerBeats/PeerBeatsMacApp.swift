import AppKit
import SwiftUI

@main
struct PeerBeatsMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("PeerBeats", id: "main") {
            MainView(server: delegate.server)
        }
        .defaultSize(width: 720, height: 520)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Server") {
                Button("Open Lab") { delegate.server.openLab() }
                    .keyboardShortcut("l")
                Button("Restart") { delegate.server.restart() }
                    .keyboardShortcut("r")
                Divider()
                Button("Choose PeerBeats Folder…") { delegate.server.chooseFolder() }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let server = ServerController()
    private var terminateSignal: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second copy would stop the first one's server to take its port. Show the first instead.
        let me = NSRunningApplication.current
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
        if let running = others.first(where: { $0.processIdentifier != me.processIdentifier }) {
            running.activate()
            NSApp.terminate(nil)
            return
        }

        // A plain `kill` would otherwise end the app and leave the server running without it.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            // Not directly: terminate waits for the server in a nested run loop, and main-queue
            // work, including the "server stopped" reply, can't run while this block is on the stack.
            RunLoop.main.perform { NSApp.terminate(nil) }
        }
        source.resume()
        terminateSignal = source

        server.startOnLaunch()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.isRunning else { return .terminateNow }
        server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

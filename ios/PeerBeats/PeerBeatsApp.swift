import AVFoundation
import SwiftUI

@main
struct PeerBeatsApp: App {
    init() {
        // Music plays even with the silent switch on, as in any music app.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// Shows the connect screen until a PeerBeats server has been confirmed, then the app itself.
struct RootView: View {
    @AppStorage("server") private var savedServer = ""
    @State private var connected: URL?
    /// Once the person taps Server, stay on the connect screen instead of reconnecting.
    @State private var leftOnPurpose = false

    var body: some View {
        if let connected {
            WebScreen(server: connected) {
                leftOnPurpose = true
                self.connected = nil
            }
        } else {
            ConnectView(saved: savedServer, reconnect: !leftOnPurpose) { url in
                savedServer = url.absoluteString
                connected = url
            }
        }
    }
}

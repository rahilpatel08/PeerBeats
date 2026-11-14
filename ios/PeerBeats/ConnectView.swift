import SwiftUI

struct ConnectView: View {
    let saved: String
    /// On launch, go straight back to the last server if it still answers.
    let reconnect: Bool
    let onConnect: (URL) -> Void

    @State private var address = ""
    @State private var checking = false
    @State private var problem: String?
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://...trycloudflare.com", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { connect(address) }
                    Button("Scan QR code") { scanning = true }
                    Button(checking ? "Checking" : "Connect") { connect(address) }
                        .disabled(checking || address.isEmpty)
                } header: {
                    Text("Server")
                } footer: {
                    Text("Scan the code in the PeerBeats app on the Mac, or paste the link. It works anywhere, on Wi-Fi or mobile data.")
                }
                if let problem {
                    Section {
                        Text(problem).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("PeerBeats")
            .sheet(isPresented: $scanning) {
                QRScannerSheet { code in
                    scanning = false
                    address = code
                    connect(code)
                }
            }
            .onAppear {
                if address.isEmpty { address = saved }
                if reconnect && !saved.isEmpty && !checking { connect(saved) }
            }
        }
    }

    private func connect(_ text: String) {
        guard let url = ServerAddress.normalise(text) else {
            problem = "That isn't a web address."
            return
        }
        checking = true
        problem = nil
        Task {
            do {
                try await checkServer(url)
                onConnect(url)
            } catch {
                problem = error.localizedDescription
            }
            checking = false
        }
    }
}

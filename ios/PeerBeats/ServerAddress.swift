import Foundation

enum ServerAddress {
    /// Accepts what people actually paste or scan: a bare host name, a full address, or the
    /// link in the Lab page's QR code. Keeps only the scheme, host and port.
    static func normalise(_ text: String) -> URL? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        guard var parts = URLComponents(string: raw),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parts.host, !host.isEmpty
        else { return nil }
        parts.scheme = scheme
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        parts.user = nil
        parts.password = nil
        return parts.url
    }

    /// Checking hashes and decrypting music only works on a secure page: HTTPS, or this device.
    static func isSecure(_ url: URL) -> Bool {
        url.scheme == "https" || ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")
    }
}

enum ServerCheckError: LocalizedError {
    case insecure(String)
    case unreachable(String)
    case notPeerBeats(String)

    var errorDescription: String? {
        switch self {
        case .insecure(let address):
            return "\(address) isn't secure. Use the PeerBeats link: scan the code in the PeerBeats app on the Mac, or paste the link."
        case .unreachable(let address):
            return "Can't reach \(address). The link changes each time PeerBeats starts on the Mac, so scan the new code or paste the new link."
        case .notPeerBeats(let address):
            return "\(address) isn't a PeerBeats server."
        }
    }
}

private struct Health: Decodable {
    let app: String
}

/// Confirms the address really is a PeerBeats server before opening it.
func checkServer(_ url: URL) async throws {
    let shown = url.absoluteString
    guard ServerAddress.isSecure(url) else { throw ServerCheckError.insecure(shown) }
    var request = URLRequest(url: url.appending(path: "api/health"))
    request.timeoutInterval = 10
    let data: Data
    let response: URLResponse
    do {
        (data, response) = try await URLSession.shared.data(for: request)
    } catch {
        throw ServerCheckError.unreachable(shown)
    }
    guard (response as? HTTPURLResponse)?.statusCode == 200,
          let health = try? JSONDecoder().decode(Health.self, from: data),
          health.app == "peerbeats"
    else { throw ServerCheckError.notPeerBeats(shown) }
}

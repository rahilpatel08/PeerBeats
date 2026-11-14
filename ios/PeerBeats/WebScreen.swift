import SafariServices
import SwiftUI
import UIKit
import WebKit

/// PeerBeats itself, with a thin bar for changing server. The screen stays on while this shows,
/// because a phone that locks stops sharing.
struct WebScreen: View {
    let server: URL
    let onLeave: () -> Void

    @State private var canStream = true
    @State private var loadProblem: String?
    @State private var showSafari = false
    @State private var reloadCount = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button("Server", action: onLeave)
                Text(server.host ?? "")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity)
                Button("Reload") { reloadCount += 1 }
            }
            .font(.subheadline)
            .padding(.horizontal)
            .padding(.vertical, 6)
            Divider()

            if !canStream {
                HStack(alignment: .top) {
                    Text("This iPhone can't play music inside the app. Sharing works here. To listen, use Safari.")
                        .font(.caption)
                    Spacer()
                    Button("Open") { showSafari = true }.font(.caption.bold())
                }
                .padding(8)
                .background(Color.yellow.opacity(0.2))
            }

            ZStack {
                WebView(start: server, reloadCount: reloadCount, canStream: $canStream, loadProblem: $loadProblem)
                if let loadProblem {
                    VStack(spacing: 12) {
                        Text("Can't load PeerBeats").font(.headline)
                        Text(loadProblem).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        HStack(spacing: 24) {
                            Button("Try again") { reloadCount += 1 }
                            Button("Change server", action: onLeave)
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            }
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sheet(isPresented: $showSafari) {
            SafariView(url: server).ignoresSafeArea()
        }
    }
}

struct WebView: UIViewRepresentable {
    let start: URL
    let reloadCount: Int
    @Binding var canStream: Bool
    @Binding var loadProblem: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Kept between launches, so the login and stored music survive closing the app.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Lets the site know the app keeps the screen on, which the browser can't promise.
        config.applicationNameForUserAgent = "PeerBeatsApp/1.0"

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) {
            // Allows Safari's Web Inspector on a Mac to look inside, for fixing problems.
            web.isInspectable = true
        }
        context.coordinator.lastReload = reloadCount
        web.load(URLRequest(url: start))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if reloadCount != context.coordinator.lastReload {
            context.coordinator.lastReload = reloadCount
            loadProblem = nil
            if web.url == nil { web.load(URLRequest(url: start)) } else { web.reload() }
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebView
        var lastReload = 0

        init(_ parent: WebView) {
            self.parent = parent
        }

        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            // Payment apps, such as UPI, open outside the app, as they would from Safari.
            if !["http", "https", "about", "blob", "data"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loadProblem = nil
            web.evaluateJavaScript("Boolean(window.ManagedMediaSource || window.MediaSource)") { [weak self] result, _ in
                if let supported = result as? Bool { self?.parent.canStream = supported }
            }
        }

        func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let nsError = error as NSError
            // A cancelled load is a new navigation replacing it, not a failure.
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            parent.loadProblem = error.localizedDescription
        }

        func webViewWebContentProcessDidTerminate(_ web: WKWebView) {
            // iOS can end a page that uses too much memory. Start it again rather than show a blank screen.
            web.reload()
        }

        /// Pages that ask for a new window open in this one instead.
        func webView(_ web: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.targetFrame == nil, let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                web.load(URLRequest(url: url))
            }
            return nil
        }

        func webView(_ web: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(message, cancellable: false) { _ in completionHandler() }
        }

        func webView(_ web: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(message, cancellable: true, completion: completionHandler)
        }

        private func present(_ message: String, cancellable: Bool, completion: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            if cancellable {
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(false) })
            }
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completion(true) })
            guard let top = Self.topController() else {
                completion(false)
                return
            }
            top.present(alert, animated: true)
        }

        private static func topController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            while let next = top?.presentedViewController { top = next }
            return top
        }
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

import AVFoundation
import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = KikiBridgeViewController()
        window?.makeKeyAndVisible()

        if let url = connectionOptions.urlContexts.first?.url {
            KikiShellPlugin.capturePairURL(url)
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url, KikiShellPlugin.capturePairURL(url) {
            return
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// The bridge with the Kiki shell plugin and the edge-swipe back gesture:
/// on iOS the page's own history (one entry per open layer) is the back stack.
class KikiBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(KikiShellPlugin())
        webView?.allowsBackForwardNavigationGestures = true
    }
}

/// Same contract as the Android `KikiShellPlugin`: the bundled launcher pairs or
/// opens one Kiki server; that origin stays inside the app, every other site goes
/// to Safari (Capacitor's default policy), and per-computer bearer tokens stay in
/// native storage.
@objc(KikiShellPlugin)
public class KikiShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikiShellPlugin"
    public let jsName = "KikiShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingPair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimPair", returnType: CAPPluginReturnPromise)
    ]

    private static let trustedOriginKey = "kiki.shell.trustedOrigin"
    private static let tokenPrefix = "kiki.shell.peerToken."
    private static var pendingPairUri: String?

    @discardableResult
    static func capturePairURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "kiki" else { return false }
        pendingPairUri = url.absoluteString
        return true
    }

    @objc func scanQr(_ call: CAPPluginCall) {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            call.resolve(["status": "granted"])
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                call.resolve(["status": granted ? "granted" : "denied"])
            }
        default:
            call.resolve(["status": "denied"])
        }
    }

    @objc func consumePendingPair(_ call: CAPPluginCall) {
        let uri = Self.pendingPairUri
        Self.pendingPairUri = nil
        if let uri {
            call.resolve(["uri": uri])
        } else {
            call.resolve([:])
        }
    }

    @objc func probe(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"),
              let originURL = URL(string: origin),
              let normalized = Self.origin(of: originURL),
              let handshakeURL = URL(string: "\(normalized)/api/remote-connections/handshake") else {
            call.resolve(["ok": false])
            return
        }
        var req = URLRequest(url: handshakeURL)
        req.timeoutInterval = 3.5
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                var out: [String: Any] = ["ok": true]
                if let data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let payload = json["data"] as? [String: Any] {
                    if let label = payload["targetLabel"] as? String { out["targetLabel"] = label }
                    let identityObj = (payload["identity"] as? [String: Any]) ?? (payload["target"] as? [String: Any])
                    if let homeId = identityObj?["homeId"] as? String { out["targetHomeId"] = homeId }
                }
                call.resolve(out)
                return
            }
            guard let metaURL = URL(string: "\(normalized)/api/meta") else {
                call.resolve(["ok": false])
                return
            }
            var metaReq = URLRequest(url: metaURL)
            metaReq.timeoutInterval = 3.5
            URLSession.shared.dataTask(with: metaReq) { _, metaRes, _ in
                let ok = (metaRes as? HTTPURLResponse)?.statusCode ?? 0 > 0
                call.resolve(["ok": ok])
            }.resume()
        }.resume()
    }

    @objc func claimPair(_ call: CAPPluginCall) {
        guard let endpoint = call.getString("endpoint"),
              let code = call.getString("code"), !code.isEmpty,
              let homeId = call.getString("homeId"), !homeId.isEmpty,
              let hostId = call.getString("hostId"), !hostId.isEmpty,
              let endpointURL = URL(string: endpoint),
              let base = Self.origin(of: endpointURL),
              let claimURL = URL(string: "\(base)/api/remote-connections/pair/claim") else {
            call.resolve(["ok": false, "reason": "rejected"])
            return
        }
        let sourceLabel = call.getString("sourceLabel") ?? "Kiki iOS"
        let body: [String: Any] = [
            "code": code,
            "source": [
                "homeId": homeId,
                "hostId": hostId,
                "protocol": 1
            ],
            "sourceLabel": sourceLabel,
            "requestBridge": false
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            call.resolve(["ok": false, "reason": "rejected"])
            return
        }
        var req = URLRequest(url: claimURL)
        req.httpMethod = "POST"
        req.timeoutInterval = 5.0
        req.httpBody = payload
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse else {
                call.resolve(["ok": false, "reason": "unreachable"])
                return
            }
            guard (200..<300).contains(http.statusCode),
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let inner = json["data"] as? [String: Any],
                  let peerToken = inner["peerToken"] as? String, !peerToken.isEmpty,
                  let target = inner["target"] as? [String: Any],
                  let targetHomeId = target["homeId"] as? String, !targetHomeId.isEmpty else {
                let reason = (400..<500).contains(http.statusCode) ? "rejected" : "unreachable"
                call.resolve(["ok": false, "reason": reason])
                return
            }
            UserDefaults.standard.set(peerToken, forKey: Self.tokenPrefix + targetHomeId)
            call.resolve([
                "ok": true,
                "serverId": targetHomeId,
                "targetHomeId": targetHomeId,
                "targetHostId": (target["hostId"] as? String) ?? "",
                "targetLabel": (inner["targetLabel"] as? String) ?? "",
                "grantId": (inner["grantId"] as? String) ?? "",
                "revision": (inner["revision"] as? Int) ?? 0
            ])
        }.resume()
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), let entry = call.getString("entry"),
              let originURL = URL(string: origin), let entryURL = URL(string: entry),
              let normalized = Self.origin(of: originURL), normalized == origin,
              Self.origin(of: entryURL) == origin else {
            call.reject("invalid_origin")
            return
        }
        let serverId = call.getString("serverId")
        let targetString = Self.attachStoredTokenIfNeeded(origin: origin, entry: entry, serverId: serverId)
        guard let finalURL = URL(string: targetString) else {
            call.reject("invalid_origin")
            return
        }
        UserDefaults.standard.set(origin, forKey: Self.trustedOriginKey)
        DispatchQueue.main.async { [weak self] in
            self?.webView?.load(URLRequest(url: finalURL))
            call.resolve(["origin": origin])
        }
    }

    private static func attachStoredTokenIfNeeded(origin: String, entry: String, serverId: String?) -> String {
        guard let serverId, !serverId.isEmpty else { return entry }
        if entry.contains("#access=") || entry.contains("&access=") || entry.contains("token=") {
            return entry
        }
        guard let token = UserDefaults.standard.string(forKey: tokenPrefix + serverId), !token.isEmpty else {
            return entry
        }
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        return "\(origin)/#token=\(encoded)"
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        if let local = bridge?.config.appStartServerURL,
           url.absoluteString.hasPrefix(local.absoluteString) {
            return false
        }
        guard let trusted = UserDefaults.standard.string(forKey: Self.trustedOriginKey),
              Self.origin(of: url) == trusted else {
            return nil
        }
        return false
    }

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty, url.user == nil, url.password == nil else {
            return nil
        }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        if let port = url.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
            return "\(scheme)://\(shownHost):\(port)"
        }
        return "\(scheme)://\(shownHost)"
    }
}

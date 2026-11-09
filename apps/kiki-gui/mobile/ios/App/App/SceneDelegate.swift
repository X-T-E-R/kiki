import AVFoundation
import Security
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
            (window?.rootViewController as? KikiBridgeViewController)?.navigateToPendingPair()
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
    private var shellPlugin: KikiShellPlugin?

    override func capacitorDidLoad() {
        let plugin = KikiShellPlugin()
        shellPlugin = plugin
        bridge?.registerPluginInstance(plugin)
        webView?.allowsBackForwardNavigationGestures = true
    }

    func navigateToPendingPair() {
        shellPlugin?.navigateToPendingPair()
    }
}

/// Same contract as the Android `KikiShellPlugin`: the bundled launcher pairs or
/// opens one Kiki server; that origin stays inside the app, every other site goes
/// to Safari (Capacitor's default policy), per-computer bearer tokens live in the
/// iOS Keychain, and only origins established via the pairing claim receive
/// credentials.
@objc(KikiShellPlugin)
public class KikiShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikiShellPlugin"
    public let jsName = "KikiShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingPair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimPair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetServer", returnType: CAPPluginReturnPromise)
    ]

    private final class NoRedirectSessionDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private static let noRedirectSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5.0
        config.timeoutIntervalForResource = 6.0
        return URLSession(configuration: config, delegate: NoRedirectSessionDelegate(), delegateQueue: nil)
    }()

    private static let trustedOriginKey = "kiki.shell.trustedOrigin"
    private static let tokenService = "ai.easyagent.kiki.peerToken"
    private static let legacyTokenPrefix = "kiki.shell.peerToken."
    private static let hostIdPrefix = "kiki.shell.peerHostId."
    private static let verifiedOriginsPrefix = "kiki.shell.verifiedOrigins."
    private static var pendingPairUri: String?

    private var pendingAuthOrigin: String?
    private var pendingAuthServerId: String?
    private var activeAuthOrigin: String?
    private var activeAuthServerId: String?
    private var pendingAuthEpoch: Int64 = 0
    private var documentNavEpoch: Int64 = 0
    private var currentDocumentNavNonce: String?
    private var urlObservation: NSKeyValueObservation?
    private var loadingObservation: NSKeyValueObservation?

    public override func load() {
        super.load()
        urlObservation = webView?.observe(\.url, options: [.new]) { [weak self] _, _ in
            self?.handleWebViewNavigationState(finalize: false)
        }
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            if webView.isLoading {
                self?.handleWebViewNavigationState(finalize: false)
            } else {
                self?.handleWebViewNavigationState(finalize: true)
            }
        }
    }

    @discardableResult
    static func capturePairURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "kiki" else { return false }
        let host = url.host?.lowercased() ?? ""
        let path = url.path.lowercased()
        guard (host == "pair" && (path.isEmpty || path == "/")) || (host.isEmpty && path == "/pair") else {
            return false
        }
        pendingPairUri = url.absoluteString
        return true
    }

    func navigateToPendingPair() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.clearPendingAuth()
            self.clearActiveAuth()
            let base = self.bridge?.config.appStartServerURL.absoluteString ?? "capacitor://localhost"
            guard let pairURL = URL(string: "\(base)/index.html#pair") else { return }
            self.webView?.load(URLRequest(url: pairURL))
        }
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
              let normalized = Self.origin(of: originURL) else {
            call.resolve(["ok": false])
            return
        }
        Self.fetchHandshake(origin: normalized) { ok, redirected, homeId, hostId, label in
            if redirected {
                call.resolve(["ok": false])
                return
            }
            if ok {
                var out: [String: Any] = ["ok": true]
                if let label, !label.isEmpty { out["targetLabel"] = label }
                if let homeId, !homeId.isEmpty { out["targetHomeId"] = homeId }
                if let hostId, !hostId.isEmpty { out["targetHostId"] = hostId }
                call.resolve(out)
                return
            }
            guard let metaURL = URL(string: "\(normalized)/api/meta") else {
                call.resolve(["ok": false])
                return
            }
            var metaReq = URLRequest(url: metaURL)
            metaReq.timeoutInterval = 3.5
            Self.noRedirectSession.dataTask(with: metaReq) { _, metaRes, _ in
                let status = (metaRes as? HTTPURLResponse)?.statusCode ?? 0
                let metaOk = (200..<300).contains(status) || status == 401 || status == 403
                call.resolve(["ok": metaOk])
            }.resume()
        }
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
        Self.noRedirectSession.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse else {
                call.resolve(["ok": false, "reason": "unreachable"])
                return
            }
            if (300..<400).contains(http.statusCode) {
                call.resolve(["ok": false, "reason": "rejected"])
                return
            }
            if let finalURL = http.url, Self.origin(of: finalURL) != base {
                call.resolve(["ok": false, "reason": "rejected"])
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
            let targetHostId = (target["hostId"] as? String) ?? ""
            guard Self.savePeerToken(peerToken, for: targetHomeId, origin: base) else {
                call.resolve(["ok": false, "reason": "unreachable"])
                return
            }
            Self.recordVerifiedOrigin(origin: base, for: targetHomeId, hostId: targetHostId)
            call.resolve([
                "ok": true,
                "serverId": targetHomeId,
                "targetHomeId": targetHomeId,
                "targetHostId": targetHostId,
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
        guard let serverId, !serverId.isEmpty else {
            UserDefaults.standard.set(origin, forKey: Self.trustedOriginKey)
            DispatchQueue.main.async { [weak self] in
                self?.clearPendingAuth()
                self?.clearActiveAuth()
                self?.webView?.load(URLRequest(url: entryURL))
                call.resolve(["ok": true, "origin": origin])
            }
            return
        }
        guard Self.isOriginVerified(origin: origin, for: serverId),
              Self.hasStoredToken(for: serverId, origin: origin) else {
            DispatchQueue.main.async { [weak self] in
                self?.clearPendingAuth()
                self?.clearActiveAuth()
            }
            call.resolve([
                "ok": false,
                "reason": "pairing_required"
            ])
            return
        }
        let cleanString = Self.stripTokenFromEntry(origin: origin, entry: entry)
        guard let cleanURL = URL(string: cleanString) else {
            call.reject("invalid_origin")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingAuthEpoch += 1
            let callEpoch = self.pendingAuthEpoch
            Self.fetchHandshake(origin: origin) { [weak self] ok, redirected, homeId, hostId, _ in
                guard !redirected, ok, let homeId, !homeId.isEmpty else {
                    DispatchQueue.main.async {
                        self?.clearPendingAuthIfCurrent(epoch: callEpoch)
                    }
                    call.resolve([
                        "ok": false,
                        "reason": "unreachable"
                    ])
                    return
                }
                guard homeId == serverId, Self.matchesStoredHostId(serverId: serverId, candidateHostId: hostId) else {
                    DispatchQueue.main.async {
                        self?.clearPendingAuthIfCurrent(epoch: callEpoch)
                    }
                    call.resolve([
                        "ok": false,
                        "reason": "identity_mismatch",
                        "targetHomeId": homeId
                    ])
                    return
                }
                Self.recordVerifiedOrigin(origin: origin, for: serverId, hostId: hostId)
                UserDefaults.standard.set(origin, forKey: Self.trustedOriginKey)
                DispatchQueue.main.async {
                    guard let self, self.pendingAuthEpoch == callEpoch else { return }
                    self.pendingAuthOrigin = origin
                    self.pendingAuthServerId = serverId
                    self.activeAuthOrigin = origin
                    self.activeAuthServerId = serverId
                    self.webView?.load(URLRequest(url: cleanURL))
                    call.resolve(["ok": true, "origin": origin])
                }
            }
        }
    }

    @objc func forgetServer(_ call: CAPPluginCall) {
        let serverId = call.getString("serverId")
        let origin = call.getString("origin")
        clearPendingAuth()
        clearActiveAuth()
        Self.forgetServerData(serverId: serverId, origin: origin)
        call.resolve(["ok": true])
    }

    private func clearPendingAuth() {
        pendingAuthEpoch += 1
        documentNavEpoch += 1
        currentDocumentNavNonce = nil
        pendingAuthOrigin = nil
        pendingAuthServerId = nil
    }

    private func clearActiveAuth() {
        activeAuthOrigin = nil
        activeAuthServerId = nil
    }

    private func clearPendingAuthIfCurrent(epoch: Int64) {
        if pendingAuthEpoch == epoch {
            pendingAuthOrigin = nil
            pendingAuthServerId = nil
        }
    }

    private func handleWebViewNavigationState(finalize: Bool) {
        guard let webView = self.webView,
              let currentURL = webView.url else {
            return
        }
        if let local = bridge?.config.appStartServerURL,
           currentURL.absoluteString.hasPrefix(local.absoluteString) {
            clearPendingAuth()
            clearActiveAuth()
            return
        }
        let committedOrigin = Self.origin(of: currentURL)
        let expectedEpoch = pendingAuthEpoch
        var expectedOrigin = pendingAuthOrigin
        var serverId = pendingAuthServerId
        if expectedOrigin == nil || serverId == nil {
            if let activeOrigin = activeAuthOrigin,
               let activeServerId = activeAuthServerId,
               activeOrigin == committedOrigin {
                expectedOrigin = activeOrigin
                serverId = activeServerId
            } else {
                return
            }
        }
        guard let targetOrigin = expectedOrigin,
              let targetServerId = serverId else {
            return
        }
        guard committedOrigin == targetOrigin else {
            clearPendingAuthIfCurrent(epoch: expectedEpoch)
            clearActiveAuth()
            if let local = bridge?.config.appStartServerURL,
               let fallbackURL = URL(string: "\(local.absoluteString)/index.html#unreachable") {
                webView.load(URLRequest(url: fallbackURL))
            }
            return
        }
        guard Self.isOriginVerified(origin: targetOrigin, for: targetServerId) else {
            clearPendingAuthIfCurrent(epoch: expectedEpoch)
            clearActiveAuth()
            return
        }
        let expectedDocEpoch: Int64
        let expectedNavNonce: String
        if !finalize || currentDocumentNavNonce == nil {
            documentNavEpoch += 1
            expectedDocEpoch = documentNavEpoch
            expectedNavNonce = "nav-\(expectedEpoch)-\(expectedDocEpoch)"
            currentDocumentNavNonce = expectedNavNonce
        } else {
            expectedDocEpoch = documentNavEpoch
            expectedNavNonce = currentDocumentNavNonce ?? "nav-\(expectedEpoch)-\(documentNavEpoch)"
        }
        webView.evaluateJavaScript(
            Self.buildDocumentNavNonceScript(expectedOrigin: targetOrigin, navNonce: expectedNavNonce),
            completionHandler: nil
        )
        Self.fetchHandshake(origin: targetOrigin) { [weak self] ok, redirected, homeId, hostId, _ in
            DispatchQueue.main.async {
                guard let self,
                      let webView = self.webView,
                      self.pendingAuthEpoch == expectedEpoch,
                      self.documentNavEpoch == expectedDocEpoch,
                      self.currentDocumentNavNonce == expectedNavNonce else { return }
                guard !redirected,
                      ok,
                      homeId == targetServerId,
                      Self.matchesStoredHostId(serverId: targetServerId, candidateHostId: hostId) else {
                    self.clearPendingAuthIfCurrent(epoch: expectedEpoch)
                    self.clearActiveAuth()
                    if let local = self.bridge?.config.appStartServerURL,
                       let fallbackURL = URL(string: "\(local.absoluteString)/index.html#unreachable") {
                        webView.load(URLRequest(url: fallbackURL))
                    }
                    return
                }
                guard let latestURL = webView.url,
                      Self.origin(of: latestURL) == targetOrigin else {
                    self.clearPendingAuthIfCurrent(epoch: expectedEpoch)
                    self.clearActiveAuth()
                    return
                }
                let token = Self.readPeerToken(for: targetServerId, origin: targetOrigin)
                if finalize {
                    self.clearPendingAuthIfCurrent(epoch: expectedEpoch)
                }
                guard let token, !token.isEmpty else { return }
                let script = Self.buildCredentialDeliveryScript(
                    expectedOrigin: targetOrigin,
                    token: token,
                    expectedNavNonce: expectedNavNonce
                )
                webView.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }

    static func stripTokenFromEntry(origin: String, entry: String) -> String {
        guard let entryURL = URL(string: entry),
              Self.origin(of: entryURL) == origin,
              var components = URLComponents(url: entryURL, resolvingAgainstBaseURL: false) else {
            return "\(origin)/"
        }
        if let items = components.queryItems, items.contains(where: { $0.name == "token" }) {
            let filtered = items.filter { $0.name != "token" }
            components.queryItems = filtered.isEmpty ? nil : filtered
        }
        if let fragment = components.percentEncodedFragment,
           fragment.hasPrefix("token=") || fragment.contains("&token=") {
            let kept = fragment
                .split(separator: "&")
                .map(String.init)
                .filter { !$0.isEmpty && !$0.hasPrefix("token=") }
            components.percentEncodedFragment = kept.isEmpty ? nil : kept.joined(separator: "&")
        }
        return components.url?.absoluteString ?? "\(origin)/"
    }

    static func buildDocumentNavNonceScript(expectedOrigin: String, navNonce: String) -> String {
        let originData = (try? JSONSerialization.data(withJSONObject: [expectedOrigin])) ?? Data("[\"\"]".utf8)
        let nonceData = (try? JSONSerialization.data(withJSONObject: [navNonce])) ?? Data("[\"\"]".utf8)
        let originArray = String(data: originData, encoding: .utf8) ?? "[\"\"]"
        let nonceArray = String(data: nonceData, encoding: .utf8) ?? "[\"\"]"
        return "(function(){try{var exp=\(originArray)[0];var n=\(nonceArray)[0];if(window.location.origin!==exp||!n)return false;var doc=window.document||window;try{Object.defineProperty(doc,\"__kikiShellNavNonce\",{configurable:true,enumerable:false,writable:true,value:n});}catch(e){doc.__kikiShellNavNonce=n;}return true;}catch(e){return false;}})();"
    }

    static func buildCredentialDeliveryScript(expectedOrigin: String, token: String, expectedNavNonce: String = "") -> String {
        let originData = (try? JSONSerialization.data(withJSONObject: [expectedOrigin])) ?? Data("[\"\"]".utf8)
        let tokenData = (try? JSONSerialization.data(withJSONObject: [token])) ?? Data("[\"\"]".utf8)
        let nonceData = (try? JSONSerialization.data(withJSONObject: [expectedNavNonce])) ?? Data("[\"\"]".utf8)
        let originArray = String(data: originData, encoding: .utf8) ?? "[\"\"]"
        let tokenArray = String(data: tokenData, encoding: .utf8) ?? "[\"\"]"
        let nonceArray = String(data: nonceData, encoding: .utf8) ?? "[\"\"]"
        return "(function(){try{var exp=\(originArray)[0];var t=\(tokenArray)[0];var n=\(nonceArray)[0];if(window.location.origin!==exp||!t)return false;var doc=window.document||window;if(n&&doc.__kikiShellNavNonce!==n)return false;try{var raw=window.localStorage.getItem(\"kiki.connection\");var managed=window.localStorage.getItem(\"kiki.shell.managed\")===\"1\";if(raw){var parsed=JSON.parse(raw);var pTok=parsed&&typeof parsed.token===\"string\"?parsed.token.trim():\"\";var pUrl=parsed&&typeof parsed.url===\"string\"?parsed.url.trim():\"\";if(pTok!==\"\"&&(!managed||pUrl!==\"\")){try{window.localStorage.removeItem(\"kiki.shell.managed\");}catch(e){}try{window.sessionStorage.removeItem(\"kiki.peer.token\");}catch(e){}try{delete doc.__kikiShellStagedCredential;}catch(e){}return false;}}}catch(e){return false;}try{window.localStorage.removeItem(\"kiki.connection\");window.localStorage.removeItem(\"kiki.shell.managed\");}catch(e){}try{window.sessionStorage.removeItem(\"kiki.peer.token\");}catch(e){}try{var used=false;Object.defineProperty(doc,\"__kikiShellStagedCredential\",{configurable:true,enumerable:false,get:function(){if(used)return null;used=true;try{delete doc.__kikiShellStagedCredential;}catch(e){}return{origin:exp,token:t};}});}catch(e){try{doc.__kikiShellStagedCredential={origin:exp,token:t};}catch(e2){return false;}}try{window.dispatchEvent(new CustomEvent(\"kiki:shell-token\",{detail:{origin:exp,token:t}}));}catch(e){}return true;}catch(e){return false;}})();"
    }

    private static func fetchHandshake(
        origin: String,
        completion: @escaping (_ ok: Bool, _ redirected: Bool, _ targetHomeId: String?, _ targetHostId: String?, _ targetLabel: String?) -> Void
    ) {
        guard let handshakeURL = URL(string: "\(origin)/api/remote-connections/handshake") else {
            completion(false, false, nil, nil, nil)
            return
        }
        var req = URLRequest(url: handshakeURL)
        req.timeoutInterval = 3.5
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        noRedirectSession.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse else {
                completion(false, false, nil, nil, nil)
                return
            }
            if (300..<400).contains(http.statusCode) {
                completion(false, true, nil, nil, nil)
                return
            }
            if let finalURL = http.url, Self.origin(of: finalURL) != origin {
                completion(false, true, nil, nil, nil)
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                completion(false, false, nil, nil, nil)
                return
            }
            var label: String?
            var homeId: String?
            var hostId: String?
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let payload = json["data"] as? [String: Any] {
                label = payload["targetLabel"] as? String
                let identityObj = (payload["identity"] as? [String: Any]) ?? (payload["target"] as? [String: Any])
                homeId = identityObj?["homeId"] as? String
                hostId = identityObj?["hostId"] as? String
            }
            completion(true, false, homeId, hostId, label)
        }.resume()
    }

    private static func scopedTokenAccount(serverId: String, origin: String?) -> String {
        guard let origin, !origin.isEmpty else { return serverId }
        return "\(serverId)@\(origin)"
    }

    private static func writeKeychainToken(_ token: String, account: String) -> Bool {
        guard !account.isEmpty, let data = token.data(using: .utf8) else { return false }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: account
        ]
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
        if status == errSecItemNotFound {
            var addAttributes = query
            addAttributes.merge(updateAttributes) { _, new in new }
            status = SecItemAdd(addAttributes as CFDictionary, nil)
        } else if status != errSecSuccess {
            SecItemDelete(query as CFDictionary)
            var addAttributes = query
            addAttributes.merge(updateAttributes) { _, new in new }
            status = SecItemAdd(addAttributes as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    private static func readKeychainToken(account: String) -> String? {
        guard !account.isEmpty else { return nil }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess,
           let data = item as? Data,
           let token = String(data: data, encoding: .utf8),
           !token.isEmpty {
            return token
        }
        return nil
    }

    private static func deleteKeychainToken(account: String) {
        guard !account.isEmpty else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }

    @discardableResult
    private static func savePeerToken(_ token: String, for serverId: String, origin: String? = nil) -> Bool {
        guard !serverId.isEmpty else { return false }
        let primarySaved = writeKeychainToken(token, account: serverId)
        if let origin, !origin.isEmpty {
            _ = writeKeychainToken(token, account: scopedTokenAccount(serverId: serverId, origin: origin))
        }
        if primarySaved {
            UserDefaults.standard.removeObject(forKey: legacyTokenPrefix + serverId)
        }
        return primarySaved
    }

    private static func readPeerToken(for serverId: String, origin: String? = nil) -> String? {
        guard !serverId.isEmpty else { return nil }
        if let origin, !origin.isEmpty {
            let scoped = scopedTokenAccount(serverId: serverId, origin: origin)
            if let scopedToken = readKeychainToken(account: scoped) {
                return scopedToken
            }
        }
        if let token = readKeychainToken(account: serverId) {
            return token
        }
        if let legacy = UserDefaults.standard.string(forKey: legacyTokenPrefix + serverId), !legacy.isEmpty {
            _ = savePeerToken(legacy, for: serverId, origin: origin)
            return legacy
        }
        return nil
    }

    private static func hasStoredToken(for serverId: String, origin: String? = nil) -> Bool {
        guard let token = readPeerToken(for: serverId, origin: origin) else { return false }
        return !token.isEmpty
    }

    private static func matchesStoredHostId(serverId: String, candidateHostId: String?) -> Bool {
        guard let stored = UserDefaults.standard.string(forKey: hostIdPrefix + serverId), !stored.isEmpty else {
            return true
        }
        guard let candidateHostId, !candidateHostId.isEmpty else {
            return true
        }
        return stored == candidateHostId
    }

    private static func isOriginVerified(origin: String, for serverId: String) -> Bool {
        let list = UserDefaults.standard.stringArray(forKey: verifiedOriginsPrefix + serverId) ?? []
        return list.contains(origin)
    }

    private static func recordVerifiedOrigin(origin: String, for serverId: String, hostId: String?) {
        guard !serverId.isEmpty, !origin.isEmpty else { return }
        var list = UserDefaults.standard.stringArray(forKey: verifiedOriginsPrefix + serverId) ?? []
        if !list.contains(origin) {
            list.insert(origin, at: 0)
            UserDefaults.standard.set(list, forKey: verifiedOriginsPrefix + serverId)
        }
        if let hostId, !hostId.isEmpty {
            UserDefaults.standard.set(hostId, forKey: hostIdPrefix + serverId)
        }
    }

    private static func removeVerifiedOrigin(origin: String, for serverId: String) {
        guard !serverId.isEmpty, !origin.isEmpty else { return }
        var list = UserDefaults.standard.stringArray(forKey: verifiedOriginsPrefix + serverId) ?? []
        if let idx = list.firstIndex(of: origin) {
            list.remove(at: idx)
            UserDefaults.standard.set(list, forKey: verifiedOriginsPrefix + serverId)
        }
    }

    private static func forgetServerData(serverId: String?, origin: String?) {
        let defaults = UserDefaults.standard
        let trusted = defaults.string(forKey: trustedOriginKey)
        if let serverId, !serverId.isEmpty {
            let verified = defaults.stringArray(forKey: verifiedOriginsPrefix + serverId) ?? []
            for vOrigin in verified {
                deleteKeychainToken(account: scopedTokenAccount(serverId: serverId, origin: vOrigin))
            }
            if let origin, !origin.isEmpty {
                deleteKeychainToken(account: scopedTokenAccount(serverId: serverId, origin: origin))
            }
            deleteKeychainToken(account: serverId)
            if let trusted, verified.contains(trusted) {
                defaults.removeObject(forKey: trustedOriginKey)
            }
            defaults.removeObject(forKey: legacyTokenPrefix + serverId)
            defaults.removeObject(forKey: hostIdPrefix + serverId)
            defaults.removeObject(forKey: verifiedOriginsPrefix + serverId)
        }
        if let origin, !origin.isEmpty, origin == trusted {
            defaults.removeObject(forKey: trustedOriginKey)
        }
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        if let local = bridge?.config.appStartServerURL,
           url.absoluteString.hasPrefix(local.absoluteString) {
            return false
        }
        let targetOrigin = Self.origin(of: url)
        if let expectedPending = pendingAuthOrigin {
            if targetOrigin == expectedPending {
                return false
            }
            clearPendingAuth()
            if let local = bridge?.config.appStartServerURL,
               let fallbackURL = URL(string: "\(local.absoluteString)/index.html#unreachable") {
                DispatchQueue.main.async { [weak self] in
                    self?.webView?.load(URLRequest(url: fallbackURL))
                }
            }
            return true
        }
        guard let trusted = UserDefaults.standard.string(forKey: Self.trustedOriginKey),
              targetOrigin == trusted else {
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

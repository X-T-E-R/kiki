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

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
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

/// Same contract as the Android `KikiShellPlugin`: the bundled launcher asks to
/// open one Kiki server; that origin stays inside the app, every other site goes
/// to Safari (Capacitor's default policy), and only the origin is remembered.
@objc(KikiShellPlugin)
public class KikiShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikiShellPlugin"
    public let jsName = "KikiShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    private static let trustedOriginKey = "kiki.shell.trustedOrigin"

    @objc func open(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), let entry = call.getString("entry"),
              let originURL = URL(string: origin), let entryURL = URL(string: entry),
              let normalized = Self.origin(of: originURL), normalized == origin,
              Self.origin(of: entryURL) == origin else {
            call.reject("invalid_origin")
            return
        }
        UserDefaults.standard.set(origin, forKey: Self.trustedOriginKey)
        DispatchQueue.main.async { [weak self] in
            self?.webView?.load(URLRequest(url: entryURL))
            call.resolve(["origin": origin])
        }
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url,
              let trusted = UserDefaults.standard.string(forKey: Self.trustedOriginKey),
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

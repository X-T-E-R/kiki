# Kiki Android Agent Guide (`apps/kiki-android`)

4-module Gradle Android client (`:app` -> `kiki-app/`, `:kiki-host`, `:kiki-runtime`, `:kiki-tools-screen`) sharing package ID `dev.kiki.app`.

## Operating Modes & Tiered Permissions

- **`HostMode` (`KikiHostSettings.hostMode`)**:
  - `UNSELECTED`: Fresh install only. Shows native `ModePickerView` once ("连接电脑 Kiki" vs "在本机运行 Kiki"), commits the choice immediately, and never prompts again on subsequent cold starts. Upgrades with an existing non-empty `files/kiki/home/config.toml` or `files/kiki/home/sessions/` auto-migrate to `LOCAL_HOST`.
  - `REMOTE_ONLY`: Serves `apps/kiki-gui/mobile/launcher` via `WebViewAssetLoader` (`RemotePeerShell`) with `KikiApp/android` UA (omitting `KikiEmbedded/1`). Must never extract `kiki-dist.tar.xz`, start `KikiRuntimeService`, spawn `libkiki_node.so`, or request notification/battery/accessibility/overlay permissions; camera permission is requested only when opening `KikiQrScannerActivity`.
  - `LOCAL_HOST`: Unpacks `kiki-dist.tar.xz` and runs Bionic Node (`libkiki_node.so`) inside `KikiRuntimeService` (`KikiApp/android KikiEmbedded/1`). Mode switching lives exclusively in Settings (`KikiHostSettingsActivity` and the embedded `REMOTE_ONLY` Settings tab); toggling off `LOCAL_HOST` calls `KikiRuntimeService.stopAndTeardown` + `NodeSupervisor.terminateAllOwnedNodeProcesses`.

## `kiki-relay` v1 Transport & Pitfalls

- **`PeerStreamConnector` (`kiki-host/.../remote/PeerStreamConnector.kt` & `apps/kiki-gui/mobile/.../PeerStreamConnector.java`)**:
  - Happy-Eyeballs race: direct `endpoints` (`0 ms` concurrent) -> `relayEndpoints[0]` (`+300 ms`) -> `relayEndpoints[1]` (`+600 ms`). Relay streams require a 64-hex leaf SPKI SHA-256 `fp` and run inner `SSLSocket` (`kiki.peer`) over binary WebSocket frames (`Sec-WebSocket-Protocol: kiki-relay-v1`).
  - **OkHttp `permessage-deflate` pitfall**: OkHttp's `RealWebSocket` invokes `RealCall(..., forWebSocket = true)` which bypasses `networkInterceptors` and injects `Sec-WebSocket-Extensions: permessage-deflate` in `BridgeInterceptor`. Always combine `.minWebSocketMessageToCompress(Long.MAX_VALUE)` with an application `.addInterceptor` stripping `Sec-WebSocket-Extensions` so TLS ciphertext frames are never double-compressed.
  - **`pair/claim` refresh**: When `POST /api/remote-connections/pair/claim` returns non-empty `relayEndpoints` (`rt=g...`), persist them over the initial short-lived `rt=p...` pairing relay URLs.

## Build, Asset Staging & In-App Updater

- **JDK & Signing**: Build `:app` with JDK 17 (`./gradlew testDebugUnitTest`, `./gradlew :app:assembleRelease`). Release builds require real `kiki-dist.tar.xz` (`stage-dist.mjs --require-real`) and `KIKI_ANDROID_KEYSTORE_PATH` / `KIKI_ANDROID_STORE_PASSWORD` / `KIKI_ANDROID_KEY_ALIAS` / `KIKI_ANDROID_KEY_PASSWORD` (optional `KIKI_ANDROID_SIGNING_CERT_SHA256` cross-checked against the keystore X.509 certificate SHA-256).
- **AGP asset compression pitfall**: `stageRemoteShellAssets` must exclude `**/*.gz`, `**/*.br`, and `**/*.map` when staging `../kiki-gui/dist`; otherwise `aapt2` treats `foo.js` and `foo.js.gz` as duplicate asset entries during `:app:mergeReleaseAssets`.
- **`KikiApkUpdater`**: Checks `BuildConfig.UPDATER_FEED_URL` (`official` -> GitHub Releases; `custom` / `portal` -> explicit `KIKI_UPDATER_FEED_URL=https://updates.example.com/android.json`), streams APK download with byte-size + SHA-256 verification, verifies `PackageManager.GET_SIGNING_CERTIFICATES` against `EXPECTED_SIGNER_SHA256` + installed signer before `PackageInstaller.Session` commit, and resumes automatically after `ACTION_MANAGE_UNKNOWN_APP_SOURCES`.

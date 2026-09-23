---
"@kiki/gui": patch
---

Fix the desktop device-code sign-in open-verification action: route the
"Open verification page" button through the host's openUrl channel (a new
http(s)-only `open_external_url` Tauri command driving the system browser)
instead of `window.open`, which the desktop webview silently rejects, and
surface a blocked or failed open as a visible inline line on the card.

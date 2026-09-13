---
"@kiki/agent-core-v2": patch
"@kiki/protocol": patch
"@kiki/kap-server": patch
"@kiki/gui": patch
---

Route Kiki server-setting reads and writes through the kap-server config API, preserve the desktop-managed config fields in the shared contract, and remove the Tauri-side config file writer.

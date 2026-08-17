---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/protocol": patch
"@moonshot-ai/kap-server": patch
"@kiki/gui": patch
---

Route Kiki server-setting reads and writes through the kap-server config API, preserve the desktop-managed config fields in the shared contract, and remove the Tauri-side config file writer.

---
"@kiki/plugin-sdk": patch
---

Add `signal` to `PluginPanelContext`; it aborts when the panel caller disconnects, the 60-second request timeout elapses, or the plugin host stops.

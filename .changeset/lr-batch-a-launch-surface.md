---
"@kiki/cli": patch
"@kiki/kap-server": patch
"@kiki/agent-core-v2": patch
"kiki": patch
---

Harden launch-surface paths: quote `cmd /c start` targets so `&` cannot split the command, refuse executable-looking hosts with trailing dots/spaces and additional single-document extensions in `open_host_path`, allowlist external-open schemes in the VS Code host bridge, keep non-loopback deep-link servers out of persisted Web UI connections, tighten the CORS origin loopback check against `127.*`-prefixed domains, and strip trailing root dots from FetchURL hosts before the donor metadata allowlist.

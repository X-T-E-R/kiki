---
"@kiki/cli": patch
---

Pass the real project MCP target list into the TUI workspace trust prompt so the listed commands match what trusting enables; cap plugin zip downloads and extraction (100 MB download, 200 MB uncompressed, 20k entries); record the git commit in the promoted desktop release (`current.json` `gitSha` and a `build-info.txt` sidecar).

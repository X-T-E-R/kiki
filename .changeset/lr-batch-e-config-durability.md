---
"@kiki/node-sdk": patch
"@kiki/agent-core-v2": patch
---

Preserve the owner-only mode across config rewrites, close the Windows unlink window in atomic writes, and recover orphaned temp documents at startup.

- `atomicWrite` (node-sdk and agent-core-v2) re-applies the requested mode after replacing an existing target, so a rewrite of `config.toml` / `credentials.toml` created with a drifted (looser) mode no longer widens it.
- Windows atomic writes rename over the target first and fall back to unlink+rename only on `EPERM`, so a crash between unlink and rename no longer opens on every write.
- `FileStorageService.read` promotes a surviving `*.tmp.<pid>.<hex>` sibling when the target is missing, so a config or session document killed mid-replace is recovered on next load instead of being lost.

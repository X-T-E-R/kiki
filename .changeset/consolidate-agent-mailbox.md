---
"@moonshot-ai/kimi-code": patch
---

**Breaking:** Named-agent collaboration now uses the shared durable MiniDb mailbox backend in `agent-collaboration-mailbox-v2`. Existing `agent-collaboration-mailbox-v1` messages and receipts are no longer read; the old directory is left unchanged on disk and may be deleted manually.

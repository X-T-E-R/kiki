---
"@kiki/agent-core-v2": patch
"@kiki/cli": patch
"@kiki/kap-server": patch
"@kiki/protocol": patch
"@kiki/session-core": patch
---

Session durability batch: the agent loop awaits the wire flush before a turn exits so the streamed step's `content.part` / `step.end` records land in `wire.jsonl` instead of dying with the process (W1B-01). `AppendLogStore` retries a failed durable append once so queued turns persist after a disk-full or lock conflict instead of living only in memory until the next append (W1B-02). The session event journal fsyncs every flush, requeues lines after a failed write, and `getBufferedSince` returns the new `resync_required(journal_gap)` reason when the durable tail has a seq hole, so clients resync from the snapshot instead of silently skipping events (W1B-06). `resyncRequired` gains the `journal_gap` reason in the protocol catalog and client types.

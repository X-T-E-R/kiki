# transcript-live Agent Guide

This package owns the engine-event bindings that produce canonical transcript operations.
It depends on `@moonshot-ai/transcript`, `@moonshot-ai/agent-core-v2`, and shared protocol types.
Keep transcript projection behavior aligned across live events, persisted wire facts, and replay seeding.
`packages/kap-server` consumes this package; it is not the owner of these bindings.
Do not introduce a dependency from agent-core-v2 back to this package.
Keep moves behavior-preserving and verify both this package and kap-server consumers.

History backfills, including retries, and rewrites call `beginReplay` before reading the replacement projection, then `finishReplay` with its captured adapter/reducer state after installing it. This buffers concurrent engine events and replays only facts absent from that projection; failed reads call `finishReplay` without replacing the current state.

`streamWireRecords` and its awaited wrapper can retain an unfinished record with `retainIncompleteRecord`. Resume with the returned `continuation` and `nextByteOffset`; the offset remains the last complete record boundary, and `bytesRead` counts only new IO. The caller must validate the same source prefix before reusing retained bytes. Cancellation leaves the previous continuation reusable. A byte-budget pause is incomplete; a corrupt unterminated tail stays `partial_tail` and supplies no continuation.

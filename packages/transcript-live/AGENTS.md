# transcript-live Agent Guide

This package owns the engine-event bindings that produce canonical transcript operations.
It depends on `@moonshot-ai/transcript`, `@moonshot-ai/agent-core-v2`, and shared protocol types.
Keep transcript projection behavior aligned across live events, persisted wire facts, and replay seeding.
`packages/kap-server` consumes this package; it is not the owner of these bindings.
Do not introduce a dependency from agent-core-v2 back to this package.
Keep moves behavior-preserving and verify both this package and kap-server consumers.

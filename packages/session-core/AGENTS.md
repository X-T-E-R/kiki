# session-core Agent Guide

This package owns framework-free session state, commands, settings, session lists, composer state, and shared utilities.
It may depend on `@moonshot-ai/protocol`, `@moonshot-ai/transcript`, and transport-facing types.
Do not introduce React, Tauri, VS Code, pi-tui, or kap-server dependencies.
The GUI consumes this package; it is not the owner of this logic.
Keep moves behavior-preserving and verify the package and GUI consumers together.

`SessionAgentForestQuery` owns one retained forest per controller. Its inputs are immutable transcript items, tasks and metadata, roster rows, canonical tool counts and cold-agent ownership; changing any of them invalidates the query. Refreshing roster leases expire on their recorded deadline even if their input references stay unchanged. Keep historical relations and drill-in links complete when changing these caches.

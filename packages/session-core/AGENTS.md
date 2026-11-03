# session-core Agent Guide

This package owns framework-free session state, commands, settings, session lists, composer state, and shared utilities.
It may depend on `@moonshot-ai/protocol`, `@moonshot-ai/transcript`, and transport-facing types.
Do not introduce React, Tauri, VS Code, pi-tui, or kap-server dependencies.
The GUI consumes this package; it is not the owner of this logic.
Keep moves behavior-preserving and verify the package and GUI consumers together.

History HTTP dispatches acquire the connection's `historyReadLane` exactly once, including authoritative retries. Retained partial-structure readers survive transcript resets: abort the old generation, clear its loading state, and isolate late completions from the replacement flight. GUI consumers retain explicit fold expansion and the visible member's reading position by surviving member identity when canonical prefixes change row keys. If a fold splits, keep its turn reader until every inherited group closes.

`SessionAgentForestQuery` owns one retained forest per controller. Its inputs are immutable transcript items, tasks and metadata, roster rows, canonical tool counts and cold-agent ownership; changing any of them invalidates the query. Cold parent history does not make a live child cold: retain its current running or suspended phase, and let a newer live phase outrank an older idle roster row. A newer idle or terminal fact still settles that child. Refreshing roster leases expire on their recorded deadline even if their input references stay unchanged. Keep historical relations and drill-in links complete when changing these caches.

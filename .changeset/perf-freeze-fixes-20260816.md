---
"@moonshot-ai/kimi-code": patch
---

Performance and lifecycle hardening from the 2026-08-16 freeze audit: chunk and memoize GUI transcript rendering so streaming deltas stop re-rendering settled rows; cache rendered markdown blocks in pi-tui; track and drain background-task lifecycle flights; add graceful shutdown with in-flight draining to the thread communication service; cover with perf-exp5 broadcaster-leak and perf-exp6 render measurements.

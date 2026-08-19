---
"@kiki/gui": minor
---

Make the sidebar and session right rail draggable-resizable (CSS-variable-driven, persisted to `localStorage`, clamped to min/max, double-click to reset), add session grouping modes (by time vs. by workspace, with unknown/workspace-less sessions falling into an "ungrouped" bucket), and add per-bucket ordering (most-recent, least-recent, by name — pinned sessions always float first). Grouping and sorting Live in the sidebar alongside the existing workspace filter and persist across reloads.
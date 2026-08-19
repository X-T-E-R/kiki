---
"@kiki/gui": minor
---

Composer status/input enhancements: the footer context-usage meter is now a ring that colors by threshold (amber at 50%, red at 80%) and opens a detail card showing used/available/limit plus the session's lifetime input/output/cache-read/cache-write tokens and cost, with compaction as an explicit action inside the card; the composer's input gains a custom right-click menu (cut/copy/paste-as-plain-text/select-all) that falls back to the native menu when the clipboard API is unavailable.
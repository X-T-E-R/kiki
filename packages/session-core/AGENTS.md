# session-core Agent Guide

This package owns framework-free client session state, commands, settings, session lists, composer helpers, space-namespaced storage, and shared i18n.
It may depend on `@kiki/klient`, `@kiki/protocol`, `@kiki/transcript`, and transport-facing types.
Do not introduce React, Tauri, VS Code, pi-tui, or kap-server dependencies (enforced by `scripts/check-repo-meta.mjs`).
The GUI and TUI consume this package; neither owns this logic. Keep moves behavior-preserving and verify both package and GUI consumers together.

## Module Map & Canonical Contracts

- `src/session/` — `sessionController.ts` and `src/session/transcript/` projection (`project.ts`, `forest.ts`, `selectors.ts`, `window.ts`).
- `src/sessions/` — Pure session-list, inbox (`src/sessions/inbox.ts`), activity (`src/sessions/activity.ts`), sorting, quick-switcher, and away-attention models.
- `src/settings/` — Settings schemas, layout/terminal/shortcut prefs, and seen-state (`src/settings/sessionReadState.ts`, verified by `src/settings/settings.test.ts`).
- `src/storage/` — Composite space-namespaced storage (`src/storage/spaceStorage.ts`: `spaceStorage`, `spaceStorageKey`, `configureSpaceStorage`, `onDidChangeSpaceStorage`).
- `src/composer/`, `src/commands/`, `src/util/` — Drafts, quote selection, session actions, and pure formatting helpers.
- `src/i18n/` — Shared bilingual copy domains (`src/i18n/domains/en/`, `src/i18n/domains/zh/`); never add banned defensive staleness disclaimers (`scripts/check-code-health.mjs`).

## Core Invariants & Pitfalls

- **Composite Space-Keyed Caches**: Desktop switch-mode spaces share one WebView `localStorage`. Every space-scoped store/cache must route through `spaceStorage` / `spaceStorageKey` (`src/storage/spaceStorage.ts`) and invalidate on `onDidChangeSpaceStorage` — never key caches solely by `sessionId` or read raw `localStorage` directly.
- **Unread & Attention Tracking (`last_seq`, Never Wall-Clock)**: `src/settings/sessionReadState.ts` and `src/sessions/inbox.ts` track unread state by comparing the seen high-water mark against the server's monotonic `Session.last_seq` (bucketed into `needsYou`, `unread`, and `running`, with `total = needsYou.length + unread.length`). Never compare wall-clock `updated_at` timestamps for unread/attention state (metadata writes move `updated_at`).
- **Lean Boundaries & Non-Secure LAN Safety**: Validate real transport boundaries cleanly without speculative `failClosed` flags, silent fallback shims, or empty `catch {}` blocks. Never call bare `crypto.randomUUID(` (unavailable over LAN `http://192.168.x.x` Non-Secure Contexts) — use a `crypto.getRandomValues()`-backed `randomUuid()` helper (enforced by `scripts/check-code-health.mjs`).
- **Monolith Freeze**: `src/session/sessionController.ts`, `src/session/transcript/project.ts`, and `src/settings/settings.ts` are frozen under `pnpm run check:meta` (`scripts/check-code-health.mjs`). Extract new logic into cohesive sibling modules (`<= 600` lines) and avoid relative internal `vi.mock` shortcuts in tests.

## History Reads & Agent Forest Retention

History HTTP dispatches acquire the connection's `historyReadLane` exactly once, including authoritative retries. Retained content and partial-structure readers survive transcript resets: abort the old generation, clear its loading state, and isolate late completions from the replacement flight. A retry resumes the retained demand through its remaining refs; a retiring failure cannot overwrite a newer retry. Snapshot readers select visible path prefixes, not the whole metadata object, and do not enter the timeline body cache. GUI consumers retain explicit fold expansion and the visible member's reading position by surviving member identity when canonical prefixes change row keys. If a fold splits, keep its turn reader until every inherited group closes.

`SessionAgentForestQuery` owns one retained forest per controller. Its inputs are immutable transcript items, tasks and metadata, roster rows, canonical tool counts and cold-agent ownership; changing any of them invalidates the query. Cold parent history does not make a live child cold: retain its current running or suspended phase, and let a newer live phase outrank an older idle roster row. A newer idle or terminal fact still settles that child. Roster hints refresh the bounded session shell independently of child detail grades. Compare the roster read with its hint watermark, not unrelated durable events. A refreshed row can replace an off-grade cached binding; newly received live metadata still wins. Refreshing roster leases expire on their recorded deadline even if their input references stay unchanged. Keep historical relations, step model identity and drill-in links complete when changing these caches.

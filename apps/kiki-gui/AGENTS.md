# Kiki GUI Agent Guide

## First-Hand Donor & Visual Proof Rule

- Before editing UI or layout, inspect every supplied `donor_ref` (Mobbin/reference screenshots, donor source) and `user_evidence_ref` directly via `ReadMediaFile` / `Read` — never implement from a prose summary of an unread screenshot.
- Visual acceptance uses the headless proof runner by default (`node apps/kiki-gui/scripts/visual-proof.mjs --config apps/kiki-gui/scripts/visual-proof-headless-smoke.mjs`, or `--base-url <url> --token <token> --route <name=/path> --theme light,dark --locale en,zh --viewport wide,narrow`; omit `--base-url` and add `--scenario <fixture> --vite` to auto-manage Vite + fixture server), then inspect the rendered captures with `ReadMediaFile`.
- Use Ego Lite / a desktop browser only for third-party logged-in sites or real WebView checks; if unavoidable, restore an agent-owned window (`Browser.getWindowForTarget` -> `Browser.setWindowBounds({ windowState: 'normal' })`) and never touch another user's TaskSpace. Real desktop executable acceptance follows `kiki-desktop-ops`.

## Canonical UI Primitives & Hooks (Reuse — Do Not Hand-Roll)

Follow the 7-tier overlay ladder in `src/components/overlays/README.md` (max 1 overlay + 1 `ConfirmDialog`; zero raw `createPortal` or inline `absolute role="menu"` — enforced by `scripts/check-repo-meta.mjs`).

| Surface / Need | Canonical Primitive / Hook | Source Path |
| --- | --- | --- |
| Anchored popover / menu | `AnchoredPopover`, `usePopover`, `@base-ui/react` Popover/Menu + `POPOVER_SURFACE_CLASS` | `src/components/overlays/AnchoredPopover.tsx`, `src/components/SearchableSelect.tsx` |
| In-page master/detail | `DetailSplit`, `useDetailParam` (`?key=` URL-addressable, `@container` breakpoints) | `src/components/overlays/DetailSplit.tsx`, `src/components/overlays/useDetailParam.ts` |
| Side panel / multi-step | `SidePanel` (`width="md"\|"lg"`), `usePanelStack` | `src/components/SidePanel.tsx`, `src/components/overlays/PanelStack.ts` |
| Modal / irreversible confirm | `Dialog` (`DIALOG_PANEL_BASE`, `DIALOG_PANEL_SIZES`), `ConfirmDialog` (never `window.alert/confirm/prompt`) | `src/components/Dialog.tsx`, `src/components/ConfirmDialog.tsx` |
| Mobile bottom sheets | `ActionSheet`, `SpaceSwitchSheet`, `WorkSetupSheet`, `CompactModelSheet` (`<480px`) | `src/components/overlays/ActionSheet.tsx`, `src/components/SpaceSwitchSheet.tsx`, `src/components/Composer.tsx` |
| Toasts & banners | `Toasts`, `pushUndoToast` / `pushToast` (reversible actions undo, no confirm), `AppConnectionBanner`, `RestartBanner` | `src/components/Toasts.tsx`, `src/lib/toasts.ts`, `src/components/AppConnectionBanner.tsx` |
| Touch back-stack & viewport | `useLayerHistory`, `useVisualViewportHeightVar`, `usePhoneMode`, `useCoarsePointer`, `usePaneResize` | `src/lib/layerHistory.ts`, `src/lib/layoutHooks.ts` |
| Transcript virtualization | `Transcript` owns `useVirtualizer` and `useStickToBottom` | `src/components/Transcript.tsx` |
| Copy & i18n domains | Domain tables under `@kiki/session-core` (`en` / `zh` parity) | `packages/session-core/src/i18n/domains/en/`, `packages/session-core/src/i18n/domains/zh/` |

## Styling, Layout & Mobile Invariants

- **Ink-on-Paper tokens (`src/index.css`)**: Light-first warm surfaces (`bg-canvas` < `bg-paper` < `bg-panel`), single vermilion focal accent (`--color-accent` / `--color-attention`), ink-blue selection (`--color-selected-ink`), zero neon purple-on-white, zero decorative UI emojis (gated by `scripts/check-code-health.mjs`). One visual protagonist per screen, headings in a few punchy words, zero multi-line explanatory walls or defensive staleness disclaimers (`数据可能已过期`, `Results may be incomplete`, etc.).
- **Safe Flex Truncation**: Pair dynamic text and trailing actions as `flex items-center gap-2 min-w-0` -> dynamic summary `<span className="min-w-0 flex-1 truncate">` + CTA `<span className="shrink-0">` so trailing actions (e.g. `查看`) never clip into `· 查...`.
- **Zero Artificial Blank Space**: Never set fixed `min-h-[...]` on collapsible, filtered, or variable-length lists/cards; let content hug height.
- **Mobile & Safe Area**: Always consume `--kiki-safe-top-inset`, `--kiki-safe-bottom-inset`, and `env(safe-area-inset-left/right)` directly — never gate safe-area insets behind `max-width: 767px` (breaks landscape phones and iPads). Account for iOS `visualViewport.offsetTop` via `useVisualViewportHeightVar` (`--kiki-visual-height`, `--kiki-ime-offset`).
- **Non-Secure Context LAN Safety (`crypto.randomUUID`)**: Over LAN `http://192.168.x.x`, `crypto.randomUUID` is `undefined` and crashes message sending; never add bare `crypto.randomUUID(` in client code — use a `crypto.getRandomValues()`-backed helper. The mobile launcher uses a `typeof`-guarded call with a fallback in `./mobile/src/target.ts:303` (enforced by `scripts/check-code-health.mjs`).

## 4-Zone Shell, `h-12` Datum & Subtraction-First `<Composer />` Standard

1. **Zone 1 — Sidebar `18px` Keyline & Two-Tier Bell**: `Sidebar.tsx` and `SpaceSwitcher.tsx` align on an `18px` left keyline (`pl-[18px] pr-2.5` header; `px-2.5` outer + `px-2` row + `w-5` leading icon slot). `+ 新会话` uses a `20×20` `rounded-full bg-accent/12 text-accent-ink` `+` icon. The bell shows inset `bg-attention` count when `needsYou.length > 0`, or a quiet `7px` `bg-ink-soft/65` dot with zero digits when `needsYou === 0` (`data-activity-badge={inbox.total}` preserved).
2. **Zone 2 — Continuous 3-Pane `h-12` Header & `AgentFamilyPopover`**: `WorkspaceHeader` is single-row `h-12` (`border-b border-hairline/70`). `AgentWorkspaceHeader` renders inline ancestor crumbs + single `<h1>` leaf trigger opening `@base-ui/react` `AgentFamilyPopover`, inline `● N` pill, quiet branch seam badge, and `[合回主线]` (`data-branch-fold-action`) on the right (no duplicate `<h1>`, no header `model·effort`, no `data-agent-relations-surface`, no floating `data-branch-fold-bar` above `<Composer />`).
3. **Zone 3 — Right Inspector `h-12` Sticky Bar**: `[data-rail-pinned]` is `h-12`. `NeedsYouList`, `ProfileHead`, and `InspectorNow` scroll inside `.rail-page`. When inspecting the center agent, `[data-rail-owner]` renders a single `<h2 tabIndex={-1} data-rail-owner-heading>` (`Overview` / `Cockpit`).
4. **Zone 4 — Subtraction-First `<Composer />` (2–3 Rows Max)**: `[data-composer-body]` holds at most: (1) optional edit banner or `44px` (`h-11`) horizontal shelf (`[data-context-shelf]` with `pt-2 pb-1`), (2) unobstructed `<ComposerInput />` (inline `@Thread · <short>` pills), (3) calm `[data-composer-toolbar]` (`Stop` when `busy && !canSend`, `[↑ | ▾]` split when `busy && canSend`, `<480px` `CompactModelSheet`). Mode lives only in `RunModeChip`; plugin panels live only in top-right `WorkspacePanelsControl` + `/` completion; Right Rail separates read-only `CapabilitiesBlock` from default-collapsed `EnvironmentBlock`; SSH hosts and `<PluginStatusCapsules />` live in bare `[data-composer-status-line]` below the card (`side="top"`).

## Monolith Freeze & Asset Compounding

- `src/components/Transcript.tsx`, `src/components/SessionView.tsx`, `src/components/Composer.tsx`, `src/components/Sidebar.tsx`, and `src/components/agent-workspace/AgentWorkspace.tsx` are frozen under `pnpm run check:meta` (`scripts/check-code-health.mjs`). Never grow baselined monoliths or add relative internal `vi.mock` shortcuts in tests.
- Extract new UI behavior into cohesive sibling modules (`src/components/<domain>/*`), tighten baselines via `--ratchet`, and register reusable UI primitives or non-obvious platform pitfalls in this catalog in the same change.

# Kiki GUI Agent Guide

- Kiki GUI visual acceptance uses the headless proof runner by default; it never depends on an Ego Lite or desktop window. Use `node apps/kiki-gui/scripts/visual-proof.mjs --config apps/kiki-gui/scripts/visual-proof-headless-smoke.mjs` for the checked-in smoke matrix, or pass `--base-url <url> --token <token> --route <name=/path> --theme light,dark --locale en,zh --viewport wide,narrow` for an existing GUI server. Omit `--base-url` and add `--scenario <fixture> --vite` to start and clean up Vite plus the fixture server automatically.
- Use Ego Lite / a desktop browser only for a third-party site that needs the user's login state or a real desktop WebView. If an Ego capture is unavoidable, restore an agent-owned target before the screenshot with `Browser.getWindowForTarget` and `Browser.setWindowBounds({ windowState: 'normal' })` (for example: `const { windowId } = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId }); await task.cdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });`). Never touch another user's TaskSpace. Real desktop executable acceptance follows the `kiki-desktop-ops` process.

## Canonical 4-Layer Composer Slot Standard

`<Composer />` (`src/components/Composer.tsx`) enforces a strict top-to-bottom 4-layer DOM and visual order inside `[data-composer-body]`:

1. **Layer 1 — Session Mode & Environment Header** (strictly above `[data-context-tray]`):
   - `1a` `[data-composer-mode-banner]`: queue-edit or armed `/goal` banner (hidden when inactive).
   - `1b` `[data-composer-env-strip]`: unified session environment & workbench strip combining resident SSH hosts (`[data-composer-ssh-strip]`) and `<PluginComposerSlots />` (`[data-plugin-composer-slots]`) separated by a subtle hairline divider when both exist; omitted completely when both are empty. Flat compact pills (`h-6 text-[12px]`), vector SVG `<Icon />` only (zero Emoji).
2. **Layer 2 — Draft Payload Tray (`[data-context-tray]`)**, touching Layer 3 directly with zero elements between them:
   - `2a` `[data-context-media-strip]`: media thumbnails (`ImageTile`s grouped first so 56px thumbnails never baseline-fight 24px chips).
   - `2b` `[data-context-chips-row]`: `QuoteChip` & `ComposerNotes` -> `File`/`Upload` `TextTile` -> `@Thread`/`@Room` `RefChip` -> `/SkillChip`.
   - `2c` Inline draft alerts (`[data-attachment-error]`, `[data-slash-confirm]`).
3. **Layer 3 — Primary Editor (`[data-composer-editor]`)**: unobstructed `<ComposerInput />` + floating `/` and `@` autocomplete menu (`bottom-full`). Never mount plugin slots or chip bars inside Layer 3.
4. **Layer 4 — Action & Control Toolbar (`[data-composer-toolbar]`)**: left cluster (`+` `AddMenu` -> `RunModeChip` -> `ProfileSelect`/Persona -> `ExecutionSelect` -> `OutputLayerSelect` / `RecipeBindingStatus` / `PluginStatusCapsules`), right cluster (`ml-auto`: `PermissionSelect` -> `ContextMeter` -> `Stop`/`Send`).

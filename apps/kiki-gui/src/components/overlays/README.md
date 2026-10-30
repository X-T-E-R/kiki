# Overlays: which surface a task gets

Pick the lowest tier that fits. Moving up a tier costs the user context; it must buy something.

| Tier | Use it for | Primitive | Golden sample |
| --- | --- | --- | --- |
| 1. Row inline edit | A row that edits its own one or two values | `InlineEditor`, `CommitInput`, row pickers | `settings/profileEditor/TeamView.tsx` (model / effort cells) |
| 2. Anchored popover | 1–3 fields or a short choice, attached to its trigger; light dismiss, no scrim | `AnchoredPopover` + `usePopover` | `settings/MainUsagePolicyFields.tsx` (按智能体), `TeamView.tsx` (menu review) |
| 3. In-page detail | Editing an existing object picked from a list; URL-addressable, list stays usable, no scrim | `DetailSplit` + `useDetailParam` | `settings/UnifiedAgentManager.tsx` (`?agent=`), `settings/ModelsSection.tsx` `ModelDetailSplit` (`?model=`) |
| 4. Side panel | Creating something, or a multi-step flow; deeper steps push inside the panel | `SidePanel` (`back`, `stepKey`) + `usePanelStack` | `UnifiedAgentManager.tsx` (新建智能体), `settings/notifications/AddChannelPanel.tsx` |
| 5. Dialog | A rare, short, self-contained task that is not an object edit | `Dialog` + `dialogPanelClass('sm'｜'md'｜'lg')` | `settings/spaces/SpaceDialogs.tsx` |
| 6. Confirm | Irreversible only: deletes stored data, uninstalls, signs out of an external account, discards a large draft | `ConfirmDialog` | `ModelsSection.tsx` (remove model) |
| 7. Undo toast | Everything reversible: run it now, offer the inverse | `pushUndoToast` (`lib/toasts.ts`) | `settings/SpacesSection.tsx`, `RequestGovernanceView.tsx`, `settings/SessionTitlePromptField.tsx` |

**Global rule: at most one overlay layer plus one confirm.** A side panel never opens another panel or a dialog. A dialog never opens a dialog. The only thing allowed on top of either is one `ConfirmDialog` (or the app's leave prompt).

## Deciding

1. Is it an existing object from a list? → in-page detail. Not a modal, not a panel, however big the editor is.
2. Does it create something or walk steps? → side panel, steps pushed inside it.
3. Is it one to three values? → popover on the control that shows them.
4. Is the action reversible with the same data (disable, unstar, reset to default, remove from a list, delete a rule you can write back)? → do it, then `pushUndoToast`. No confirm.
5. Is it irreversible? → `ConfirmDialog` naming the object and the consequence; the button is the specific verb.
6. Otherwise, and only if short and self-contained → `Dialog`.

## Primitive contracts

### `DetailSplit` / `useDetailParam`

```tsx
const detail = useDetailParam('agent');              // ?agent=<key>
<DetailSplit selected={openKey ?? null} label={t('…')}
  list={<FullList onOpen={(row) => detail.open(row.key)} />}   // rows carry data-detail-trigger={key}
  rail={<DetailRailGroup label=…><DetailRailItem itemKey=… current=… onSelect=… /></DetailRailGroup>}
  detail={<Editor onClose={detail.close} />} />       // title carries data-detail-heading tabIndex={-1}
```

- Opening pushes one history entry; switching replaces; closing pops (so Back and browser back agree).
- All three go through the guarded navigator. The editor only reports dirtiness (`useDirtyReporter` or `SettingsDraftFooter`); never add a confirm of your own for switch/close.
- Focus moves to `[data-detail-heading]` on open and back to `[data-detail-trigger=key]` on close.
- The full list stays mounted (hidden) while a detail is open. md+ shows the rail; below md the detail is one pane and needs a visible Back (`DetailBack`, `md:hidden`) in its header. md+ gets a close `×`.
- The settings page widens its column while `[data-detail-split=open]` is inside it (720 → 1180px). Nothing to do per page.
- The pane is a size container (`@container`). Lay the editor out with `@3xl:` / `@xl:` variants, not viewport `lg:`: the rail already takes ~15rem, so viewport breakpoints over-promise width.
- Sticky tab strips and save bars inside a detail stick to the settings scroll column's edge, not its padding: `top-[calc(-1*var(--settings-scroll-pt,0px))]` / `bottom-[calc(-1*var(--settings-scroll-pb,0px))]`, with `bg-canvas`. Plain `bottom-0` floats the bar 64px above the bottom over the fields.
- A `?key=` naming nothing (deleted, typo) closes back to the list once the list has loaded.
- View Transitions are progressive: `useDetailParam` passes `viewTransition` to the router, which skips it where `document.startViewTransition` is missing (older WebKit). Reduced motion turns it off.

### `AnchoredPopover` / `usePopover`

```tsx
const pop = usePopover();
<button type="button" {...pop.triggerProps}>按智能体</button>
<AnchoredPopover {...pop.popoverProps} label="…" align="end" data={{ 'data-x': id }}>…</AnchoredPopover>
```

- Portaled to `<body>`, placed by `placeAnchored` (flip + shift + max height), follows scroll/resize. No native `popover`, no CSS anchor positioning: WKWebView support is not something to depend on.
- Light dismiss: outside press, Escape, focus leaving. Pickers opened inside it (their own portals) count as inside.
- `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls` come from `triggerProps`. Focus goes to `[data-autofocus]` or the first control and returns to the trigger.
- Inside a Dialog/SidePanel it marks `data-modal-escape=<overlayId>`: the trap lets it hold focus and Escape closes the popover before the panel.
- Put form content in it, not prose. A title line of a few words is enough.

### `pushUndoToast`

```ts
const before = rules;                       // keep what the inverse needs BEFORE acting
await client.setRules(next);
pushUndoToast({ text: t('x.deleted', { name }), undoFailedText: t('toast.undoFailed'),
  undo: async () => { await client.setRules(before); await refresh(); } });
```

- The action has already been written. `undo` performs the inverse; there is no deferred commit and nothing waits for the toast to expire.
- One action button (撤销 / Undo). 8 s window, paused while hovered or focused; a hairline countdown that disappears under reduced motion.
- Failures inside `undo` become an error toast; callers do not wrap it.
- Text says what completed, in a few words: "已删除规则「x」". No celebration, no explanation.

### Sizes

`dialogPanelClass('sm' | 'md' | 'lg')` for Dialogs (520 / 640 / 880). `SidePanel width="md" | "lg"` (480 / 640). Never hand-write `max-w-[…px]` on an overlay. Anything that wants more than 880px is a page or an in-page detail.

### `SidePanel` push navigation

`<SidePanel back={{ label, onClick, data }} stepKey={step}>` puts a Back arrow before the title and re-enters the body per step. Keep the step state in `usePanelStack` (or local state for two steps). Don't open a second panel for a sub-step.

## Red lines

- No Dialog or SidePanel to edit an existing object.
- No overlay over an overlay (one confirm excepted).
- No ConfirmDialog for a reversible action.
- No hand-rolled `createPortal` + position math for a new floating surface; use `AnchoredPopover` / `placeAnchored`.
- Keep the data attributes tests and proof walkers use; when one moves, grep `src/**/*.test.tsx` and `scripts/visual-proof*.mjs` for it.
- No explanatory paragraph inside a popover, panel header or toast.

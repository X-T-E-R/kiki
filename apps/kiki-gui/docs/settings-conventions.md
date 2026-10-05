# Settings controls and save conventions

How a settings card should behave in `apps/kiki-gui`. These components already
exist in `src/components/controls.tsx` and
`src/components/settings/{fields,SettingsPrimitives,useInstantSave,SectionCard}.tsx`
— use them rather than writing a parallel version.

## 1. One save model per card

Pick by what the card edits, not by taste.

| The card edits | Mode | Use |
| --- | --- | --- |
| Independent single values: switch, choice, one number | **Instant apply** (default) | `useInstantSave()` + `SaveStatus` next to the control + `FeedbackLine feedback={save.error}` |
| A group whose values only make sense together, JSON/textarea, list editors, create forms | **Draft** | `SettingsDraftFooter` (Save · Discard · status) with `saved` from `useSavedTick()` |

- No per-field Save button ("Save budget", "Save timeout"). A number field in an instant card is `CommitInput`: saves on blur/Enter, Escape reverts, validation message under the field.
- Never mix modes inside one card. If a card has one textarea plus switches, the whole card is Draft.
- Success feedback is `SavedTick` / `SaveStatus` ("✓ Saved", fades after 2.5s). Do **not** put success text in a `FeedbackLine`; that line is for errors and for results that carry information ("Imported 3 packs", "Removed 2 worktrees").
- Errors: `FeedbackLine` under the control or footer, reading font, danger color. Keep server wording via `errorText(locale, error)`.
- Toasts (`pushToast`) only for results of actions that navigate away or finish in the background. Not for settings saves.
- Delayed effect: `SectionCard effect="restart" | "newSessions"` on the card heading, once. Don't write "applies immediately" — immediate is the default.

```tsx
const save = useInstantSave();
<SettingField label={t('st.x.label')} help={t('st.x.help')}>
  <SaveStatus saving={save.saving} saved={save.saved} />
  <SettingsSelect variant="row" ariaLabel={t('st.x.label')} value={value} choices={choices}
    disabled={save.saving} onChange={(next) => void save.run(() => write(next))} />
</SettingField>
<FeedbackLine feedback={save.error} />
```

Put `SaveStatus` *before* the control in the slot so the control's right edge stays aligned down the card.

## 2. Controls

- **Dropdowns**: `SettingsSelect` (on `SearchableSelect`). No native `<select>` in settings. `variant="row"` in a `SettingField` row; `variant="form"` in stacked form grids and dialogs (matches `INPUT` height). `mono` only for machine values. Long or searchable lists (models, workspaces with many entries) use `SearchableSelect` directly with `FORM_SELECT_TRIGGER` / `SETTINGS_SELECT_TRIGGER`.
- **2–4 short options**: `SettingsSegmented`, not a dropdown.
- **Switches**: inside a `SettingField`, use `<Toggle layout="bare" label={same label}/>` — the label prints once, the switch keeps its accessible name. Standalone switch rows use `layout="row"`. Never `layout="inline"` inside a `SettingField` (that is the duplicated “使用记忆 … 使用记忆” bug).
- **Numbers / short text** in instant cards: `CommitInput` (`h-8`, same height as selects and segmented). In draft forms: plain `input` with `INPUT` + `FORM_LABEL`.
- **Secrets**: `SecretField`. Never a plain password input.
- **Buttons**: `PRIMARY_BUTTON` only for the one commit per card; `SECONDARY_BUTTON` for everything else; `DANGER_GHOST_BUTTON` + `ConfirmDialog` for irreversible actions.

## 3. Card anatomy

```
SectionCard  (T1 heading, one hairline, optional effect/scope tag)
  one-line intro Hint (optional, ≤ 1 line at 1440; longer text goes to AdvancedDetails)
  SettingsGroup (optional sub-step, T3/500)
    SettingField  label T3/400 · help Hint · control on the right edge
    DependentField (only when a parent switch is on — render nothing, not a disabled field)
  AdvancedDetails (collapsed tail: raw ids, precedence rules, env names)
  SettingsDraftFooter | FeedbackLine
```

- No boxes inside a card: no bordered panels around a toggle, no `rounded-lg border p-3` wrapper around a form. The list/detail editors (`SettingsDetailLayout`) and row lists (models, providers, workspaces) are the only bordered surfaces.
- Help text: one sentence, what it does + default. Precedence, internals, env variables → `AdvancedDetails`.
- Names in reading font; ids/keys/paths in `font-mono text-[11px] text-ink-faint` beside or under them.
- Field labels are T3 (13px ink). Stacked form labels use `FORM_LABEL` (12px/500 ink-soft).

## 4. Copy

- All strings through `t()`; add en + zh together (`packages/session-core/src/i18n/{en,zh}.ts`), reusing the zh terms already on neighbouring cards.
- Effort levels display capitalized (`effortLabel` in `settings/profileEditor/profileDraft.ts`: “High”), as in the composer; the stored value stays lowercase.
- Buttons say the result (“Add rule”, “Remove worktree”). No “Submit”/“OK”.
- Errors say what failed + how to recover.

## 5. Editing patterns

- **Text draft, parsed on save.** JSON and structured text fields keep the raw text as the draft. Parse only when Save is pressed; a parse or shape error blocks the save, marks the field (`aria-invalid`, danger border) and lands as `role="alert"` directly under that field, not in the footer. Editing the field clears the error. The card is Draft mode, so the commit is `SettingsDraftFooter`. Patches carry only the fields that changed. Examples: `ModelEngineFields`, `GlobalRequestIdentityCard`.
- **Write-only named values.** Values that may hold secrets (provider request headers and env, plugin secrets) are never read back. The server returns names only (`custom_header_keys`, `env_keys`) and the UI lists each name with “Set”, offering Replace and Remove; a write sends `{name: value}`, a removal `{name: null}`. OAuth shows status only (`{storage, signed_in}`). Example: `ProviderConnectionExtras`.
- **Merge, don't replace, shared tables.** A card that owns a few keys of a larger config table (`loop_control`) writes them with a set/merge patch, never a `replace_domains` replace, so keys edited elsewhere survive. Replace only when the card owns the whole table (`retry`) or writes back the full stored table with its own change applied (auto-compaction).
- **Plugin settings live on the plugin.** A plugin's own settings form sits on its detail page (Capabilities → plugin), next to its tools and permissions, backed by `GET/POST /plugins/{id}/settings`. Settings → Plugins stays the install/enable list.

## 6. Testing hooks

- `SettingsSelect`: open via the trigger (`#id` or `[aria-haspopup="listbox"]`), pick `[role="option"]` by text/title.
- Switch: `input[type=checkbox]` inside the label; `[role="switch"]` carries `aria-checked`.
- Save state: `[data-save-status="saving"]`, `[data-saved-tick]`; errors `[role="alert"]`.
- `CommitInput` commits on `focusout` / Enter keydown.

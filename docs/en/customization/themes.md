# Custom Themes

Kiki can use a built-in color scheme or your own JSON theme file. Custom files live in the themes directory and show up in `/theme` next to the built-in choices.

::: tip Terminal themes and GUI skins
This page covers **terminal (TUI) themes**. The GUI uses its own format called a **skin**, which covers colors, fonts and shape as well — see [GUI Skins](./skins.md).

Both live in the **same directory** (`~/.kiki/themes/`) and are told apart by content: a file with `"kind": "kiki-skin"` is a GUI skin, anything else is a TUI theme, and each loader ignores the other's files. A TUI theme does not restyle the GUI, and a skin does not restyle the terminal.
:::

## Built-in color tokens

A custom theme can override any token below. The `dark` and `light` columns are the built-in values; `auto` resolves to one of them at startup and falls back to `dark` when terminal background detection is unavailable.

| Token | `dark` | `light` | What it controls |
| --- | --- | --- | --- |
| `primary` | `#4FA8FF` | `#1565C0` | The most-used color. Links, inline code, the selected item in nearly every dialog, the focused editor border, Plan/"running" badges, spinners |
| `accent` | `#5BC0BE` | `#00838F` | Secondary highlight. Approval `▶` prefix, device-code box, image placeholder, BTW / queue panes, registry import |
| `text` | `#E0E0E0` | `#1A1A1A` | Body text. Dialog bodies, todo titles, footer model label, Markdown headings, assistant/tool message bullets, list bullets |
| `textStrong` | `#F5F5F5` | `#1A1A1A` | Emphasized / bold text. Input dialogs, status messages |
| `textDim` | `#888888` | `#454545` | Secondary, dimmed text. Thinking, hints, descriptions, completed todos, Markdown quotes, footer status bar |
| `textMuted` | `#6B6B6B` | `#5F5F5F` | Faintest text. Counters, scroll info, descriptions, Markdown link URLs, code-block borders |
| `border` | `#5A5A5A` | `#737373` | Pane and editor borders, Markdown horizontal rule |
| `borderFocus` | `#E8A838` | `#92660A` | Focus / attention border, currently only the approval panel |
| `success` | `#4EC87E` | `#0E7A38` | Success state. `✓`, "enabled", completed |
| `warning` | `#E8A838` | `#92660A` | Warning state. auto/yolo badges, stale markers, Plan mode hint |
| `error` | `#E85454` | `#B91C1C` | Error state. Error messages, failed tool output |
| `diffAdded` | `#4EC87E` | `#0E7A38` | Diff added lines |
| `diffRemoved` | `#E85454` | `#B91C1C` | Diff removed lines |
| `diffAddedStrong` | `#7AD99B` | `#0E7A38` | Diff intra-line changed words, added and bold |
| `diffRemovedStrong` | `#F08585` | `#B91C1C` | Diff intra-line changed words, removed and bold |
| `diffGutter` | `#6B6B6B` | `#737373` | Diff line-number gutter |
| `diffMeta` | `#888888` | `#5F5F5F` | Diff meta / hunk headers |
| `roleUser` | `#FFCB6B` | `#9A4A00` | User message bullet and text, skill-activation name |
| `shellMode` | `#BD93F9` | `#7C3AED` | Shell mode (`!`) prompt, editor border, and the echoed `$ command` line |

## Let the skill write it

You do not have to write the JSON by hand. Run `/kiki-ops` and describe the theme you want — the skill picks the colors, writes the file under `~/.kiki/themes/`, checks the hex values, and tells you how to apply it.

- `/kiki-ops Create a warm dark theme with amber accents.`
- `/kiki-ops Make a light theme based on Solarized, but keep errors easy to see.`
- `/kiki-ops Tweak my ember theme so diffs have higher contrast.`

It will usually ask whether you want a light or dark base, what mood or palette you prefer, and whether you have specific colors to include. When you ask it to edit an existing theme, it reads and backs the file up before overwriting.

## Create a theme

Add a `.json` file to the themes directory:

- `~/.kiki/themes/`
- or `$KIKI_HOME/themes/` when the `KIKI_HOME` environment variable is set

Create the directory if it does not exist. **The filename is the theme name**: `ember.json` appears in `/theme` as `Custom: ember`.

A minimal theme only sets the colors you want to change; the rest fall back to the **base palette** (`dark` by default):

```json
{
  "name": "ember",
  "colors": {
    "primary": "#83A598",
    "accent": "#FE8019"
  }
}
```

Fields:

- `name` (required): the theme identifier.
- `displayName` (optional): a human-readable name.
- `base` (optional): the built-in palette that unspecified tokens inherit — `"dark"` (default) or `"light"`. Set `"base": "light"` when you are building a **light** theme so the tokens you leave out stay readable on a light background (otherwise they fall back to the dark palette).
- `colors` (optional): the color tokens to override, each a 6-digit hex value (e.g. `#FE8019`).

Use the token names from [Built-in color tokens](#built-in-color-tokens). Any token you omit falls back to the selected base palette, so partial themes are fine:

```json
{
  "name": "just-blue",
  "colors": {
    "primary": "#3B82F6",
    "roleUser": "#3B82F6"
  }
}
```

## Select a theme

Two ways:

1. **The `/theme` command** — opens the picker, where your themes appear as `Custom: <filename>`. The picker re-scans the directory each time it opens, so a file you just added shows up without a restart.
2. **`tui.toml`** — set `theme` to the theme's name:

   ```toml
   # ~/.kiki/tui.toml
   theme = "ember"
   ```

## What happens on errors

A bad value never stops the theme from loading:

- **An invalid color value** (not `#` followed by 6 hex digits): that one entry is skipped and falls back to the selected base palette; the rest still apply.
- **An unrecognized token**: ignored, with no effect on other colors.
- **A missing theme file or malformed JSON**: falls back to the built-in `dark` palette, not to `auto`.

If your changes do not appear at all, check that the filename matches `name` in the file — that mismatch is the usual cause, and it fails silently.

## Editing the active theme

If you edit the theme file that is **currently active**, the change is not reloaded automatically. To apply the new colors:

- run `/reload-tui` — it reloads `tui.toml` and re-applies the current theme (including re-reading the theme file); or
- switch to another theme in `/theme` and back.

::: warning Note
Picking the **same** theme again in `/theme` does not reload it — you get "Theme unchanged". Use `/reload-tui`, or switch to another theme and back.
:::

# GUI Skins

A skin changes how the Kiki GUI looks: its palette, its fonts, its corner radius and its density. Kiki ships four skins, and you can add your own as a JSON file.

Skins are declarative only. A skin sets design tokens — it cannot add CSS rules or scripts, so it cannot hide an approval prompt, break a layout on upgrade, or run code.

Light and dark stay a separate choice. A skin supplies a light variant, a dark variant, or both; the theme switch above the skin picker still decides which one you see.

## Built-in skins

| Skin | Variants | What it is |
| --- | --- | --- |
| **Paper** (default) | light, dark | Warm paper and ink with a rust accent. Kiki's own voice. |
| **Slate** | light, dark | Cool neutral greys with an ink-blue accent. The chrome recedes; code is the only warm thing on screen. |
| **High contrast** | light, dark | Pure white or pure black ground, visible borders instead of implied ones, text at AAA on every surface. |
| **Nocturne** | dark only | Deep indigo paper with a mint accent. In light mode it keeps showing its dark palette, and the settings page says so. |

## Pick and adjust a skin

Settings → General → Appearance:

- **Skin** — pick any built-in skin or one from your themes folder. Applies immediately.
- **Adjustments** — override the accent color, interface font, code font, corner radius and density on top of the skin you picked. These preview live as you change them; press Save to keep them.
- **Export as skin file** — writes everything you currently see as a `.json` skin file. Put it in your themes folder or share it.

## The themes folder

Skin files go in the same directory as TUI themes:

- `~/.kiki/themes/`
- or `$KIKI_HOME/themes/` when `KIKI_HOME` is set

Create it if it does not exist. **The filename is the skin id**: `ocean.json` appears as `Ocean` in the picker. Filenames must be lowercase letters, digits and hyphens.

After adding a file, press **Reload skins** in Appearance. No restart needed.

::: warning Which machine's folder?
Kiki reads this folder **on the machine running kap-server**, because that is the only filesystem the server can see.

- **Desktop app** — your own `~/.kiki/themes/`, as you would expect.
- **Browser connected to a remote server** — the folder belongs to that server, not to the device you are browsing from. The built-in skins still work everywhere, since they ship in the app itself.
:::

Kiki only ever **reads** this folder. Exporting a skin hands you a file to place yourself.

## Write a skin

A minimal skin sets only what it wants to change:

```json
{
  "kind": "kiki-skin",
  "version": 1,
  "name": "Ocean",
  "variants": {
    "dark": {
      "colors": {
        "paper": "#0b2126",
        "accent": "#ff8d7a",
        "onAccent": "#2b0a05"
      }
    }
  }
}
```

Top-level fields:

- `kind` (required): always `"kiki-skin"`. This is what separates a GUI skin from a TUI theme in the same folder.
- `version` (required): always `1`.
- `name` (required): the display name in the picker.
- `id` (optional): defaults to the filename.
- `description`, `author` (optional): shown in the picker.
- `variants` (required): at least one of `light` / `dark`.

Each variant takes `colors`, `fonts` and `shape`. Anything you leave out keeps its default value, so a partial skin is fine.

### Color tokens

Every value is `#rgb` or `#rrggbb`.

| Token | What it controls |
| --- | --- |
| `canvas` | The app ground the sidebar sits on — the lowest surface |
| `paper` | The raised conversation sheet, the main reading surface |
| `panel` | Inspector, preview and floating cards — the highest surface |
| `hairline` | Quiet dividers and input borders |
| `hairlineStrong` | Emphasized borders, hover borders |
| `ink` | Body text |
| `inkSoft` | Secondary text, labels |
| `inkFaint` | Hints, counters, timestamps |
| `accent` | The one highlight color: primary buttons, links, focus rings, the streaming caret |
| `accentDeep` | Accent hover/pressed |
| `accentSoft` | Tinted accent washes — selected rows, search-hit flash |
| `accentInk` | The accent used as **text** — links, inline emphasis. Leave it out and Kiki derives one from `accent` |
| `onAccent` | Text **on** a filled accent surface. Set this, or a light accent gets unreadable white labels |
| `amberInk`, `amberCard`, `amberRule` | The attention/caution role: pending approvals, stale markers |
| `success` | Success states, added diff lines |
| `danger` | Errors, destructive actions |
| `onDanger` | Text on a filled danger surface |
| `bubbleUser` | Your own message bubble |
| `scrollbar`, `scrollbarHover` | Scrollbar thumbs |
| `shell` | The always-dark island: terminal, tool output wells |
| `shellInk`, `shellInkStrong`, `shellInkSoft` | Text inside the shell island |
| `shellDanger` | Errors inside the shell island |
| `shellHairline`, `shellHover` | Borders and hover washes inside the shell island |
| `termScrollbar` | Scrollbar inside the terminal |
| `shadowInk` | The color shadows and modal scrims are mixed from |

::: tip Keep text readable
Kiki's built-in skins hold WCAG AA (4.5:1) for every text token against `canvas`, `paper` and `panel`, and for `onAccent` against `accent`. A skin that drops below that is still loaded — Kiki will not override your choice — but text gets hard to read. Check your `ink`, `inkSoft` and `inkFaint` against all three surfaces.
:::

### Fonts

```json
{ "fonts": { "sans": "'IBM Plex Sans', system-ui, 'PingFang SC', sans-serif" } }
```

- `sans` — interface text
- `display` — headings and the wordmark
- `mono` — code, terminal, numbers

Values are **font family stacks only**. A skin cannot load a font file; name families already installed on the machine, or already bundled with Kiki (`Instrument Sans`, `Newsreader`, `JetBrains Mono`, `Space Grotesk`, `Fraunces`). Parentheses, semicolons and braces are rejected, so `url(...)` is not expressible.

Always end a stack with a CJK-capable family or a generic (`sans-serif`, `serif`, `monospace`), or Chinese text falls back unpredictably.

### Shape

```json
{ "shape": { "radius": 14, "stageGap": 8, "spacing": 0.25 } }
```

- `radius` — sheet corner radius in px (0–28)
- `stageGap` — gap between the window edge and the floating sheets in px (0–24)
- `spacing` — the density unit in rem (0.19–0.33; the default is `0.25`). This scales every padding and gap in the app at once, so small changes go a long way.

## What happens on errors

Skins are designed to never lock you out of your own interface:

- **An invalid color or font value**: that one token is dropped and keeps its default; the rest of the skin applies. Appearance lists what was dropped.
- **An unknown token**: ignored, reported in the same place.
- **An unexpected top-level key** (for instance a `css` field): the whole file is rejected, because a skin carrying something other than tokens is not a skin. It appears under the skipped files list with the reason.
- **Malformed JSON, or a TUI theme file**: skipped, listed with a reason, and the other files still load.
- **A selected skin file that disappears**: the GUI falls back to the default palette and says the skin is missing, rather than silently applying a different one.

## Distribution

The skin format is deliberately shaped so a skin can ship inside a plugin as a declarative contribution: an enabled plugin's `x-kiki.themes` entries appear in the same picker, marked with the plugin that contributed them. Share a standalone skin as a `.json` file, or bundle it with a plugin.

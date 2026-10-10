# GUI Skins

A skin sets the Kiki GUI's colors, fonts, corner radius and density. Kiki comes with six light–dark skin families, and you can add your own as a JSON file. A skin only sets design tokens — it carries no CSS and no code, so nothing you install can restyle an approval prompt or run anything on your machine.

Light and dark remain a separate choice. A skin can supply a light variant, a dark variant, or both; the theme switch above the skin picker decides which one you actually see.

## Built-in skins

| Skin | Variants | What it is |
| --- | --- | --- |
| **Paper × Inkstone** (default) | light, dark | Warm white paper and ink-blue marks; cool charcoal and copper after dark. |
| **Porcelain × Deepwater** | light, dark | Cool white paper and cobalt details; layered navy and mist-blue controls at night. |
| **Celadon × Night Garden** | light, dark | Celadon glaze and soft white paper; deep pine surfaces and jade details at night. |
| **Apricot × Afterglow** | light, dark | Apricot-white paper and berry controls; plum-charcoal layers and peach light after dark. |
| **Iris × Starveil** | light, dark | Violet-white paper and iris ink; indigo-violet layers and silver-lilac controls at night. |
| **High contrast × Obsidian** | light, dark | Visible borders and AAA main text; layered charcoal, ice-cyan focus and near-white controls at night. |

## Pick and adjust a skin

Settings → Appearance:

- **Skin**: pick a built-in skin, one from your themes folder, one contributed by an enabled plugin (marked "From plugin …"), or the colors of an installed appearance pack. It applies immediately.
- **Accent, fonts, radius, density**: override these on top of the skin you picked. Every change applies as you make it, and **Restore defaults** undoes all of them at once, with an undo.
- **Export as skin file**: writes everything you currently see as a `.json` skin file. Put it in your themes folder or share it.

The first page of the first-run setup (**Language and look**) has the same light / dark choice, the built-in palettes, and an optional background picture.

## Background picture or video

Settings → Appearance → Background puts a picture or a short video behind the window.

- **Choose picture or video**: PNG, JPEG, WebP, AVIF, GIF, MP4 or WebM, up to 25 MB for a picture or 100 MB for a video. The file stays on this device (in the browser's storage) and is never uploaded, so it works for a browser tab connected to a remote server too.
- **Or paste a link**: an `https` link to a picture or video. The server fetches it once, under the policy in [Linked pictures](#linked-pictures), and keeps the copy on this device. Nothing is loaded from that link again, so it cannot track you and the background still shows offline.
- **Show behind**: the whole window, only the conversation, or only the sidebar (tablet width and up).
- **Fit** (fill, fit, tile, center), **Anchor** (nine points), **Picture strength**, **Blur**, **Brightness** and **Soften** (a wash of the window color over the picture).
- **Panel opacity** and **Panel blur**: how much the sidebar, page sheets, headers and composer surfaces let the picture through, within the scope you chose.
- **Separate for light and dark**: off by default. Turn it on to pick a different background for each theme.

Readability assist adds a local wash behind conversation and settings text without raising your **Panel opacity** setting. Page sheets, headers and the composer follow that setting; menus, dialogs and approval prompts keep solid backgrounds. A busy picture can still make text hard to read at low opacity, so raise **Panel opacity** when you need more separation.

Video plays muted and on a loop. It holds on its first frame — or the pack's poster — while the window is hidden or not focused, when reduced motion is on, and when the battery is low and you are unplugged. Kiki warns about videos above 1440p or 40 MB: they cost a lot of memory and you cannot see the difference behind the panels.

## The themes folder

Skin files go in the same directory as TUI themes:

- `~/.kiki/themes/`
- or `$KIKI_HOME/themes/` when `KIKI_HOME` is set

Create it if it does not exist. **The filename is the skin id**: `ocean.json` appears as `Ocean` in the picker. Filenames must be lowercase letters, digits and hyphens.

After adding a file, press **Reload skins** in Appearance. No restart needed.

::: warning Which machine's folder?
The themes folder is read on the machine running the Kiki server, since that is the only filesystem it can see.

- **Desktop app** — your own `~/.kiki/themes/`.
- **Browser connected to a remote server** — the folder belongs to that server, not to the device you are browsing from. Built-in skins work either way, because they ship inside the app.
:::

Kiki does not write skin files into this folder. **Export as skin file** hands you the file and you place it where you want it. Appearance packs are the exception: **Import pack** and **Delete** create and remove pack folders here, and do nothing else.

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
Kiki's built-in palettes hold WCAG AA (4.5:1) for body, secondary, faint and semantic text against `canvas`, `paper` and `panel`, and for `onAccent` against `accent`. Set `accentInk` for text rather than reusing the button fill `accent`, especially in Paper. A skin below that contrast still loads, and Kiki will not correct it for you, so check your `ink`, `inkSoft` and `inkFaint` against all three surfaces before you ship it.
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

A bad skin never leaves you without an interface. Appearance reports what it did with each file:

- **An invalid color or font value**: that one token is dropped and keeps its default; the rest of the skin applies.
- **An unknown token**: ignored.
- **An unexpected top-level key** (for instance a `css` field): the whole file is rejected and listed with the reason, because a skin that carries anything besides tokens is not a skin.
- **Malformed JSON, or a TUI theme file**: skipped with a reason, and the other files still load.
- **A selected skin file that disappears**: the GUI falls back to the default palette and says the skin is missing, rather than quietly applying a different one.

## Appearance packs

An appearance pack bundles colors with background pictures or video, one set per theme, plus a preview for the pack list. It is a folder in the themes folder, `<themes>/<id>/`, holding `kiki-pack.json` and the files it names. A complete example lives in the repository at `docs/examples/appearance-packs/dusk-harbor/`.

Settings → Appearance → Appearance packs lists installed packs with their preview, and offers:

- **Use pack**: sets the pack's colors as the skin and its media as the background. Both are ordinary settings afterwards, so you can still move the sliders.
- **Import pack**: installs a `.zip`. The archive is checked completely before anything is written.
- **Export**: downloads the pack as a `.zip`.
- **Delete**: removes the pack folder from the server, after a confirmation.

```json
{
  "kind": "kiki-appearance-pack",
  "version": 1,
  "id": "dusk-harbor",
  "name": "Dusk Harbor",
  "license": "CC0-1.0",
  "preview": "preview.webp",
  "variants": {
    "light": {
      "colors": { "accent": "#2e6784", "accentInk": "#23566f" },
      "background": { "media": ["tide.webp"], "opacity": 0.9, "surfaceOpacity": 0.74 }
    },
    "dark": {
      "colors": { "accent": "#e5c68c", "onAccent": "#1b1409" },
      "background": { "media": ["lantern.mp4"], "poster": "lantern.webp" }
    }
  }
}
```

- `id` must match the folder name (lowercase letters, digits, hyphens).
- Each variant takes the skin fields (`colors`, `fonts`, `shape`, `base`) and an optional `background`.
- `background.media` names 1–12 files; with more than one, `interval` (seconds) turns them into a carousel. `poster` is the still shown while a video is paused.
- The background dials are `fit` (`cover` `contain` `tile` `center`), `alignment` (`center` `top` `bottom` `left` `right` `topLeft` `topRight` `bottomLeft` `bottomRight`), `opacity` (0–1), `blur` (0–40), `brightness` (0.4–1.4), `scrim` (0–0.9), `scope` (`window` `main` `sidebar`), `surfaceOpacity` (0.3–1) and `surfaceBlur` (0–32). The names follow Windows Terminal's background settings.

`surfaceOpacity` sets how far the sheet washes, headers, composer surfaces and inspector let the background through, within the scope you chose. Readability assist keeps the local text wash in the conversation and settings, and frosts the other page sheets and the inspector instead of raising their opacity. Text over a busy picture can still be hard to read at low opacity even with assist on; raise `surfaceOpacity` when you need more separation. Dialogs and popovers keep solid fills.

The built-in `kiki-appearance` skill walks an agent through making a pack: the format, the contrast rules for each color, media sizes and encoding, packaging, and the usual mistakes.

### What a pack can and cannot contain

- **Only** the manifest and picture or video files it names: PNG, JPEG, WebP, AVIF, GIF, MP4, WebM. Anything else in the archive — a script, a stylesheet, SVG, HTML, a font, or a file the manifest does not name — refuses the whole pack.
- Every file's first bytes must match its extension, so a renamed web page cannot pass as a picture. Files are served with their true type, `nosniff`, and a sandboxing content policy.
- Limits: 25 MB per picture, 100 MB per video, 100 MB and 64 files per pack. Archive entries are checked against these before anything is decompressed.
- **No custom CSS.** Tokens already reach every color, face and shape the app exposes, and a stylesheet could hide approval prompts, draw fake controls, or load tracking URLs.
- A pack is installed as a unit, so any unknown key fails the whole pack — unlike a skin file, which drops a bad token and keeps the rest. Half-accepting a pack would pair media with colors the author never tested together.

### Linked pictures

**Or paste a link** fetches through the server, which allows `https` only, no credentials in the URL, at most three redirects, and the same size limits as an uploaded file. Every redirect hop is resolved and refused unless it points at a public internet address — loopback, private, link-local and carrier-grade NAT ranges are all out. The type is checked from the bytes, not from the response headers.

## Distribution

An enabled plugin can ship skins. Anything it declares under `x-kiki.themes` appears in the picker beside your own skin files, marked with the plugin that contributed it. To share a skin of your own, send the `.json` file, bundle it into a plugin, or ship colors with art as an [appearance pack](#appearance-packs).

---
name: kiki-appearance
description: Create, fix, or package a Kiki appearance pack or skin file (GUI colors plus background picture or video). Use when the user wants a custom look for the Kiki window, a pack from their own art, or to repair one that will not install. Do not use merely to switch light/dark or pick an existing skin.
---

# Kiki appearance packs (kiki-appearance)

An appearance pack is a folder holding `kiki-pack.json`, optional color tokens, and background media. It is data only: no CSS, no scripts, no SVG, no font files. Everything the GUI can change is a token or a background dial. The full reference is `<KIKI_HOME>/docs/<locale>/customization/skins.md`; read it before stating a limit.

Choose the smaller format when it fits. Colors only means a skin file (`kind: "kiki-skin"`, one `.json` in `<KIKI_HOME>/themes/`). A single picture for yourself needs no file at all: Settings › Appearance › Background. Colors together with media, or something to share, means a pack.

## Layout

```
dusk-harbor/            folder name == manifest id
  kiki-pack.json
  preview.webp          optional; shown in the pack list (16:10 reads best)
  tide.webp             media named by the manifest, flat, no subfolders
  lantern.mp4
  lantern.webp          poster: the still shown while video is paused
```

Install: copy the folder into `<KIKI_HOME>/themes/` on the server host, or zip it and use **Settings › Appearance › Appearance packs › Import pack**. An archive is checked completely before anything is written. Any file the manifest does not name, any unknown key, or any file whose bytes do not match its extension refuses the whole pack.

## Manifest

```json
{
  "kind": "kiki-appearance-pack",
  "version": 1,
  "id": "dusk-harbor",
  "name": "Dusk Harbor",
  "description": "One line for the pack list.",
  "author": "You",
  "license": "CC0-1.0",
  "preview": "preview.webp",
  "variants": {
    "light": { "colors": { "accent": "#2e6784" }, "background": { "media": ["tide.webp"] } },
    "dark":  { "colors": { "accent": "#e5c68c" }, "background": { "media": ["lantern.mp4"], "poster": "lantern.webp" } }
  }
}
```

- `id`: lowercase letters, digits, and `-`, up to 64 characters. It must equal the folder name.
- `variants`: `light`, `dark`, or both. A variant takes the skin fields `base`, `colors`, `fonts`, and `shape`, plus `background`. A pack with one background uses it in both themes.
- `background`: `media` (1–12 files; more than one plus `interval` seconds makes a carousel), `poster`, and the dials below. Omitted dials take the defaults shown.

| Dial | Range | Default | Meaning |
| --- | --- | --- | --- |
| `fit` | `cover` `contain` `tile` `center` | `cover` | How the media fills the area |
| `alignment` | `center` `top` `bottom` `left` `right` `topLeft` `topRight` `bottomLeft` `bottomRight` | `center` | Anchor point |
| `opacity` | 0–1 | 1 | Media strength |
| `blur` | 0–40 px | 0 | Blur on the media |
| `brightness` | 0.4–1.4 | 1 | Media brightness |
| `scrim` | 0–0.9 | 0 | Wash of the canvas color over the media |
| `scope` | `window` `main` `sidebar` | `window` | Where it shows |
| `surfaceOpacity` | 0.3–1 | 0.6 | How opaque the reading panels are where the background shows |
| `surfaceBlur` | 0–32 px | 14 | Backdrop blur behind panels |

Out-of-range values are errors, not clamps.

## Color tokens and contrast

Colors are `#rgb` or `#rrggbb`. Any token you omit falls back to the base palette, so set only what you mean.

| Token | Role | Must hold |
| --- | --- | --- |
| `canvas` `paper` `panel` | App ground, sheets, raised cards (dark to light in light mode) | Keep them close: one visible step each |
| `ink` `inkSoft` `inkFaint` | Body, secondary, and faint text | **≥ 4.5:1 on canvas, paper, and panel**, including `inkFaint` |
| `accent` `accentDeep` `accentSoft` | Fills, hover, tinted wash | `onAccent` ≥ 4.5:1 on `accent` |
| `accentInk` | Accent used as text (links) | ≥ 4.5:1 on all three surfaces; derived from `accent` if omitted |
| `hairline` `hairlineStrong` | Rules, borders | ≥ 3:1 for `hairlineStrong` against paper |
| `danger` `success` `amber*` | Status | Same text rule |
| `shell*` | Terminal and code wells, always dark | `shellInk` ≥ 4.5:1 on `shell` |

Check every pair before shipping. Relative luminance is `0.2126 R + 0.7152 G + 0.0722 B` on linearised sRGB, and contrast is `(L1 + 0.05) / (L2 + 0.05)`. A short Python or Node script is fine; report the lowest ratio.

The background cannot break text contrast. The GUI raises `surfaceOpacity` just enough that the faintest text holds 4.5:1 over the darkest and lightest pixels of the picture, and Settings says when it did. A low `surfaceOpacity` is a wish, so tune the picture (`scrim`, `brightness`, `blur`) rather than fighting the floor.

## Media

- Types: PNG, JPEG, WebP, AVIF, GIF, MP4 (H.264), WebM (VP9/AV1). No SVG and no HTML. Bytes are sniffed.
- Limits: a picture ≤ 25 MB, a video ≤ 100 MB, the whole pack ≤ 100 MB and ≤ 64 files. The GUI warns above 40 MB of video and above 1440p video.
- Recommended: 2560×1440 WebP at quality 80 (1–3 MB). Use 1080p video at CRF 23–28, 8–30 s, a seamless loop, no audio (it is always muted), and `+faststart`. Give a video a `poster` extracted from its first frame.
- Video plays muted and looped. It pauses on its poster when the window is hidden or unfocused, under reduced motion, or on low battery.
- Busy art reads worse. Keep the calm area where the conversation sits (usually centre-left), or raise `scrim` to 0.3–0.5.

```sh
ffmpeg -i in.mov -t 12 -vf "scale=1920:-2,format=yuv420p" -c:v libx264 -crf 25 -preset slow -an -movflags +faststart loop.mp4
ffmpeg -i loop.mp4 -frames:v 1 -q:v 3 loop-poster.webp
```

## Packaging and checking

1. Put every file flat in the folder, and name each one in the manifest.
2. Zip either the folder or its contents: `cd dusk-harbor && zip -X ../dusk-harbor.zip *`.
3. Import it and read the message. The error names the exact file or field.
4. Look at it in both themes at desktop and phone width, with a long conversation scrolled.

## Common mistakes

- **Folder name ≠ `id`**: the pack is listed as skipped. Rename one of them.
- **An extra file** (`.DS_Store`, `notes.txt`, `theme.css`): the import is refused. Remove it or use `zip -X` from inside the folder.
- **A renamed file** (`.png` that is really JPEG): the import is refused. Re-export it in the real format.
- **Only `accent` set in dark mode**: text accents are derived and may land too bright. Set `accentInk` too.
- **`inkFaint` tuned by eye**: it is usually the pair that fails. Check it on `canvas`.
- **A 4K 60 fps video**: it uses a lot of graphics memory for no visible gain behind panels. Export 1080p 30 fps instead.
- **Custom CSS**: not supported, deliberately. It could hide or restyle approval prompts. Use tokens.
- **Web art you do not have rights to**: use your own, or openly licensed art, and say which in `license`.

Verify the effect, not the write. After installing, confirm the pack appears in the list, "Use pack" applies both halves, and nothing is reported as skipped.

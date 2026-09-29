"""Generate proof backgrounds for the appearance visual proof (no third-party art).

  vivid-anime.jpg  saturated, high-contrast, light/dark mixed: a sunset sky
                   gradient, hard-edged cel-shaded blocks, white highlights and
                   near-black shadows, like an anime wallpaper's color spread.
  bright-sky.jpg   a large area of pure bright color (pale sky + white).

Run: python scripts/gen-appearance-media.py   (writes fixtures/appearance-media)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'fixtures' / 'appearance-media'
W, H = 2560, 1440
rng = np.random.default_rng(42)


def vertical(stops):
    """RGB gradient from (t, (r, g, b)) stops, top to bottom."""
    t = np.linspace(0, 1, H)[:, None]
    out = np.zeros((H, 1, 3))
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        mask = (t >= t0) & (t <= t1)
        k = np.clip((t - t0) / max(t1 - t0, 1e-6), 0, 1)
        seg = np.array(c0) * (1 - k[..., None]) + np.array(c1) * k[..., None]
        out = np.where(mask[..., None], seg, out)
    return np.repeat(out, W, axis=1).astype(np.uint8)


def vivid():
    sky = vertical([(0, (40, 18, 110)), (0.35, (236, 64, 140)), (0.6, (255, 170, 60)), (1, (255, 236, 150))])
    img = Image.fromarray(sky)
    d = ImageDraw.Draw(img)
    # Sun with a hard white core.
    d.ellipse([1700, 420, 2100, 820], fill=(255, 250, 225))
    # Cel-shaded skyline / hills: flat saturated blocks, hard edges.
    palette = [(20, 10, 45), (60, 20, 90), (0, 150, 190), (255, 60, 90), (10, 200, 140)]
    for layer in range(5):
        base = 900 + layer * 110
        pts = [(0, H)]
        x = 0
        while x < W:
            w = int(rng.integers(90, 320))
            h = base - int(rng.integers(0, 260 - layer * 30))
            pts += [(x, h), (x + w, h)]
            x += w
        pts += [(W, H)]
        d.polygon(pts, fill=palette[layer])
    # Speed lines and sparkles: bright strokes over dark, dark over bright.
    for _ in range(60):
        x = int(rng.integers(0, W)); y = int(rng.integers(0, 800))
        d.line([(x, y), (x + int(rng.integers(120, 480)), y + int(rng.integers(-30, 30)))], fill=(255, 255, 255), width=int(rng.integers(2, 7)))
    for _ in range(40):
        x = int(rng.integers(0, W)); y = int(rng.integers(0, H))
        r = int(rng.integers(8, 40))
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255) if rng.random() > 0.4 else (10, 5, 25))
    # Big character-like silhouette block with a rim light.
    d.rounded_rectangle([260, 380, 820, H + 40], radius=260, fill=(15, 8, 35))
    d.rounded_rectangle([300, 420, 780, H + 40], radius=240, outline=(255, 120, 200), width=14)
    return img.filter(ImageFilter.GaussianBlur(0.8))


def bright():
    sky = vertical([(0, (150, 215, 255)), (0.55, (215, 240, 255)), (1, (255, 255, 255))])
    img = Image.fromarray(sky)
    d = ImageDraw.Draw(img)
    for _ in range(14):
        x = int(rng.integers(-200, W)); y = int(rng.integers(100, 1100))
        d.ellipse([x, y, x + int(rng.integers(400, 900)), y + int(rng.integers(120, 260))], fill=(255, 255, 255))
    return img.filter(ImageFilter.GaussianBlur(18))


OUT.mkdir(parents=True, exist_ok=True)
vivid().save(OUT / 'vivid-anime.jpg', quality=86)
bright().save(OUT / 'bright-sky.jpg', quality=86)
print('written', OUT)

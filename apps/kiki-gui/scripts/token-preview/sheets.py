# Contact sheets: for each page × theme × locale at 1440, a grid of the
# palettes (current / p923 / a / b / c), each labelled. Also a 390 strip.
import pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).resolve().parents[2] / '.tmp' / 'visual_tokens'
SHOTS = HERE / 'shots'
OUT = HERE / 'compare'
OUT.mkdir(exist_ok=True)
TOKENS = ['current', 'p923', 'a', 'b', 'c']
LABEL = {'current': '现状 current', 'p923': '9.23 前 p923', 'a': 'A 纸与墨青', 'b': 'B 石与橙', 'c': 'C 砂与陶'}
try:
    FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 28)
except OSError:
    FONT = ImageFont.load_default()

def grid(files, cols, scale, name):
    ims = [(t, Image.open(f)) for t, f in files if f.exists()]
    if not ims:
        return
    w, h = ims[0][1].size
    w2, h2 = int(w * scale), int(h * scale)
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * w2 + (cols + 1) * 16, rows * (h2 + 48) + 16), '#808080')
    d = ImageDraw.Draw(sheet)
    for i, (t, im) in enumerate(ims):
        x = 16 + (i % cols) * (w2 + 16); y = 16 + (i // cols) * (h2 + 48)
        d.text((x, y), LABEL[t], fill='#ffffff', font=FONT)
        sheet.paste(im.resize((w2, h2), Image.LANCZOS), (x, y + 40))
    sheet.save(OUT / name)

for page in ['session', 'new', 'activity', 'settings']:
    for theme in ['light', 'dark']:
        for loc in ['zh', 'en']:
            grid([(t, SHOTS / f'{page}-{t}-{theme}-1440-{loc}.png') for t in TOKENS], 2, 0.62, f'{page}-{theme}-1440-{loc}.png')
            grid([(t, SHOTS / f'{page}-{t}-{theme}-390-{loc}.png') for t in TOKENS], 5, 0.8, f'{page}-{theme}-390-{loc}.png')
print('sheets ->', OUT)

# Pairs: for each page × theme (1440, zh), a labelled row of palettes
# (default: current | a | b) at full resolution, so each can be read closely.
#   python scripts/token-preview/pairs.py [tokens...]
import pathlib, sys
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).resolve().parents[2] / '.tmp' / 'visual_tokens'
SHOTS = HERE / 'shots'
OUT = HERE / 'pairs'
OUT.mkdir(exist_ok=True)
TOKENS = sys.argv[1:] or ['current', 'a', 'b']
LABEL = {'current': '现状', 'p923': '9.23 前', 'a': 'A 纸与墨青（推荐）', 'b': 'B 石与橙（对照）', 'c': 'C 砂与陶'}
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 26)
for page in ['session', 'composer', 'new', 'activity', 'settings']:
    for theme in ['light', 'dark']:
        files = [(t, SHOTS / f'{page}-{t}-{theme}-1440-zh.png') for t in TOKENS]
        ims = [(t, Image.open(f)) for t, f in files if f.exists()]
        if not ims:
            continue
        w, h = ims[0][1].size
        sheet = Image.new('RGB', (len(ims) * w + (len(ims) + 1) * 16, h + 60), '#7a7a7a')
        d = ImageDraw.Draw(sheet)
        for i, (t, im) in enumerate(ims):
            x = 16 + i * (w + 16)
            d.text((x, 12), LABEL[t], fill='#ffffff', font=FONT)
            sheet.paste(im, (x, 52))
        sheet.save(OUT / f'{page}-{theme}.png')
print('pairs ->', OUT)

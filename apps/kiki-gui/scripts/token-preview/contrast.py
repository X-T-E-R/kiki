# WCAG contrast for every token-preview palette (plus the shipped one).
# Parses src/styles/token-preview.css and the shipped values from index.css.
import re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
css = (ROOT / 'src/styles/token-preview.css').read_text(encoding='utf8')
base = (ROOT / 'src/index.css').read_text(encoding='utf8')

def block(text, sel):
    m = re.search(re.escape(sel) + r'\s*\{(.*?)\n\}', text, re.S)
    return dict(re.findall(r'--color-([\w-]+):\s*(#[0-9a-fA-F]{6})', m.group(1))) if m else {}

def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

def cr(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)

def mix(fg, bg, a):  # fg at alpha a over bg
    f = [int(fg[i:i+2], 16) for i in (1, 3, 5)]; g = [int(bg[i:i+2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(x*a + y*(1-a)):02x}' for x, y in zip(f, g))

shipped_l = block(base, '@theme'); shipped_d = {**shipped_l, **block(base, "[data-theme='dark']")}
pal = {'shipped': (shipped_l, shipped_d)}
for n in ['p923', 'a', 'b', 'c']:
    l = {**shipped_l, **block(css, f":root[data-kiki-tokens='{n}']")}
    d = {**shipped_d, **block(css, f":root[data-kiki-tokens='{n}'][data-theme='dark']")}
    pal[n] = (l, d)

CHECKS = [
    ('ink-faint', 'canvas'), ('ink-faint', 'paper'), ('ink-faint', 'hover@paper'), ('ink-faint', 'selected'),
    ('ink-soft', 'canvas'), ('accent-ink', 'canvas'), ('accent-ink', 'paper'), ('accent-ink', 'accent-soft'),
    ('attention', 'paper'), ('attention', 'attention-soft'), ('selected-ink', 'selected'), ('ink', 'selected'),
    ('section-ink', 'canvas'), ('section-ink', 'paper'), ('success', 'paper'), ('danger', 'paper'),
    ('amber-ink', 'paper'), ('on-accent', 'accent'), ('accent', 'canvas|3'), ('hairline-strong', 'paper|3'),
]
worst = 0
for name, (l, d) in pal.items():
    for theme, p in (('light', l), ('dark', d)):
        p = dict(p); p.setdefault('on-accent', '#ffffff' if theme == 'light' else '#2a1408')
        row = []
        for fg, bg in CHECKS:
            floor = 4.5
            if '|' in bg: bg, floor = bg.split('|'); floor = float(floor)
            bgv = mix(p['ink'], p['paper'], 0.05) if bg == 'hover@paper' else p[bg]
            v = cr(p[fg], bgv)
            flag = '' if v >= floor else ' FAIL'
            if flag and name != 'shipped' and name != 'p923': worst += 1
            row.append(f'{fg}/{bg} {v:.2f}{flag}')
        print(f'[{name} {theme}] ' + ' | '.join(row))
print('fails in candidates:', worst)

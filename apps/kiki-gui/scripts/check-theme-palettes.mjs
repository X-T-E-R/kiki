import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Usage: node scripts/check-theme-palettes.mjs <first proposal.md> <r2 proposal.md>
// The documents stay outside the product repository; their paths are explicit.
export function checkThemePalettes(firstPath, secondPath) {
  const gui = fileURLToPath(new URL('../', import.meta.url));
  const text = readFileSync(resolve(gui, 'src/lib/skins/builtin.ts'), 'utf8');
  const documents = [firstPath, secondPath].map((path) => readFileSync(path, 'utf8'));
  const tables = documents.map((document) => [...document.matchAll(/^### 3\.\d+ (.+)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)]
    .map((match) => [...match[2].matchAll(/^\| `([A-Za-z]+)` \| `(#[0-9A-F]{6})` \| `(#[0-9A-F]{6})` \|$/gm)]));
  assert.deepEqual(tables.map((list) => list.length), [5, 3]);
  const expected = {
    paper: tables[0][0], porcelain: tables[0][1], celadon: tables[0][2],
    apricot: tables[1][0], iris: tables[1][2], contrast: tables[1][1],
  };
  assert.deepEqual(tables[0][4].map((row) => [row[1], row[2]]), expected.contrast.map((row) => [row[1], row[2]]));
  const skins = [...text.matchAll(/id: (?:'([a-z]+)'|DEFAULT_SKIN_ID),[\s\S]*?variants: \{([\s\S]*?)(?=\n  \},)/g)];
  assert.equal(skins.length, 6);
  let tokens = 0;
  for (const skin of skins) {
    const id = skin[1] ?? 'paper';
    const rows = expected[id];
    assert.equal(rows?.length, 36, id);
    for (const [mode, column] of [['light', 2], ['dark', 3]]) {
      const colorBlock = skin[2].match(new RegExp(`${mode}: \\{ colors: \\{([\\s\\S]*?)\\}`));
      assert.ok(colorBlock, `${id}/${mode}`);
      const actual = Object.fromEntries([...colorBlock[1].matchAll(/([A-Za-z]+): '(#[0-9A-F]{6})'/g)].map((m) => [m[1], m[2]]));
      assert.deepEqual(actual, Object.fromEntries(rows.map((row) => [row[1], row[column]])), `${id}/${mode}`);
      tokens += Object.keys(actual).length;
    }
  }
  const css = ['src/index.css', 'src/styles/skin.css'].map((path) => readFileSync(resolve(gui, path), 'utf8'));
  const cssVariables = (mode) => Object.fromEntries(css.flatMap((file) => {
    const light = file.match(/@theme \{([\s\S]*?)\n\}/)[1];
    const dark = file.match(/\[data-theme='dark'\] \{([\s\S]*?)\n\}/)[1];
    return [...`${light}\n${mode === 'dark' ? dark : ''}`.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
  }));
  const mirrors = {
    paper: ['muted', 'sidebar'], panel: ['background'], hairline: ['border', 'input'],
    ink: ['foreground'], inkSoft: ['muted-foreground'], accent: ['primary'], onAccent: ['primary-foreground'],
  };
  let defaults = 0;
  for (const [mode, column] of [['light', 2], ['dark', 3]]) {
    const variables = cssVariables(mode);
    for (const row of expected.paper) {
      const token = row[1]; const hex = row[column];
      if (token === 'shadowInk') {
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
        assert.equal(variables['--kiki-shadow-ink'], rgb, `${mode}/shadowInk`);
      } else {
        const kebab = token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        for (const variable of [kebab, ...(mirrors[token] ?? [])]) {
          assert.equal(variables[`--color-${variable}`]?.toUpperCase(), hex, `${mode}/${variable}`);
        }
      }
      defaults++;
    }
  }
  return { tokens, defaults, variants: 12 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Pass both proposal Markdown paths');
  console.log('PASS', checkThemePalettes(process.argv[2], process.argv[3]));
}

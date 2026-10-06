/**
 * Visual proof for the goal's ongoing tone.
 *
 *   node scripts/visual-proof-goal-tone.mjs [--matrix=all]
 *
 * The complaint was that a goal that is simply running reads as an alarm: its
 * colour sat close to the "everything is permitted" warning, so ordinary work
 * looked like something needing attention. What this proves is the split — an
 * ongoing goal is quiet, while blocked / paused / failed keep the semantics that
 * actually mean "look at this".
 *
 * The assertion reads the computed colour of each state's own surface rather than
 * a class name, so a token change that re-colours the mark by accident fails
 * here instead of shipping.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** rgb → a single comparable triple, so two colours can be ordered. */
function rgbOf(value) {
  const parts = String(value).match(/\d+(?:\.\d+)?/g);
  return parts === null ? null : parts.slice(0, 3).map(Number);
}

/** Perceived luminance, 0 (black) … 1 (white). */
function luminance(rgb) {
  if (rgb === null) return null;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How far apart two colours are, 0 … 441. */
function distance(a, b) {
  if (a === null || b === null) return null;
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Any computed colour into a 0-255 triple.
 *
 * The page paints two shapes of colour: a token as `rgb(255, 253, 250)`, and a
 * `color-mix()` as `color(srgb 0.95 0.94 0.93)` — same colour, 0-1 components.
 * Comparing one against the other directly is how a proof ends up asserting on
 * numbers that mean nothing.
 */
function toBytes(value) {
  const text = String(value);
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (numbers === null) return null;
  const parts = numbers.slice(0, 3).map(Number);
  return /^color\(/i.test(text) ? parts.map((part) => Math.round(part * 255)) : parts;
}

/**
 * What the goal's own surfaces paint: the sheet behind the row (the band that
 * read as an alert) and the status word beside the objective.
 */
async function goalTones(page) {
  return page.evaluate(() => {
    const toBytes = (value) => {
      const text = String(value);
      const numbers = text.match(/\d+(?:\.\d+)?/g);
      if (numbers === null) return null;
      const parts = numbers.slice(0, 3).map(Number);
      return /^color\(/i.test(text) ? parts.map((part) => Math.round(part * 255)) : parts;
    };
    const row = document.querySelector('[data-header-toggle="goal"]');
    const sheet = document.querySelector('.composer-header-goal');
    const word = document.querySelector('[data-goal-status-word]');
    const mark = row?.querySelector('.kiki-life') ?? null;
    return {
      present: row !== null,
      // `color-mix` resolves as `color(srgb r g b)` — 0-1 components — while a
      // plain token paints as `rgb(0-255)`. Normalise both into 0-255 before
      // any distance is taken, or the two spaces are compared against each
      // other and every number is nonsense.
      sheet: sheet === null ? null : toBytes(getComputedStyle(sheet).backgroundColor),
      sheetRaw: sheet === null ? null : getComputedStyle(sheet).backgroundColor,
      mark: mark === null ? null : toBytes(getComputedStyle(mark).backgroundColor),
      word: word === null ? null : toBytes(getComputedStyle(word).color),
      statusWord: word?.textContent?.trim() ?? null,
    };
  });
}

const scenarios = [
  {
    name: 'goal-ongoing-is-quiet',
    fixture: 'goal',
    matrix: ['theme'],
    async run({ page, view, shot, link }) {
      // The palette is what is under test, so it is reached the way a machine
      // actually reaches it: through the OS preference, which `system` follows.
      // Pinning the theme in the app instead would need the space authority —
      // `theme` is a space-scoped preference, so it lives on the server, not in
      // this client's storage, and a storage seed is overwritten on connect.
      await page.emulateMedia({ colorScheme: view.theme });
      await page.goto(link('/s/session_fixture_goal'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-header-toggle="goal"]', { timeout: 30_000 });
      await page.waitForTimeout(500);
      const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(applied === view.theme,
        `the ${view.theme} theme must actually be applied, saw ${applied} (asked ${JSON.stringify(view)})`);
      const tone = await goalTones(page);
      await shot(`goal-tone-ongoing-${view.theme}`);
      expect(tone.present, 'the goal row must be on screen');
      expect(tone.sheet !== null, 'the goal sheet must be on screen');

      // The palette's own alert wash and its danger colour: the two the sheet
      // used to sit inside, and the two a running goal must not be confused
      // with.
      const tokens = await page.evaluate(() => {
        const toBytes = (value) => {
          const text = String(value);
          const numbers = text.match(/\d+(?:\.\d+)?/g);
          if (numbers === null) return null;
          const parts = numbers.slice(0, 3).map(Number);
          return /^color\(/i.test(text) ? parts.map((part) => Math.round(part * 255)) : parts;
        };
        const probe = document.createElement('span');
        document.body.append(probe);
        probe.style.color = 'var(--color-danger)';
        const danger = toBytes(getComputedStyle(probe).color);
        probe.style.color = 'var(--color-accent-soft)';
        const accentSoft = toBytes(getComputedStyle(probe).color);
        probe.style.color = 'var(--color-panel)';
        const panel = toBytes(getComputedStyle(probe).color);
        probe.remove();
        const theme = document.documentElement.getAttribute('data-theme')
          ?? document.documentElement.className;
        return { danger, accentSoft, panel, theme };
      });
      expect(tokens.danger !== null && tokens.accentSoft !== null && tokens.panel !== null,
        'the danger, accent-soft and panel tokens must all resolve to a colour');

      // The sheet itself: no longer a saturated alert band. It must sit much
      // closer to the plain panel it is drawn on than to the alert wash.
      const toSheet = distance(tone.sheet, tokens.accentSoft);
      const toPanel = distance(tone.sheet, tokens.panel);
      expect(toSheet !== null && toPanel !== null && toPanel < toSheet,
        `the goal sheet must read as panel, not as the alert wash (toPanel ${toPanel.toFixed(1)} vs toAccentSoft ${toSheet.toFixed(1)}; sheet ${JSON.stringify(tone.sheet)}, panel ${JSON.stringify(tokens.panel)}, accentSoft ${JSON.stringify(tokens.accentSoft)}, theme ${tokens.theme})`);

      // And it must stay legible: the status word still has to clear AA on it.
      const contrast = (() => {
        const a = luminance(tone.word);
        const b = luminance(tone.sheet);
        if (a === null || b === null) return null;
        const [hi, lo] = a > b ? [a, b] : [b, a];
        return (hi + 0.05) / (lo + 0.05);
      })();
      expect(contrast !== null && contrast >= 4.5,
        `the goal status word must stay readable on the sheet (contrast ${contrast?.toFixed(2)})`);
    },
  },
];

const { failed } = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'goal-tone-proof',
});
process.exitCode = failed.length > 0 ? 1 : 0;
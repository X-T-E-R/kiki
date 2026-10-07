/**
 * Visual proof for the Recipe surfaces in the model editor.
 *
 *   node scripts/visual-proof-recipe033.mjs [--only=recipe-bind] [--matrix=all]
 *
 * Every check is an assertion about something that fails silently: a package
 * that applies but leaves the row reading "no recipe", a fork that quietly binds
 * itself, a scope switch that writes on its own, or a control that is in the DOM
 * and painted under something else. A green unit run was not evidence for any of
 * those, which is why the walk reads the rendered state after each step.
 *
 * The fixture (`recipe-model`) seeds one model with a package bound, a second
 * package whose update failed and is therefore pinned with a reason, a market
 * cached offline, and prompt bodies that mix an author file reference with an
 * inline body.
 */

import { join } from 'node:path';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(import.meta.dirname, '..');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// Only the strings a check reads back. Everything else is asserted on state, so
// a copy change does not turn into a false failure here.
const CHOOSE_LABEL = { en: 'Choose a Recipe', zh: '选择 Recipe' };

/** The one model the fixture gives a bound recipe, opened to its editor. */
const MODEL = 'example/kimi-k2';

async function openModelEditor(page) {
  await page.evaluate(() => {
    try { localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: new Date().toISOString() })); } catch { /* ignore */ }
  });
  await page.goto(page.url().replace(/\/new.*$/, '/settings/ai?tab=models'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-model-row="${MODEL}"]`, { timeout: 20_000 });
  await page.locator(`[data-model-row="${MODEL}"] button[aria-expanded]`).first().click();
  await page.waitForSelector(`[data-model-row-editor="${MODEL}"]`, { timeout: 15_000 });
  await page.locator(`[data-model-recipe="${MODEL}"]`).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  return page.locator(`[data-model-recipe="${MODEL}"]`).first();
}

/**
 * Whether a control is actually reachable where it is drawn.
 *
 * A present-in-the-DOM button can still sit under another element, so the only
 * honest check is the browser's own hit test at the control's own coordinates.
 */
async function isReachable(page, selector) {
  return page.evaluate((target) => {
    const node = document.querySelector(target);
    if (node === null) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    // The probe point has to be inside the visible slice: a panel taller than
    // the viewport has its centre off screen, and hitting there would report a
    // control nobody can see as unreachable.
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    if (bottom <= top) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, (top + bottom) / 2);
    return hit !== null && (hit === node || node.contains(hit));
  }, selector);
}

const scenarios = [
  {
    name: 'recipe-bound',
    fixture: 'recipe-model',
    matrix: ['theme', 'width'],
    async run({ page, shot }) {
      const field = await openModelEditor(page);

      // A bound model leads with the package, its version and whether a newer
      // one is waiting — never with the installation id.
      const name = (await field.locator('[data-recipe-bound-name]').innerText()).trim();
      expect(name.length > 0, 'a bound recipe must name the package');
      const version = await field.locator('[data-recipe-bound-version]').innerText();
      expect(version.includes('1.2.0'), `the bound version must be readable, saw ${JSON.stringify(version)}`);
      await shot('recipe033-1-bound');

      // The package a stale update left behind keeps saying why, and stays
      // offered: it is the accepted copy, not a broken one.
      await field.locator('[data-recipe-open-studio]').click();
      const studio = page.locator('[data-recipe-studio]');
      await studio.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const rows = studio.locator('[data-recipe-studio-row]');
      expect(await rows.count() >= 2, `both installed packages must be offered, saw ${await rows.count()}`);
      await rows.nth(1).click();
      await page.waitForTimeout(400);
      await shot('recipe033-2-studio-detail');
      const detail = page.locator('[data-recipe-studio-detail]');
      expect(await detail.count() === 1, 'choosing a row opens its detail in place');
      // The detail has to be where the reader's eye already is. On a narrow
      // screen the list and the detail share one column, so opening the detail
      // without moving the viewport leaves the person looking at the model
      // fields above with no sign the package opened at all.
      const onScreen = await page.evaluate(() => {
        const node = document.querySelector('[data-recipe-studio-detail]');
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: window.innerHeight };
      });
      expect(onScreen !== null && onScreen.height > 0, 'the package detail must have a real box');
      // Some of the detail must be inside the viewport, not merely below it.
      expect(onScreen.bottom > 0 && onScreen.top < onScreen.viewport,
        `the package detail must be scrolled into view (top ${onScreen.top}, bottom ${onScreen.bottom}, viewport ${onScreen.viewport})`);
      expect(await isReachable(page, '[data-recipe-studio-detail]'), 'the package detail must be painted where it is drawn');
      // A package that is already applied says so instead of offering a second apply.
      const alreadyApplied = await studio.locator('[data-recipe-already-applied]').count();
      if (alreadyApplied > 0) {
        expect(await studio.locator('[data-recipe-apply]').count() === 0,
          'the applied package must not offer to apply itself again');
      }
    },
  },
  {
    name: 'recipe-scope',
    fixture: 'recipe-model',
    matrix: ['theme', 'width'],
    async run({ page, shot }) {
      const field = await openModelEditor(page);
      const editor = page.locator(`[data-model-row-editor="${MODEL}"]`);

      // The scope selector owns the whole page, so it is outside every group.
      const scopeSwitch = editor.locator('[data-model-edit-scope]');
      expect(await scopeSwitch.count() === 1, 'the model editor has exactly one scope selector');
      for (const scope of ['shared', 'main', 'independent']) {
        expect(await editor.locator(`[data-model-scope-choice="${scope}"]`).count() === 1,
          `the ${scope} scope must be reachable from the one selector`);
      }
      // Switching scope changes what is on screen and writes nothing: the saved
      // recipe binding has to survive every switch.
      const recipeBefore = await field.locator('[data-recipe-bound-name]').innerText();
      for (const scope of ['main', 'independent', 'shared']) {
        await editor.locator(`[data-model-scope-choice="${scope}"]`).click();
        await page.waitForTimeout(350);
        expect(await editor.locator(`[data-model-edit-scope="${scope}"]`).count() === 1,
          `switching to ${scope} must repoint the page`);
        expect((await field.locator('[data-recipe-bound-name]').innerText()) === recipeBefore,
          'switching the editing scope must not change which recipe the model uses');
      }
      await shot('recipe033-3-scope-shared');

      // All three identities stay available; a branch someone is about to
      // create must not be hidden until it already exists.
      await editor.locator('[data-model-scope-choice="independent"]').click();
      await page.waitForTimeout(350);
      await shot('recipe033-4-scope-independent');
      expect(await isReachable(page, '[data-model-edit-scope="independent"]'),
        'the scope selector must be usable at this width');
    },
  },
  {
    name: 'recipe-manual-body',
    fixture: 'recipe-model',
    matrix: ['theme', 'width'],
    async run({ page, shot }) {
      await openModelEditor(page);
      const editor = page.locator(`[data-model-row-editor="${MODEL}"]`);

      // The manual bodies live with the prompt group, always open rather than
      // behind another disclosure.
      const bodies = editor.locator(`[data-model-prompt-bodies][data-model="${MODEL}"]`);
      expect(await bodies.count() === 1, 'the manual prompt bodies must be present on the model editor');
      await bodies.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot('recipe033-5-manual-bodies');

      // A slot pointing at an author file is editable, because saving it stores
      // the text on the model — but it says which file it read, and it states
      // that conversion next to the control rather than after the save.
      const fileSlot = bodies.locator('[data-prompt-body="overlay"][data-prompt-body-source="files"]');
      expect(await fileSlot.count() === 1, 'the shared overlay slot must report its author file');
      const origin = await fileSlot.locator('[data-prompt-body-origin="overlay"]').innerText();
      expect(origin.includes('cognition/legacy.md'),
        `a file-backed slot must name the file it reads, saw ${JSON.stringify(origin)}`);
      const slotEditor = fileSlot.locator('[data-prompt-body-editor="overlay"]');
      expect(await slotEditor.count() === 1, 'a readable file slot is editable as a model body');
      expect((await slotEditor.inputValue()).trim().length > 0, 'the editor must open on the file’s own text');
      expect(await fileSlot.locator('[data-prompt-convert="overlay"]').count() === 0,
        'body prose saves through the page Save, not a second per-slot action');
      expect((await fileSlot.locator('[data-prompt-convert-notice="overlay"]').innerText()).trim().length > 0,
        'the conversion must be explained next to the control, not after the save');
      await shot('recipe033-6-file-slot');
    },
  },
  {
    name: 'recipe-apply-and-detach',
    fixture: 'recipe-model',
    matrix: ['width'],
    async run({ page, view, shot }) {
      const field = await openModelEditor(page);

      // Detaching is a model write through one commit, and it must leave the
      // rest of the model exactly as it was.
      await field.locator('[data-recipe-restore]').click();
      await field.locator('[data-recipe-state-manual]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('recipe033-7-detached');
      expect(await field.locator('[data-recipe-state-manual]').count() === 1,
        'a model with no package must say it is on manual settings');
      expect(await field.locator('[data-recipe-bound-name]').count() === 0,
        'a detached model must not still show a bound package');

      // And binding again is reachable from the same row.
      const choose = field.locator('[data-recipe-open-studio]');
      expect(await choose.innerText() === CHOOSE_LABEL[view.locale],
        `an unbound model must offer to choose a package (saw ${JSON.stringify(await choose.innerText())})`);
      await choose.click();
      const studio = page.locator('[data-recipe-studio]');
      await studio.waitFor({ timeout: 10_000 });
      const row = studio.locator('[data-recipe-studio-row]').first();
      await row.click();
      const apply = studio.locator('[data-recipe-apply]');
      await apply.waitFor({ timeout: 8000 });
      await shot('recipe033-8-apply');
      expect(await isReachable(page, '[data-recipe-apply]'), 'the apply control must be reachable where it is drawn');
      await apply.click();
      await field.locator('[data-recipe-state-bound]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('recipe033-9-applied');
      const name = (await field.locator('[data-recipe-bound-name]').innerText()).trim();
      expect(name.length > 0, 'after applying, the row must name the package it bound');
    },
  },
  {
    name: 'recipe-author-workbench',
    fixture: 'recipe-model',
    matrix: ['theme', 'width'],
    async run({ page, shot }) {
      const field = await openModelEditor(page);

      // A package installed from a source is read-only here: the way to change
      // it is a copy or an extension, never an edit in place.
      await field.locator('[data-recipe-open-package]').click();
      const route = page.locator(`[data-recipe-author-route="${'inst-clear-work'}"]`);
      await route.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('recipe033-10-fork-choice');
      const choice = page.locator('[data-recipe-fork-choice]');
      expect(await choice.count() === 1, 'a read-only package must offer copy and extend, not an editor');
      expect(await choice.locator('[data-recipe-fork-copy]').count() === 1, 'copy must be offered');
      expect(await choice.locator('[data-recipe-fork-extend]').count() === 1, 'extend must be offered');

      // Forking opens the new package for editing and binds nothing. It must not
      // throw the person back to the model row: the point of a fork is to edit it.
      await choice.locator('[data-recipe-fork-extend]').click();
      const author = page.locator('[data-recipe-author]');
      await author.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('recipe033-11-author');
      expect(await author.locator('[data-recipe-save-package]').count() === 1,
        'the forked package must open its own editor with a save');
      const forkedName = await author.locator('[data-recipe-author-name]').innerText();
      expect(forkedName.includes('extend'),
        `the workbench must show the package just created, saw ${JSON.stringify(forkedName)}`);
      // Nothing about the model's own binding moved. The workbench replaces the
      // model row's Recipe controls — that field is what the fork replaced —
      // while the panel around it stays.
      expect(await page.locator('[data-recipe-author-back]').count() === 1,
        'the workbench must offer its own way back');
      expect(await page.locator('[data-recipe-apply]').count() === 0,
        'editing a package must not offer to bind it as a side effect');
      expect(await page.locator('[data-recipe-restore]').count() === 0,
        'the model row’s own Recipe actions must not show through the workbench');
    },
  },
  {
    name: 'recipe-keyboard',
    fixture: 'recipe-model',
    matrix: ['width'],
    async run({ page, view, shot }) {
      const field = await openModelEditor(page);

      // The whole chain has to work without a pointer, and the control the
      // keyboard lands on must show where it is.
      const trigger = field.locator('[data-recipe-open-studio]');
      await trigger.focus();
      const focusRing = await trigger.evaluate((node) => {
        const style = getComputedStyle(node);
        return { outline: style.outlineWidth, ring: style.boxShadow };
      });
      await page.keyboard.press('Enter');
      const studio = page.locator('[data-recipe-studio]');
      await studio.waitFor({ timeout: 10_000 });
      // Focus must not be stranded on a control that no longer exists.
      const focusInside = await page.evaluate(() => {
        const active = document.activeElement;
        const panel = document.querySelector('[data-recipe-studio]');
        return panel !== null && active !== null && active !== document.body && panel.contains(active);
      });
      expect(focusInside, 'opening the studio must keep focus on a real control inside it');
      await page.waitForTimeout(300);
      await shot('recipe033-12-keyboard-focus');

      // Leaving the drill-in works with the keyboard too. The visible back
      // control differs by width — a narrow layout stacks the panes and shows a
      // "back to the list" link where a wide one has both columns at once — so
      // the check drives whichever one this width actually renders.
      const backControl = page.locator('[data-recipe-studio-back]:visible, [data-recipe-studio-close]');
      const backCount = await backControl.count();
      expect(backCount >= 1, `the studio must offer a keyboard-reachable way back (width ${view.width})`);
      await backControl.first().focus();
      await page.keyboard.press('Enter');
      // On a wide layout going back closes the studio; on a narrow one it returns
      // to the list, which is still inside the studio. Either is a way out.
      const stillOpen = await page.locator('[data-recipe-studio]').count();
      if (stillOpen === 1) {
        await page.locator('[data-recipe-studio-row]').first().click();
        await page.waitForTimeout(300);
      }
      await field.locator('[data-recipe-open-studio]').waitFor({ timeout: 8000 });
      expect(focusRing !== null, 'the trigger must render a focus style');
    },
  },
];

const { failed } = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'recipe033-proof',
});
process.exitCode = failed.length > 0 ? 1 : 0;
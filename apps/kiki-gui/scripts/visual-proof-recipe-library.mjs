/**
 * Visual proof for the Recipe library's own settings page.
 *
 *   node scripts/visual-proof-recipe-library.mjs [--only=recipe-library] [--matrix=all]
 *
 * The page exists so a package is managed without opening a model first. Each
 * walk reads the rendered state after a step: the list names who uses each
 * package, an edit saved on the page is what a fresh load reads back, a save
 * that lost a revision race keeps the draft, a failed read offers a retry, and
 * the model row links to the same package without writing the model.
 *
 * The fixture (`recipe-model`) seeds three packages: one installed from a
 * source and bound to a model, one local package whose last update failed, and
 * one local package with scripts.
 */

import { join } from 'node:path';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(import.meta.dirname, '..');
const LOCAL = 'inst-review-only';
const BOUND = 'inst-clear-work';
const MODEL = 'example/kimi-k2';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function openLibrary(page, link, query = '') {
  await page.goto(link(`/settings/recipes${query}`), { waitUntil: 'domcontentloaded' });
}

async function systemBody(page) {
  const body = page.locator('[data-recipe-prose-slot="system"] textarea').first();
  await body.waitFor({ timeout: 10_000 });
  return body;
}

const scenarios = [
  {
    name: 'recipe-library',
    fixture: 'recipe-model',
    matrix: ['theme', 'width'],
    async run({ page, link, shot }) {
      await openLibrary(page, link);
      const list = page.locator('[data-recipes-list]');
      await list.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(await list.locator('[data-recipes-row]').count() === 3, 'every installed package must be listed');
      const usedBy = await page.locator(`[data-recipes-used-by="${BOUND}"]`).innerText();
      expect(usedBy.includes(MODEL), `the bound package must name its model, saw ${JSON.stringify(usedBy)}`);
      expect(await page.locator(`[data-recipes-row-error="${LOCAL}"]`).count() === 1,
        'a package whose update failed must say so on its row');
      await shot('recipe-library-1-list');

      // Read first, then edit: the address follows each step.
      await page.locator(`[data-recipes-open="${LOCAL}"]`).click();
      await page.locator(`[data-recipe-package-page="${LOCAL}"]`).waitFor({ timeout: 10_000 });
      expect(page.url().includes(`recipe=${LOCAL}`), `reading a package must address it, saw ${page.url()}`);
      await page.waitForTimeout(300);
      await shot('recipe-library-2-detail');

      await page.locator(`[data-recipe-edit="${LOCAL}"]`).click();
      await page.locator(`[data-recipe-author="${LOCAL}"]`).waitFor({ timeout: 10_000 });
      expect(page.url().includes('view=edit'), `editing must be addressable, saw ${page.url()}`);
      expect(await page.locator('[data-recipe-apply]').count() === 0, 'editing a package must not offer to bind a model');
      const text = 'Read the change, then say what it breaks first.\n';
      await (await systemBody(page)).fill(text);
      await page.locator('[data-recipe-save-package]').click();
      await page.waitForFunction(() => document.querySelector('[data-recipe-save-package]')?.hasAttribute('disabled') === true
        && document.querySelector('[data-recipe-author-failure]') === null, undefined, { timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('recipe-library-3-saved');

      // A fresh load of the same address reads the saved bytes back.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`[data-recipe-author="${LOCAL}"]`).waitFor({ timeout: 15_000 });
      const reread = await (await systemBody(page)).inputValue();
      expect(reread === text, `a reload must read back what was saved, saw ${JSON.stringify(reread)}`);
      await shot('recipe-library-4-reread');
    },
  },
  {
    name: 'recipe-library-recovery',
    fixture: 'recipe-model',
    matrix: ['width'],
    async run({ page, link, control, shot }) {
      await openLibrary(page, link, `?recipe=${LOCAL}&view=edit`);
      await page.locator(`[data-recipe-author="${LOCAL}"]`).waitFor({ timeout: 15_000 });
      const mine = 'My own wording.\n';
      await (await systemBody(page)).fill(mine);
      // Another writer publishes first, changing a file this editor did not touch.
      await control({ action: 'recipe_publish_elsewhere', installation_id: LOCAL, path: 'steer.md', text: 'Their steering.\n' });
      await page.locator('[data-recipe-save-package]').click();
      const conflict = page.locator('[data-recipe-author-conflict]');
      await conflict.waitFor({ timeout: 10_000 });
      expect(await page.locator('[data-recipe-save-package]').isDisabled(), 'a refused save must not be pressed again blind');
      await conflict.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot('recipe-library-5-conflict');

      await page.locator('[data-recipe-conflict-reload]').click();
      await conflict.waitFor({ state: 'detached', timeout: 10_000 });
      expect(await (await systemBody(page)).inputValue() === mine, 'loading the newer copy must keep the draft');
      await page.locator('[data-recipe-save-package]').click();
      await page.waitForFunction(() => document.querySelector('[data-recipe-save-package]')?.hasAttribute('disabled') === true
        && document.querySelector('[data-recipe-author-conflict]') === null
        && document.querySelector('[data-recipe-author-failure]') === null, undefined, { timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('recipe-library-6-rebased-saved');

      // A read that fails offers the read again, and the retry lands on the package.
      await control({ action: 'recipe_read_fail_next', count: 1 });
      await openLibrary(page, link, `?recipe=${LOCAL}`);
      await page.locator('[data-recipe-load-failed]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      await shot('recipe-library-7-load-failed');
      await page.locator('[data-recipe-load-retry]').click();
      await page.locator(`[data-recipe-package-page="${LOCAL}"]`).waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'recipe-library-from-model',
    fixture: 'recipe-model',
    matrix: ['width'],
    async run({ page, link, shot }) {
      await page.goto(link(`/settings/ai?tab=providers&model=${encodeURIComponent(MODEL)}`), { waitUntil: 'domcontentloaded' });
      await page.locator(`[data-model-row-editor="${MODEL}"] [data-model-editor-tab="recipe"]`).click({ timeout: 15_000 });
      const field = page.locator(`[data-model-recipe="${MODEL}"]`).first();
      await field.waitFor({ timeout: 15_000 });
      await field.scrollIntoViewIfNeeded();
      const bound = await field.locator('[data-recipe-bound-name]').innerText();
      await field.locator('[data-recipe-open-library]').click();
      await page.locator(`[data-recipe-package-page="${BOUND}"]`).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('recipe-library-8-from-model');

      // A package installed from a source forks before it edits.
      await page.locator(`[data-recipe-edit="${BOUND}"]`).click();
      await page.locator('[data-recipe-fork-choice]').waitFor({ timeout: 10_000 });
      await shot('recipe-library-9-fork-gate');

      // Browsing the package wrote nothing to the model.
      await page.goto(link(`/settings/ai?tab=providers&model=${encodeURIComponent(MODEL)}`), { waitUntil: 'domcontentloaded' });
      await page.locator(`[data-model-row-editor="${MODEL}"] [data-model-editor-tab="recipe"]`).click({ timeout: 15_000 });
      const again = page.locator(`[data-model-recipe="${MODEL}"]`).first();
      await again.waitFor({ timeout: 15_000 });
      expect((await again.locator('[data-recipe-bound-name]').innerText()) === bound,
        'reading the package from its model must leave the binding as it was');
    },
  },
];

const { failed } = await runProof({
  root: ROOT,
  scenarios,
  argv: process.argv.slice(2),
  label: 'recipe-library-proof',
});
process.exitCode = failed.length > 0 ? 1 : 0;

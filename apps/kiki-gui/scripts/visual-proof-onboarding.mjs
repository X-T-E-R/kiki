/**
 * Visual proof for the first-run onboarding wizard, on the shared runner over
 * the `first-run` fixture (nothing configured, so the wizard auto-opens).
 *
 *   node scripts/visual-proof-onboarding.mjs [--matrix=all] [--only=onboarding-walk]
 *
 * Walk (asserted, not just captured): welcome page (language + appearance)
 * → model (skip) → approvals (Next saves auto) → capabilities → the skill
 * install preview dialog → "Let Kiki set it up" opens a session whose
 * composer holds the /kiki-ops request, unsent. Plus a skip walk: Start on
 * the capabilities page lands on an empty /new. Shots per page, themes
 * light/dark at 1440 (and 390 under --matrix=all).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  en: { next: 'Next', skipModel: 'Skip for now', closeSetup: 'Close setup', ask: 'Let Kiki set it up', cancel: 'Cancel' },
  zh: { next: '下一步', skipModel: '暂时跳过', closeSetup: '关闭引导', ask: '让 Kiki 帮你配置', cancel: '取消' },
};

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function openWizard(page) {
  const wizard = page.locator('[role="dialog"][aria-label]').first();
  await wizard.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(450);
  return wizard;
}

async function toCapabilities(page, wizard, text, shot) {
  await wizard.locator('[data-onboarding-appearance]').waitFor({ timeout: 5000 });
  if (shot !== undefined) await shot('onboarding-1-welcome');
  await wizard.getByRole('button', { name: text.next, exact: true }).click();
  await wizard.locator('[data-connection-choice]').first().waitFor({ timeout: 5000 });
  if (shot !== undefined) await shot('onboarding-2-model');
  await wizard.getByRole('button', { name: text.skipModel, exact: true }).click();
  await wizard.locator('[data-permission-choice]').first().waitFor({ timeout: 5000 });
  expect(await wizard.locator('[data-workspace-choice]').count() === 0, 'no workspace step');
  if (shot !== undefined) await shot('onboarding-3-permissions');
  await wizard.getByRole('button', { name: text.next, exact: true }).click();
  await wizard.locator('[data-onboarding-capabilities]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
}

/** Layout checks that a screenshot alone can miss. */
async function checkCapabilitiesLayout(page, label) {
  const report = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"] [data-onboarding-capabilities]');
    const rows = [...document.querySelectorAll('[data-onboarding-cap]')];
    const overflow = rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map((row) => row.dataset.onboardingCap);
    // The accent and its hover step (the pointer may rest on the button).
    const accentRgb = ['--color-accent', '--color-accent-deep'].map((token) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    });
    const accents = [...document.querySelectorAll('[role="dialog"] button')]
      .filter((button) => accentRgb.includes(getComputedStyle(button).backgroundColor))
      .map((button) => button.textContent);
    return { rows: rows.length, overflow, accents, pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, hasPanel: panel !== null };
  });
  expect(report.hasPanel && report.rows === 9, `${label}: expected 9 capability rows, saw ${report.rows}`);
  expect(report.overflow.length === 0, `${label}: rows overflow ${report.overflow.join(',')}`);
  expect(!report.pageOverflow, `${label}: page overflows horizontally`);
  expect(report.accents.length === 1, `${label}: exactly one accent-filled button, saw ${JSON.stringify(report.accents)}`);
  console.log(`[layout] ${label} ${JSON.stringify(report)}`);
}

async function walk({ page, view, shot }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);
  await toCapabilities(page, wizard, text, shot);
  await checkCapabilitiesLayout(page, `caps ${view.locale} ${view.theme} ${view.width}`);
  await shot('onboarding-4-capabilities');
  // The body scrolls inside the dialog; capture the lower half too.
  await wizard.locator('[data-onboarding-cap="bots"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot('onboarding-4-capabilities-end');

  // Skill install: preview first, confirm writes; cancel here.
  await wizard.locator('[data-cap-install="claude"]').click();
  await page.waitForSelector('[data-host-skill-dialog="ready"] [data-host-skill-path]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('onboarding-4-skill-preview');
  await page.locator('[data-host-skill-dialog] button', { hasText: text.cancel }).click();
  await page.waitForSelector('[data-host-skill-dialog]', { state: 'detached', timeout: 5000 });
  expect(await page.locator('[data-onboarding-capabilities]').count() === 1, 'cancelling the install keeps the wizard on its page');

  // Keyboard focus is visible on a row action.
  await wizard.locator('[data-onboarding-cap="ssh"] [data-cap-ask]').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  await shot('onboarding-4-capabilities-focus');

  // "Let Kiki set it up" → a session with the request pre-filled, unsent.
  await wizard.locator('[data-onboarding-cap="ssh"] [data-cap-ask]').click();
  await page.waitForURL(/\/s\//, { timeout: 15_000 });
  await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 10_000 }).catch(() => undefined);
  const composer = page.locator('textarea').first();
  await composer.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  const draft = await composer.inputValue();
  expect(draft.startsWith('/kiki-ops ') && /SSH/.test(draft), `composer must hold the /kiki-ops SSH request, saw "${draft.slice(0, 80)}"`);
  await shot('onboarding-5-ask-session');
}

/**
 * Leaving the run from its last step. The wizard has no "Start" button: the
 * step's own finish is "Let Kiki set it up", which opens a session, and leaving
 * without one is the close control. This walk is the second one — it must
 * dismiss without starting anything, and without routing anywhere.
 */
async function skip({ page, view }) {
  const text = TEXT[view.locale];
  const wizard = await openWizard(page);
  await toCapabilities(page, wizard, text);
  await wizard.getByRole('button', { name: text.closeSetup, exact: true }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label]', { state: 'detached', timeout: 10_000 });
  expect(page.url().includes('/new'), `closing returns to /new, saw ${page.url()}`);
  expect(await page.locator('textarea').first().inputValue() === '', 'closing leaves the composer empty');
}

const scenarios = [
  { name: 'onboarding-walk', fixture: 'first-run', onboarding: false, matrix: ['theme', 'width'], run: walk },
  { name: 'onboarding-skip', fixture: 'first-run', onboarding: false, run: skip },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'onboarding-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;

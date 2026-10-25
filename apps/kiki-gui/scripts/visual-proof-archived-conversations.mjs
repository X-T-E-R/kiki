/**
 * Visual proof for the archived-conversation page.
 *
 *   node scripts/visual-proof-archived-conversations.mjs [--matrix=all]
 *
 * Partial failures are armed through the fixture's `__control`, so what the
 * page reports as undeleted is observed rather than asserted in the abstract.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const RELEASES = 'session_fixture_arch_releases';
const ROOT_FAMILY = 'session_fixture_arch_root';
const ATTACHED = 'session_fixture_arch_attached';
const SECOND_CHILD = 'session_fixture_arch_second_child';
const PROMOTED = 'session_fixture_arch_promoted';
const LIVE = 'session_fixture_arch_live';
const LIVE_CHILD = 'session_fixture_arch_live_child';
const PARTIAL = 'session_fixture_arch_partial';
const STUCK = 'session_fixture_arch_stuck';
const RELEASES_TEXT = 'Started from the merged changes since 0.3.2.';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every archived row currently on screen, in order. */
async function listedIds(page) {
  return page.$$eval('[data-archive-item]', (rows) => rows.map((row) => row.getAttribute('data-archive-item')));
}

async function openArchive(page, link) {
  await page.goto(link('/archived'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-archive-list]', { timeout: 30_000 });
}

/**
 * Answers whichever confirmation is open. `data-autofocus` only exists on a
 * stacked dialog, so cancelling is addressed by its own affordance: the safe
 * button is the one that is not the confirm action.
 */
async function answer(page, confirm) {
  const panel = page.locator('[role="alertdialog"]').first();
  await panel.waitFor({ timeout: 10_000 });
  const button = confirm
    ? panel.locator('[data-confirm-action="confirm"]')
    : panel.locator('button:not([data-confirm-action])').last();
  await button.click({ timeout: 15_000 });
}

const scenarios = [
  {
    name: 'archive-settings-entry',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await page.goto(link('/settings/sessions'), { waitUntil: 'domcontentloaded' });
      const entry = page.locator('[data-settings-open-archived]');
      await entry.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot('archive-1-settings-entry');

      // First action on the section, and the one that opens a page of its own.
      const cards = await page.$$eval('[data-settings-card]', (nodes) => nodes.map((node) => node.getAttribute('data-settings-card')));
      expect(cards[0] === 'st-card-archived', `the archive entry must lead the section, saw ${cards.join(',')}`);
      expect(cards.includes('st-card-questions'), 'the existing session cards must still be on the page');
      await entry.click();
      await page.waitForSelector('[data-archive-list]', { timeout: 30_000 });
      expect(new URL(page.url()).pathname === '/archived', 'the entry must land on the archive page');
      // And the way back is on the page, not only in history.
      await page.locator('[data-archive-back]').click();
      await page.waitForSelector('[data-settings-open-archived]', { timeout: 30_000 });
      expect(new URL(page.url()).pathname === '/settings/sessions', 'the archive page must be able to return to session settings');
    },
  },
  {
    name: 'archive-list',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await openArchive(page, link);
      const first = page.locator(`[data-archive-open="${ROOT_FAMILY}"]`);
      await first.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot('archive-2-list');

      // A row names the conversation, its workspace and when it was last touched.
      const text = await first.textContent();
      expect(text.includes('Rework the transcript store'), `the row must show its title, saw ${JSON.stringify(text)}`);
      expect(text.includes('workshop'), `the row must show its workspace name, saw ${JSON.stringify(text)}`);
      expect(!text.includes('wd_fixture'), 'a row must not show a workspace id');
      // No card wall: rows are separated by a single hairline above each one
      // after the first, and carry no closed border, no fill and no shadow.
      const shape = await page.$$eval('[data-archive-item]', (rows) => rows.map((row) => {
        const style = getComputedStyle(row);
        return {
          top: style.borderTopWidth, right: style.borderRightWidth,
          bottom: style.borderBottomWidth, left: style.borderLeftWidth,
          background: style.backgroundColor, shadow: style.boxShadow,
        };
      }));
      const closed = shape.filter((row) => row.right !== '0px' || row.bottom !== '0px' || row.left !== '0px');
      expect(closed.length === 0, `a row must not be closed on three sides, saw ${JSON.stringify(closed.slice(0, 2))}`);
      expect(shape.every((row) => row.background === 'rgba(0, 0, 0, 0)'),
        `a row must not carry its own ground, saw ${JSON.stringify(shape.slice(0, 2).map((row) => row.background))}`);
      expect(shape.every((row) => row.shadow === 'none'),
        `a row must not be raised as a card, saw ${JSON.stringify(shape.slice(0, 2).map((row) => row.shadow))}`);
      // The separator exists and is one hairline, not a heavy rule.
      expect(shape.slice(1).every((row) => row.top === '1px'),
        `rows must be separated by one hairline, saw ${JSON.stringify(shape.slice(1, 4).map((row) => row.top))}`);
      expect(shape[0].top === '0px', `the first row has nothing above it, saw ${shape[0].top}`);

      const before = await listedIds(page);
      expect(before.includes(RELEASES), 'the archive must list its conversations');
      expect(!before.includes(LIVE), 'an unarchived conversation has no business in the archive');

      // A second page is reachable, and the whole thing ends where it says.
      await page.locator('[data-archive-load-older]').click();
      await page.waitForSelector('[data-archive-end]', { timeout: 15_000 });
      await page.waitForTimeout(300);
      await shot('archive-3-all-loaded');
      const every = await listedIds(page);
      expect(every.length > before.length, `loading older must add rows, saw ${every.length} after ${before.length}`);
      expect(!(every.includes(LIVE) || every.includes(LIVE_CHILD)),
        `an unarchived conversation must never reach this list, saw ${every.filter((id) => id === LIVE || id === LIVE_CHILD).join(',')}`);
      // Nothing overflows the reading column at the narrow width either.
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1) === false,
        'the archive page must not overflow horizontally');
    },
  },
  {
    name: 'archive-search',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await openArchive(page, link);
      await page.waitForSelector('[data-archive-list]', { timeout: 15_000 });
      const search = page.locator('[data-archive-search]');
      await search.fill('release');
      await page.waitForSelector(`[data-archive-item="${RELEASES}"]`, { timeout: 15_000 });
      await page.waitForTimeout(300);
      await shot('archive-4-search');

      const ids = await listedIds(page);
      expect(ids.length === 1 && ids[0] === RELEASES, `search must narrow to the matching conversation, saw ${ids.join(',')}`);

      await search.fill('nothing matches this');
      await page.waitForSelector('[data-archive-empty]', { timeout: 15_000 });
      await shot('archive-5-search-empty');
      // Its scope is the whole archive, so it does not disappear with the
      // search that misses; and the empty state says how to get back.
      expect(await page.locator('[data-archive-delete-all]').count() === 1,
        'a search miss must keep the operation the search does not scope');
      const empty = await page.locator('[data-archive-empty]').textContent();
      expect(empty.includes('Clear it'), `the empty search state must say how to get back, saw ${JSON.stringify(empty)}`);
      await search.fill('');
      await page.waitForSelector('[data-archive-item="' + RELEASES + '"]', { timeout: 15_000 });
    },
  },
  {
    name: 'archive-open-read',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await openArchive(page, link);
      await page.locator(`[data-archive-open="${RELEASES}"]`).click();
      await page.waitForSelector('[data-agent-workspace-target], [data-transcript]', { timeout: 30_000 });
      await page.waitForTimeout(1200);
      await shot('archive-6-open-archived');

      expect(new URL(page.url()).pathname === `/s/${RELEASES}`, `opening must use the ordinary conversation route, saw ${new URL(page.url()).pathname}`);
      const body = await page.textContent('body');
      expect(body.includes(RELEASES_TEXT), 'an archived conversation must still be readable');
      // Reading is not restoring: nothing on this route may put it back in the
      // ordinary list, and the archive itself does not offer that.
      expect(!body.includes('Unarchive'), 'the read route must not offer to restore the conversation');
    },
  },
  {
    name: 'archive-delete-one-cancel',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await openArchive(page, link);
      const row = page.locator(`[data-archive-delete="${RELEASES}"]`);
      await row.waitFor({ timeout: 15_000 });
      const before = await listedIds(page);
      await row.click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('archive-7-delete-one-confirm');

      // The confirmation names the conversation, what goes with it, and what
      // does not — asserted in the language this view renders.
      const body = await page.locator('[role="alertdialog"]').first().textContent();
      const say = view.locale === 'zh'
        ? {
          conversation: 'Release notes for 0.3.3',
          family: '关联对话会一起删除',
          topLevel: '提升到顶层的对话不会跟着删除',
          undo: '无法撤销',
        }
        : {
          conversation: 'Release notes for 0.3.3',
          family: 'archived conversations attached to it are deleted with it',
          topLevel: 'promoted to the top level are not deleted with it',
          undo: 'no way to undo it',
        };
      for (const [what, phrase] of Object.entries(say)) {
        expect(body.includes(phrase), `the confirmation must state the ${what} (${view.locale}), saw ${JSON.stringify(body)}`);
      }

      await answer(page, false);
      await page.waitForTimeout(500);
      expect((await listedIds(page)).join(',') === before.join(','), 'cancelling must write nothing');
      // And the conversation is still readable, because nothing was deleted.
      const listed = await page.request.get(`${fixtureUrl}/api/sessions/${RELEASES}`);
      expect(listed.ok(), 'the cancelled conversation must still exist on the server');
      await shot('archive-8-after-cancel');
    },
  },
  {
    name: 'archive-delete-one',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, fixtureUrl, view }) {
      await openArchive(page, link);
      await page.locator(`[data-archive-delete="${ROOT_FAMILY}"]`).waitFor({ timeout: 15_000 });
      await page.locator(`[data-archive-delete="${ROOT_FAMILY}"]`).click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await answer(page, true);
      // The attached family member goes with it.
      await page.waitForSelector(`[data-archive-item="${ROOT_FAMILY}"]`, { state: 'detached', timeout: 20_000 });
      await page.waitForSelector(`[data-archive-item="${ATTACHED}"]`, { state: 'detached', timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot('archive-9-after-delete-one');

      const ids = await listedIds(page);
      expect(!ids.includes(ROOT_FAMILY), 'the deleted conversation must leave the list');
      expect(!ids.includes(ATTACHED), 'its attached archived conversation must leave with it');
      expect(ids.includes(PROMOTED), 'the promoted top-level conversation must stay archived and listed');
      expect(ids.includes(LIVE) === false, 'unarchived conversations are never in this list');

      // And it is really gone from the connection, not just from the view.
      const gone = await (await page.request.get(`${fixtureUrl}/api/sessions/${ROOT_FAMILY}`)).json();
      expect(gone.code !== 0, `the deleted conversation must be gone from the server, saw code ${gone.code}`);
      // The held-back row is still readable, which is the whole point of it.
      const held = await (await page.request.get(`${fixtureUrl}/api/sessions/${PROMOTED}`)).json();
      expect(held.code === 0, 'the promoted top-level conversation must still be readable');
    },
  },
  {
    name: 'archive-delete-one-partial',
    fixture: 'archived-conversations',
    async run({ page, shot, link, control, fixtureUrl, view }) {
      await control({ action: 'delete_archived_fail_next', session_id: PARTIAL });
      await openArchive(page, link);
      const row = page.locator(`[data-archive-delete="${PARTIAL}"]`);
      await row.waitFor({ timeout: 15_000 });
      await row.click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await answer(page, true);
      await page.waitForSelector('[data-archive-error]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot('archive-10-delete-one-failed');

      const error = await page.locator('[data-archive-error]').textContent();
      expect(error.includes('Nightly sweep triage'), `the failure must name the conversation, saw ${error}`);
      expect(error.includes('still attached to a live run'), `the failure must say why, saw ${error}`);
      const ids = await listedIds(page);
      expect(ids.includes(PARTIAL), 'a conversation that could not be deleted must still be listed');
      expect(await page.locator('[data-toast-stack] .border-success').count() === 0,
        'a partial result is not a success');
    },
  },
  {
    name: 'archive-delete-family-multi-failure',
    fixture: 'archived-conversations',
    async run({ page, shot, link, control, fixtureUrl, view }) {
      await control({
        action: 'delete_archived_fail_list',
        session_ids: [ATTACHED, SECOND_CHILD],
      });
      await openArchive(page, link);
      const row = page.locator(`[data-archive-delete="${ROOT_FAMILY}"]`);
      await row.waitFor({ timeout: 15_000 });
      await row.click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await answer(page, true);
      await page.waitForSelector('[data-archive-error]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot('archive-14-family-multi-failure');

      const entries = await page.locator('[data-archive-failed-item]').allTextContents();
      expect(entries.length === 2, `each undeleted member is named, saw ${entries.length}: ${JSON.stringify(entries)}`);
      expect(entries.some((line) => line.includes('Rewrite the turn-cursor reader')), `the attached member is named, saw ${JSON.stringify(entries)}`);
      expect(entries.some((line) => line.includes('Second attached reader')), `the second refusal is named, saw ${JSON.stringify(entries)}`);
      for (const line of entries) {
        expect(line.includes('still attached to a live run'), `each entry carries its reason, saw ${JSON.stringify(line)}`);
        // Two entries that could share a title still have to be tellable apart.
        expect(/[a-z]{4}_[a-z0-9_]+/.test(line), `each entry carries its id, saw ${JSON.stringify(line)}`);
      }
      // The root really went; the two refusals are still listed.
      const ids = await listedIds(page);
      expect(!ids.includes(ROOT_FAMILY), 'the deleted root must leave the list');
      expect(ids.includes(ATTACHED), 'a refused member stays listed');
    },
  },
  {
    name: 'archive-delete-all',
    fixture: 'archived-conversations',
    matrix: ['width'],
    async run({ page, shot, link, control, fixtureUrl, view }) {
      await openArchive(page, link);
      // Narrow to one page and one search term first: the bulk action must
      // reach past both.
      await page.locator('[data-archive-load-older]').click();
      await page.waitForSelector('[data-archive-end]', { timeout: 15_000 });
      await page.locator('[data-archive-search]').fill('release');
      await page.waitForSelector(`[data-archive-item="${RELEASES}"]`, { timeout: 15_000 });

      await page.locator('[data-archive-delete-all]').click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('archive-11-delete-all-confirm');
      const body = await page.locator('[role="alertdialog"]').first().textContent();
      expect(body.includes('regardless of the current search or loaded pages'), 'the confirmation must say the search and loaded pages do not narrow its scope');
      expect(body.includes('permanently deletes') && body.includes('It cannot be undone.'), 'the confirmation must say deletion is permanent and cannot be undone');
      expect(body.includes('Unarchived conversations stay.'), 'the confirmation must name the unarchived conversations it keeps');

      await answer(page, true);
      await page.waitForSelector('[data-archive-empty]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot('archive-12-after-delete-all');

      const ids = await listedIds(page);
      expect(ids.length === 0, `clearing the archive must leave nothing behind, saw ${ids.join(',')}`);
      expect(await page.locator('[data-archive-delete-all]').count() === 0,
        'nothing to delete means no bulk action');

      // The live conversations are untouched, and still reachable.
            const list = await (await page.request.get(`${fixtureUrl}/api/sessions?include_archive=true&page_size=100`)).json();
      const remaining = (list.data?.items ?? []).map((session) => session.id);
      expect(remaining.includes(LIVE), 'an unarchived conversation must survive clearing the archive');
      expect(remaining.includes(LIVE_CHILD), 'an unarchived family member must survive too');
      expect(!remaining.includes(PROMOTED), 'every archived conversation is in scope, promoted rows included');
    },
  },
  {
    name: 'archive-delete-all-partial',
    fixture: 'archived-conversations',
    async run({ page, shot, link, control, fixtureUrl, view }) {
      await control({ action: 'delete_all_archived_fail_next', session_id: STUCK });
      await openArchive(page, link);
      await page.locator('[data-archive-delete-all]').waitFor({ timeout: 15_000 });
      await page.locator('[data-archive-delete-all]').click();
      await page.locator('[role="alertdialog"]').first().waitFor({ timeout: 10_000 });
      await answer(page, true);
      await page.waitForSelector('[data-archive-error]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot('archive-13-delete-all-failed');

      const error = await page.locator('[data-archive-error]').textContent();
      expect(error.includes('could not be deleted'), `a partial clear must not read as a success, saw ${error}`);
      const ids = await listedIds(page);
      expect(ids.includes(STUCK), 'the conversation that could not be deleted must still be listed');
      expect(await page.locator('[data-toast-stack] .border-success').count() === 0,
        'a partial clear is not a success');
    },
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'archived-conversations-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
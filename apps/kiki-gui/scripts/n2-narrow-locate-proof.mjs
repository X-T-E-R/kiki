/**
 * N2 narrow 派发处 proof.
 *
 * Below lg the shell hides the rail outright, so the child page carries 派发处
 * in its own ⋯ menu instead. This walks the real production build at 390px
 * through the real route: open the child page -> the menu's first item ->
 * the parent timeline with that child's card in view -> Back to the child.
 *
 *   node scripts/n2-narrow-locate-proof.mjs            # 1 job, 390px
 *
 * The oracle is geometric, not a URL: the reader's own block is measured before
 * the jump and again after the return, and the same block must sit in the same
 * place. The store's own `offset` unit is printed alongside for comparison
 * (it is `scrollOffset - item.start`, opposite in sign to a DOM top).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'session_fixture_subagents';
const CHILD = 'agent-research';
const NARROW = { width: 390, height: 844 };
const SCROLL = '[data-transcript-scroll]';
const ANCHOR_TOLERANCE_PX = 80;

function checks(label) {
  const results = [];
  return {
    ok(name, condition, detail) {
      results.push({ name, condition: condition === true, detail });
      console.log(`[check] ${condition === true ? 'PASS' : 'FAIL'} ${label}/${name} — ${detail}`);
    },
    summary() {
      const failed = results.filter((result) => !result.condition);
      if (failed.length > 0) throw new Error(`${failed.length} check(s) failed: ${failed.map((result) => result.name).join(', ')}`);
    },
  };
}

function page_gap() {
  return new Promise((resolve) => { setTimeout(resolve, 120); });
}

function fillerOps(count, ordinalBase) {
  const at = new Date().toISOString();
  const ops = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = ordinalBase + index;
    const turnId = `p${ordinal}`;
    ops.push({ op: 'turn.upsert', turn: { kind: 'turn', turnId, ordinal, state: 'completed', origin: { kind: 'user' }, prompt: `Filler ${ordinal}`, startedAt: at, endedAt: at } });
    ops.push({ op: 'step.upsert', turnId, step: { kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state: 'completed', startedAt: at, endedAt: at } });
    ops.push({ op: 'frame.upsert', turnId, stepId: `${turnId}.1`, frame: { kind: 'text', frameId: `${turnId}-r`, role: 'assistant', text: `Filler reply ${ordinal}` } });
  }
  return { action: 'emit_transcript', session_id: SID, ops };
}

async function injectSpawn(control) {
  const frame = (value) => control({ action: 'emit_event', session_id: SID, frame: value });
  await frame({ type: 'turn.started', payload: { turnId: 25, origin: { kind: 'user' }, prompt: 'Delegate the fixture work.' } });
  await frame({ type: 'subagent.spawned', payload: { subagentId: CHILD, subagentName: 'Researcher', parentToolCallId: 'call-agent-research', description: 'Map the protocol surface', runInBackground: false } });
  await page_gap();
  await frame({ type: 'subagent.started', payload: { subagentId: CHILD } });
  await page_gap();
  await frame({ type: 'turn.ended', payload: { turnId: 25, reason: 'completed' } });
}

/** Open the agent full-page instead of as a preview tab. */
async function setPanelMode(page, mode) {
  await page.evaluate((value) => {
    const raw = localStorage.getItem('kiki.settings');
    const settings = raw === null ? {} : JSON.parse(raw);
    localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, subagentPanelOpenMode: value }));
  }, mode);
}

async function scrollTop(page) {
  return page.locator(SCROLL).first().evaluate((element) => Math.round(element.scrollTop));
}

async function wheelScroll(page, deltaY) {
  await page.locator(SCROLL).first().hover();
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(450);
  return scrollTop(page);
}

/** Every mounted block's real position, in the same units as `blockTop`. */
async function mountedBlockTops(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-transcript-scroll]');
    if (scroll === null) return {};
    const box = scroll.getBoundingClientRect();
    const tops = {};
    for (const row of scroll.querySelectorAll('[data-transcript-virtual-item]')) {
      for (const block of row.querySelectorAll('[data-block-id]')) {
        const key = block.getAttribute('data-block-id');
        if (key === null || key in tops) continue;
        tops[key] = Math.round(block.getBoundingClientRect().top - box.top);
      }
    }
    return tops;
  });
}

async function blockTop(page, blockId) {
  return page.evaluate((key) => {
    const scroll = document.querySelector('[data-transcript-scroll]');
    if (scroll === null) return null;
    const block = [...document.querySelectorAll(`[data-block-id="${key}"]`)]
      .find((candidate) => candidate.closest('[data-transcript-virtual-item]') !== null) ?? null;
    if (block === null) return null;
    return Math.round(block.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
  }, blockId);
}

/** The anchor the store saved for `pathname`, or null. */
async function savedAnchor(page, pathname) {
  return page.evaluate((want) => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem('kiki.navHistory.v1') ?? 'null');
      const entry = (parsed?.entries ?? []).find((candidate) => candidate.pathname === want);
      const snapshot = (parsed?.snapshots ?? []).find((candidate) => candidate.visitId === entry?.visitId);
      return snapshot?.ui?.timeline?.[JSON.stringify(['session_fixture_subagents', 'agent-research'])]?.anchor
        ?? Object.values(snapshot?.ui ?? {}).map((value) => value?.anchor).find((anchor) => anchor !== undefined) ?? null;
    } catch {
      return null;
    }
  }, pathname);
}

async function visitIndex(page) {
  return page.evaluate(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem('kiki.navHistory.v1') ?? 'null');
      return typeof parsed?.currentIndex === 'number' ? parsed.currentIndex : (parsed?.entries?.length ?? 0) - 1;
    } catch {
      return -1;
    }
  });
}

async function focusInfo(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const scroll = document.querySelector('[data-transcript-scroll]');
    if (active === null) return null;
    return {
      tag: active.tagName.toLowerCase(),
      isBody: active === document.body,
      inTimeline: scroll !== null && (scroll === active || scroll.contains(active)),
    };
  });
}

async function spawnCardInView(page) {
  return page.evaluate((agentId) => {
    const scroll = document.querySelector('[data-transcript-scroll]');
    const card = document.querySelector(`[data-agent-open="${agentId}"]`) ?? document.querySelector(`[data-subagent-id="${agentId}"]`);
    if (scroll === null || card === null) return null;
    const box = scroll.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    return { top: Math.round(rect.top - box.top), height: Math.round(box.height) };
  }, CHILD);
}

async function narrowSpawnLocate({ page, control, link, shot }) {
  const assert = checks('narrow-locate@390');
  await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
  await setPanelMode(page, 'fullscreen');
  await control(fillerOps(8, 10));
  await page.goto(link(`/s/${SID}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SCROLL, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await injectSpawn(control);
  await page.waitForTimeout(1200);

  // The narrow window is the whole point of this walk.
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(600);

  const card = page.locator(`[data-agent-open="${CHILD}"]`).first();
  for (let step = 0; step < 24 && await card.count() === 0; step += 1) await wheelScroll(page, -700);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await card.click();
  await page.waitForURL(new RegExp(`/agent/${CHILD}$`), { timeout: 30_000 });
  await page.waitForSelector(SCROLL, { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // Below lg the rail is gone; the page must not offer a control that cannot
  // open it, and it must keep 派发处 somewhere real instead.
  const toggles = await page.locator('[data-agent-rail-toggle]').count();
  const menuTrigger = page.locator('[data-agent-actions] button').first();
  assert.ok('n2n-1', toggles === 0 && await page.locator('[data-agent-actions]').count() === 1,
    `below lg the child page keeps no rail entry (found ${toggles}) and carries the ⋯ menu`);

  // Give the reader a place to hold, then stabilise the trigger before the
  // measurement: the click must not move the timeline under the oracle.
  await wheelScroll(page, -420);
  await page.waitForTimeout(500);
  const childScroll = await scrollTop(page);
  await menuTrigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const topsBefore = await mountedBlockTops(page);
  const visitBefore = await visitIndex(page);

  await menuTrigger.click();
  await page.waitForTimeout(400);
  const menuItems = await page.locator('[data-agent-actions] [role="menuitem"]').evaluateAll((elements) =>
    elements.map((element) => ({
      label: (element.textContent ?? '').trim(),
      locate: element.hasAttribute('data-agent-locate-spawn'),
      fresh: element.hasAttribute('data-agent-fresh-context'),
    })));
  await shot('n2-narrow-menu');
  const locateItem = menuItems[0];
  assert.ok('n2n-2', locateItem?.locate === true && locateItem.label === 'Show in timeline' && menuItems.some((item) => item.fresh),
    `the ⋯ menu offers 派发处 first and keeps the fresh entry: ${JSON.stringify(menuItems)}`);

  await page.locator('[data-agent-actions] [data-agent-locate-spawn]').click();
  await page.waitForURL(new RegExp(`/s/${SID}$`), { timeout: 30_000 });
  await page.waitForTimeout(2200);
  const cardView = await spawnCardInView(page);
  const visitAfter = await visitIndex(page);
  assert.ok('n2n-3', visitAfter === visitBefore + 1 && cardView !== null && cardView.top >= -8 && cardView.top + 40 <= cardView.height,
    `派发处 pushed one visit (${visitBefore} -> ${visitAfter}) and brought the spawning card into view: ${JSON.stringify(cardView)}`);

  const arrows = page.locator('[aria-label="Back"], [aria-label="返回"]');
  const childAnchor = await savedAnchor(page, `/s/${SID}/agent/${CHILD}`);
  await arrows.first().click();
  await page.waitForURL(new RegExp(`/agent/${CHILD}$`), { timeout: 30_000 });
  await page.waitForTimeout(2200);
  const topBefore = childAnchor?.key === undefined ? undefined : topsBefore[childAnchor.key];
  const topAfter = childAnchor?.key === undefined ? null : await blockTop(page, childAnchor.key);
  const focus = await focusInfo(page);
  await shot('n2-narrow-return');
  assert.ok('n2n-4', topBefore !== undefined && topAfter !== null && Math.abs(topAfter - topBefore) <= ANCHOR_TOLERANCE_PX,
    `Back returns to the child's own reading row: the reader held ${childAnchor?.key} at @${topBefore}, observed @${topAfter} (child scrollTop was ${childScroll}; store unit offset @${childAnchor?.offset})`);
  assert.ok('n2n-5', focus?.isBody === false && focus?.inTimeline === true,
    `after the return the keyboard focus is back on the reading surface: ${JSON.stringify(focus)}`);

  assert.summary();
}

const { failed } = await runProof({
  root: ROOT,
  scenarios: [{ name: 'n2-narrow-locate', fixture: 'subagents', matrix: [], run: narrowSpawnLocate }],
  argv: process.argv.slice(2),
  label: 'n2-narrow-locate-proof',
  distDir: join(ROOT, '.tmp', 'n2-narrow-proof', 'dist'),
});

console.log(`[n2-narrow-locate-proof] screenshots: ${failed.length === 0 ? 'see run output' : 'n/a'}`);
if (failed.length > 0) {
  for (const result of failed) console.error(`  - ${result.id}: ${result.error}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;

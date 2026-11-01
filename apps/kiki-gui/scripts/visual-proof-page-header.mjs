/**
 * Visual proof for the shared top-level page header (`PageChrome.tsx`): every
 * top-level page, with Settings and a conversation as the alignment
 * references, through the headless generic runner in light/dark × zh/en ×
 * wide/narrow. Each page runs on its own fixture scenario; the setup records
 * the header geometry (title, action row and body offsets in viewport pixels)
 * in `<page>/geometry.jsonl` beside the screenshots.
 *
 *   node scripts/visual-proof-page-header.mjs [--tag=after] [--only=memory,personas]
 *
 * Output: .tmp/visual-proof-page-header/<tag>/<page>/<page>--<locale>--<theme>--<viewport>.png
 */

import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `scenario` is the fixture; `waitFor` says the page has its data. */
const PAGES = [
  { name: 'discover', scenario: 'basic-stream', path: '/discover', waitFor: '[data-discovery-page]' },
  { name: 'memory', scenario: 'memory', path: '/memory', waitFor: '[data-memory-page] [data-memory-status]' },
  { name: 'personas', scenario: 'personas', path: '/personas', waitFor: '[data-persona-row]' },
  { name: 'usage', scenario: 'usage-dashboard', path: '/usage', waitFor: '[data-usage-page]' },
  { name: 'cron', scenario: 'cron-manage', path: '/cron', waitFor: '[data-cron-list]' },
  // The `capabilities` scenario reads plugin icons from a checkout of the
  // official plugins; `settings-lists` serves the page from fixture data alone.
  { name: 'capabilities', scenario: 'settings-lists', path: '/capabilities', waitFor: '[data-capabilities-page]' },
  { name: 'activity', scenario: 'activity-inbox', path: '/activity', waitFor: '[data-activity-page]' },
  { name: 'archived', scenario: 'archived-conversations', path: '/archived', waitFor: '[data-archive-search]' },
  { name: 'settings', scenario: 'settings', path: '/settings/appearance', waitFor: '[data-settings-page-title]' },
  { name: 'session', scenario: 'basic-stream', path: '/s/session_fixture_basic', waitFor: 'textarea[data-composer]' },
];

/** Generic-runner setup: wait for the page's data, then record header geometry. */
export default async function setup({ page, route, view, outputDir }) {
  const entry = PAGES.find((candidate) => candidate.name === route.name);
  if (entry !== undefined) await page.waitForSelector(entry.waitFor, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const first = (selectors) => {
      for (const selector of selectors) {
        const rect = box(selector);
        if (rect !== undefined) return rect;
      }
      return undefined;
    };
    const title = first(['[data-page-title]', '[data-settings-page-title]', '[data-discovery-page] header h2', 'header h1', 'header h2']);
    const actions = first(['[data-page-actions]']);
    // The body column is the first page-width container outside the header.
    const column = [...document.querySelectorAll('[class*="max-w-[720px]"], [class*="max-w-[1040px]"], [class*="max-w-[1120px]"]')]
      .find((element) => element.closest('header') === null && element.getBoundingClientRect().width > 0);
    const body = column?.getBoundingClientRect();
    const rel = (rect, key) => (rect === undefined ? null : Math.round(rect[key]));
    return {
      viewportW: window.innerWidth,
      titleTop: rel(title, 'top'),
      titleLeft: rel(title, 'left'),
      actionsTop: rel(actions, 'top'),
      actionsLeft: rel(actions, 'left'),
      bodyLeft: rel(body, 'left'),
      bodyWidth: rel(body, 'width'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  appendFileSync(join(outputDir, 'geometry.jsonl'), `${JSON.stringify({ route: route.name, ...view, ...geometry })}\n`);
}

async function main() {
  const { runGenericVisualProof } = await import('./visual-proof-generic.mjs');
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const tag = flag('tag', 'after');
  const only = flag('only', '') === '' ? null : flag('only', '').split(',');
  let failed = 0;
  for (const entry of PAGES.filter((candidate) => only === null || only.includes(candidate.name))) {
    try {
      await runGenericVisualProof({
        argv: [
          '--name', `page-header-${entry.name}`,
          '--scenario', entry.scenario, '--vite',
          '--route', `${entry.name}=${entry.path}`,
          '--setup', fileURLToPath(import.meta.url),
          '--theme', 'light,dark', '--locale', 'zh,en', '--viewport', 'wide,narrow',
          '--output-dir', join(ROOT, '.tmp', 'visual-proof-page-header', tag, entry.name),
        ],
      });
    } catch (error) {
      failed += 1;
      console.error(`[page-header] ${entry.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

// Not awaited at top level: the runner imports this same file as the setup
// module, and that import would wait forever on an unfinished evaluation.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) void main();

// Token-direction harness: one vite dev server + one fixture server, then
// every page × palette × theme × width × locale. Palettes go through the
// dev-only `?tokens=` overlay; `current` passes `tokens=off`.
//   node scripts/token-preview/shoot.mjs          (all)
//   ONLY_TOKENS=a,b ONLY_PAGES=new node ...       (subset)
// Screenshots land in .tmp/visual_tokens/shots (git-ignored).
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FIXTURE_TOKEN, startFixtureServer } from '../fixture-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const OUT = join(APP, '.tmp', 'visual_tokens', 'shots');
mkdirSync(OUT, { recursive: true });

const freePort = async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v, all) => (v ? v.split(',') : all);

const TOKENS = list(process.env.ONLY_TOKENS, ['current', 'p923', 'a', 'b', 'c']);
const PAGES = {
  session: { path: '/s/session_fixture_act_approval', ready: '[data-session-row]' },
  new: { path: '/new', ready: '[data-session-row]' },
  activity: { path: '/activity', ready: '[data-activity-page]' },
  settings: { path: '/settings/general', ready: '[data-settings-nav-tree]' },
};
const PAGE_NAMES = list(process.env.ONLY_PAGES, Object.keys(PAGES));
const THEMES = list(process.env.ONLY_THEMES, ['light', 'dark']);
const WIDTHS = list(process.env.ONLY_WIDTHS, ['1440', '390']).map(Number);
const LOCALES = list(process.env.ONLY_LOCALES, ['zh', 'en']);

const fixturePort = await freePort();
const webPort = await freePort();
const FIXTURE_URL = `http://127.0.0.1:${fixturePort}`;
const WEB_URL = `http://127.0.0.1:${webPort}`;
const fixture = await startFixtureServer({ port: fixturePort, scenario: 'activity-inbox' });
const vite = spawn('pnpm exec vite', {
  cwd: APP,
  env: { ...process.env, KIKI_GUI_PORT: String(webPort) },
  stdio: 'ignore',
  shell: true,
});
const cleanup = async () => {
  try { execSync(`taskkill /PID ${vite.pid} /F /T`, { stdio: 'ignore' }); } catch { /* gone */ }
  await fixture.stop();
};

let count = 0;
try {
  for (let i = 0; i < 300; i += 1) {
    try { if ((await fetch(WEB_URL)).ok) break; } catch { /* not yet */ }
    await sleep(300);
  }
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  for (const locale of LOCALES) for (const theme of THEMES) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(([th, lc]) => {
      localStorage.setItem('kiki.locale', lc);
      const s = JSON.parse(localStorage.getItem('kiki.settings') ?? '{}');
      localStorage.setItem('kiki.settings', JSON.stringify({ ...s, theme: th }));
      localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ session_fixture_act_read: 7 }));
    }, [theme, locale]);
    const page = await ctx.newPage();
    for (const tokens of TOKENS) for (const name of PAGE_NAMES) {
      const { path, ready } = PAGES[name];
      const q = `server=${encodeURIComponent(FIXTURE_URL)}&token=${FIXTURE_TOKEN}&tokens=${tokens === 'current' ? 'off' : tokens}`;
      await page.goto(`${WEB_URL}${path}?${q}`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      try {
        await page.waitForSelector(width > 500 || name === 'activity' || name === 'settings' ? ready : 'main, [data-activity-page], textarea', { timeout: 60_000 });
      } catch { /* shoot what is there */ }
      const want = tokens === 'current' ? 'off' : tokens;
      try {
        await page.waitForFunction((w) => (document.documentElement.dataset['kikiTokens'] ?? 'off') === w, want, { timeout: 20_000 });
      } catch { /* reported below */ }
      const applied = await page.evaluate(() => document.documentElement.dataset['kikiTokens'] ?? 'off');
      if (applied !== want) throw new Error(`overlay ${want} not applied (got ${applied}) on ${name}`);
      await sleep(900);
      const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim());
      console.log(`${name} ${tokens} ${theme} ${width} ${locale} canvas=${canvas}`);
      const file = `${name}-${tokens}-${theme}-${width}-${locale}.png`;
      await page.screenshot({ path: join(OUT, file) });
      count += 1;
    }
    await ctx.close();
  }
  await browser.close();
  console.log(`shots: ${count} -> ${OUT}`);
} finally {
  await cleanup();
}

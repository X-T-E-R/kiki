import { chromium } from 'playwright';
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const fixture = await startFixtureServer({ port: 58931, scenario: 'basic-stream' });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.addInitScript((locale) => {
  try {
    if (localStorage.getItem('kiki.locale') === null) localStorage.setItem('kiki.locale', locale);
  } catch {}
}, 'zh');
await page.goto(
  `http://localhost:5299/?server=${encodeURIComponent('http://127.0.0.1:58931')}&token=${FIXTURE_TOKEN}`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForSelector('aside', { timeout: 30_000 });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  stored: localStorage.getItem('kiki.locale'),
  sidebarText: document.querySelector('aside')?.innerText?.slice(0, 300),
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: process.env.TEMP + '/kiki-zh-manual.png' });
await browser.close();
await fixture.stop();

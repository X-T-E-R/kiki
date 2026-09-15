import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:45173/zh/', { waitUntil: 'networkidle' });
await page.screenshot({ path: '.tmp/docs-zh-home.png', fullPage: false });
await page.goto('http://localhost:45173/zh/getting-started/installation', { waitUntil: 'networkidle' });
await page.screenshot({ path: '.tmp/docs-zh-install.png', fullPage: false });
await browser.close();

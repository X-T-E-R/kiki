/**
 * Visual and interactive verification for mobile & desktop Markdown reading:
 * walks a realistic session at 320px, 390px, 430px (touch) and 1440px (desktop)
 * across Paper (light) and Inkstone (dark) themes against the live React GUI +
 * FixtureServer.
 *
 *   node apps/kiki-gui/scripts/visual-proof-mobile-reading.mjs
 *
 * Artifacts (screenshots + report.json) are written under apps/kiki-gui/.tmp/mobile-reading/.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';

import { assistantMsg, sessionRecord, userMsg } from '../fixtures/helpers.mjs';
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';
import { applyFixtureTheme } from './lib/theme-preference.mjs';

const guiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(guiRoot, 'dist');
const outputDir = process.env.KIKI_PROOF_OUTPUT_DIR ?? join(guiRoot, '.tmp', 'mobile-reading');
await mkdir(outputDir, { recursive: true });

const SESSION_ID = 'session_mobile_reading';
const STEP_TIMEOUT = 30_000;

// Tall 9:20 mobile screenshot SVG (540x1200) to verify proportional viewport containment without cropping.
const TALL_SCREENSHOT_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="1200" viewBox="0 0 540 1200">',
  '  <rect width="540" height="1200" fill="#fbfaf6"/>',
  '  <rect x="24" y="24" width="492" height="1152" rx="28" fill="#f2efe8" stroke="#c9c2b5" stroke-width="3"/>',
  '  <rect x="56" y="72" width="220" height="26" rx="6" fill="#1b1a17"/>',
  '  <rect x="56" y="122" width="428" height="160" rx="16" fill="#fffdfa" stroke="#ded8cc" stroke-width="2"/>',
  '  <text x="80" y="178" font-family="monospace" font-size="22" fill="#1b1a17">TOP EDGE · 540x1200</text>',
  '  <text x="80" y="224" font-family="sans-serif" font-size="18" fill="#5e5a52">9:20 竖屏截图完整边界校验</text>',
  '  <rect x="56" y="320" width="428" height="540" rx="16" fill="#fffdfa" stroke="#ded8cc" stroke-width="2"/>',
  '  <line x1="88" y1="380" x2="452" y2="800" stroke="#9d6b3b" stroke-width="4" stroke-dasharray="10 8"/>',
  '  <circle cx="270" cy="590" r="68" fill="none" stroke="#1b1a17" stroke-width="4"/>',
  '  <rect x="56" y="900" width="428" height="220" rx="16" fill="#fffdfa" stroke="#ded8cc" stroke-width="2"/>',
  '  <text x="80" y="1068" font-family="monospace" font-size="22" fill="#1b1a17">BOTTOM EDGE · UNCROPPED</text>',
  '</svg>',
].join('');

const TALL_IMAGE_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(TALL_SCREENSHOT_SVG)}`;

const ASSISTANT_MARKDOWN = `已完成 Android 会话阅读层的排版与滚动收敛。在 **Capacitor WebView (SDK 36)** 与桌面浏览器共用同一套 React 19 组件的前提下，窄屏阅读保持单列纸墨留白，不再撑宽整页视口：

- **长标识符与内联路径断词**：遇到超长常量 \`ANDROID_KEYSTORE_PEER_TOKEN_PREFIX_V2_SHA256_VERIFICATION_GUARD\` 或源码定位 \`apps/kiki-gui/src/components/markdown/KikiCodeBlock.tsx:118\` 时，内联代码保持圆角留白并按需折行。
  - **无空格长链接**：直连诊断地址 https://example.test/api/v1/sessions/session_01020304-0506-4708-890a-0b0c0d0e0f10/artifacts/download?signature=0123456789abcdef0123456789abcdef99887766 在 320px 宽度下自然折行。
  - **应用内引用**：可直接跳转至 [关联基础流式验收会话 /s/session_fixture_basic 查看完整步骤记录](/s/session_fixture_basic) 而不破坏段落行高。

> 断联是移动端的常态：已缓存正文保持原位可读，横向超宽内容仅在自身容器内滚动。

| 检查维度 | 320px 紧凑窄屏 | 390px 标准手机屏 | 1440px 桌面宽屏 | 容器行为与无障碍约束 |
| --- | --- | --- | --- | --- |
| 正文与长链接 | 零横向溢出 | 零横向溢出 | 640px 舒适阅读列 | \`overflow-wrap: anywhere\` 保全完整字符 |
| 多列数据宽表 | 局部平滑横滑 | 局部平滑横滑 | 完整平铺展示 | 左右渐隐边缘提示与 \`tabIndex=0\` 键盘可达 |
| 围栏长代码块 | 顶栏复制不挡首行 | 40px 展开收起热区 | 悬停右上角浮现 | \`copyTextToClipboard\` 兼容局域网 HTTP |
| 竖屏高比例截图 | 限高缩放不裁切 | 限高缩放不裁切 | 限高完整展示 | 点击进入 Lightbox 查看 100% 原图细节 |

\`\`\`ts
export async function verifyAndroidPeerSession(endpointUrl: string, bearerToken: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(\`\${endpointUrl.replace(/\\/+$/, '')}/api/healthz\`, {
      method: 'GET',
      headers: {
        authorization: \`Bearer \${bearerToken}\`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } finally {
    clearTimeout(timer);
  }
}
\`\`\`

![Android 9:20 竖屏长截图边界示意](${TALL_IMAGE_DATA_URI})

点击上方长图可在灯箱中双指或按钮缩放查看顶部与底部完整刻度。`;

const fixture = await startFixtureServer({ port: 0, scenario: 'basic-stream' });
const baseSession = fixture.sessions.get('session_fixture_basic');
const SessionCtor = baseSession.constructor;
const seededRecord = sessionRecord(SESSION_ID, {
  title: 'Android 阅读体验验收',
  cwd: 'C:/fixture/workshop',
});
const seededSession = new SessionCtor(seededRecord, {
  messages: [
    userMsg(SESSION_ID, '请检查 320px / 390px 窄屏下的长链接、多列宽表、长代码块与竖屏长图展示。', 4),
    assistantMsg(SESSION_ID, [ASSISTANT_MARKDOWN], 3),
  ],
  has_more: false,
});
seededSession.executionControl = { phase: 'running', agents: [] };
fixture.sessions.set(SESSION_ID, seededSession);

const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function startStatic(dir) {
  const server = createHttpServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      if (pathname === '/__kiki/local-server') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 });
        res.end('{}');
        return;
      }
      let file = normalize(join(dir, pathname));
      if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
        file = join(dir, 'index.html');
      }
      const bytes = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-length': bytes.byteLength,
      });
      res.end(bytes);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => { ready(server); });
  });
}

if (!(process.argv.includes('--no-build') && existsSync(join(distDir, 'index.html')))) {
  await viteBuild({ root: guiRoot, logLevel: 'warn' });
}
const staticServer = await startStatic(distDir);
const webOrigin = `http://127.0.0.1:${staticServer.address().port}`;
const sessionUrl = `${webOrigin}/s/${SESSION_ID}?server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const report = {
  sessionUrl,
  outputDir,
  viewports: {},
  interactions: {},
  errors: [],
};

function check(condition, message) {
  if (!condition) report.errors.push(message);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.waitForTimeout(250);
}

async function waitForMarkdownReady(page) {
  await page.waitForSelector('[data-transcript-scroll]', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('.kiki-md .kiki-md-table-wrap', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('.kiki-md .kiki-cb', { timeout: STEP_TIMEOUT });
  await page.waitForSelector('.kiki-md img.kiki-md-img', { timeout: STEP_TIMEOUT });
  // Wait for lazy Shiki highlighting (`[data-streamdown="code-block-body"]`) to settle too.
  await page.waitForSelector('.kiki-cb [data-streamdown="code-block-body"]', { timeout: STEP_TIMEOUT });
  await settle(page);
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const scrollHost = document.querySelector('[data-transcript-scroll]');
    const md = document.querySelector('[data-assistant-prose] .kiki-md') ?? document.querySelector('.kiki-md');
    const tableWrap = md?.querySelector('.kiki-md-table-wrap');
    const tableScroll = md?.querySelector('.kiki-md-table-scroll');
    const cb = md?.querySelector('.kiki-cb');
    const cbTools = cb?.querySelector('.kiki-cb-tools');
    const cbCopy = cb?.querySelector('.kiki-cb-copy');
    const cbBody = cb?.querySelector('.kiki-cb-body');
    const cbToggle = cb?.querySelector('.kiki-cb-toggle');
    const img = md?.querySelector('img.kiki-md-img');
    const internalLink = md?.querySelector('[data-internal-link]');
    const allAnchors = [...(md?.querySelectorAll('a') ?? [])].filter(
      (el) => el.closest('.kiki-md-table-scroll, .kiki-cb-body, .katex-display, .kiki-md-mermaid') === null,
    );
    const allInlineCodes = [...(md?.querySelectorAll(':not(pre) > code') ?? [])].filter(
      (el) => el.closest('.kiki-md-table-scroll, .kiki-cb-body, .katex-display, .kiki-md-mermaid') === null,
    );

    const vw = window.innerWidth;
    const overflowingInline = [...allAnchors, ...allInlineCodes]
      .map((el) => ({ tag: el.tagName, text: (el.textContent ?? '').slice(0, 32), right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left }))
      .filter((item) => item.right > vw + 1.5 || item.left < -1.5);

    const toolsRect = cbTools?.getBoundingClientRect();
    const bodyRect = cbBody?.getBoundingClientRect();
    const copyRect = cbCopy?.getBoundingClientRect();
    const toggleRect = cbToggle?.getBoundingClientRect();
    const imgRect = img?.getBoundingClientRect();
    const toolsStyle = cbTools ? getComputedStyle(cbTools) : null;

    return {
      resolvedTheme: document.documentElement.dataset.theme ?? null,
      viewportWidth: vw,
      viewportHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      transcriptScrollWidth: scrollHost?.scrollWidth ?? 0,
      transcriptClientWidth: scrollHost?.clientWidth ?? 0,
      mdRight: md?.getBoundingClientRect().right ?? 0,
      overflowingInline,
      internalLinkDisplay: internalLink ? getComputedStyle(internalLink).display : null,
      table: tableScroll
        ? {
            clientWidth: tableScroll.clientWidth,
            scrollWidth: tableScroll.scrollWidth,
            scrollLeft: tableScroll.scrollLeft,
            hasOverflowAttr: tableWrap?.getAttribute('data-overflow-x'),
            canScrollLeft: tableWrap?.getAttribute('data-can-scroll-left'),
            canScrollRight: tableWrap?.getAttribute('data-can-scroll-right'),
            tabIndex: tableScroll.getAttribute('tabindex'),
          }
        : null,
      codeBlock: cb
        ? {
            collapsedAttr: cb.getAttribute('data-collapsed'),
            toolsPosition: toolsStyle?.position ?? null,
            toolsOpacity: toolsStyle?.opacity ?? null,
            toolsBottom: toolsRect?.bottom ?? 0,
            bodyTop: bodyRect?.top ?? 0,
            toolsOverlapsBody: toolsRect && bodyRect ? toolsRect.bottom > bodyRect.top + 1.5 : null,
            copyHeight: copyRect?.height ?? 0,
            toggleHeight: toggleRect?.height ?? 0,
            bodyClientWidth: cbBody?.clientWidth ?? 0,
            bodyScrollWidth: cbBody?.scrollWidth ?? 0,
            bodyScrollLeft: cbBody?.scrollLeft ?? 0,
            expandedAttr: cbToggle?.getAttribute('aria-expanded') ?? null,
          }
        : null,
      image: imgRect
        ? {
            width: Math.round(imgRect.width),
            height: Math.round(imgRect.height),
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            aspectRatioDiff:
              img.naturalHeight > 0
                ? Math.abs(imgRect.width / imgRect.height - img.naturalWidth / img.naturalHeight)
                : 0,
          }
        : null,
    };
  });
}

async function scrollElementIntoTranscriptView(page, selector, block = 'start') {
  await page.evaluate(
    ({ sel, align }) => {
      const target = document.querySelector(sel);
      target?.scrollIntoView({ block: align, behavior: 'instant' });
    },
    { sel: selector, align: block },
  );
  await settle(page);
}

async function runMobilePass({ width, height, theme, namePrefix }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    report.errors.push(`${namePrefix} pageerror: ${error.message}`);
  });

  await page.addInitScript(
    ({ selectedTheme }) => {
      localStorage.setItem('kiki.locale', 'zh');
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: selectedTheme }));
      // Simulate Android HTTP LAN WebView: navigator.clipboard is undefined, testing execCommand fallback!
      const copied = [];
      Object.defineProperty(window, '__lanCopied', { value: copied, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const origExec = document.execCommand?.bind(document);
      document.execCommand = (cmd) => {
        if (cmd === 'copy') {
          const active = document.activeElement;
          if (active && 'value' in active) copied.push(String(active.value));
          return true;
        }
        return origExec ? origExec(cmd) : false;
      };
    },
    { selectedTheme: theme },
  );

  await applyFixtureTheme(endpoint, theme, FIXTURE_TOKEN);
  await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
  await waitForMarkdownReady(page);

  // 1. Scroll to top of assistant prose & capture
  await scrollElementIntoTranscriptView(page, '.kiki-md', 'start');
  await page.screenshot({ path: join(outputDir, `${namePrefix}-01-prose-links.png`) });

  // 2. Scroll to table + code block so lazy Shiki highlighting settles inside viewport, then measure & capture
  await scrollElementIntoTranscriptView(page, '.kiki-md-table-wrap', 'start');
  await page.waitForSelector('.kiki-cb pre code span', { timeout: STEP_TIMEOUT });
  await settle(page);
  const metrics = await measureLayout(page);
  report.viewports[namePrefix] = metrics;

  check(
    metrics.resolvedTheme === theme,
    `${namePrefix}: expected resolved theme '${theme}', got '${metrics.resolvedTheme}'`,
  );
  check(
    metrics.docScrollWidth <= metrics.viewportWidth,
    `${namePrefix}: document horizontal overflow (${metrics.docScrollWidth} > ${metrics.viewportWidth})`,
  );
  check(
    metrics.transcriptScrollWidth <= metrics.transcriptClientWidth + 1,
    `${namePrefix}: transcript horizontal overflow (${metrics.transcriptScrollWidth} > ${metrics.transcriptClientWidth})`,
  );
  check(
    metrics.overflowingInline.length === 0,
    `${namePrefix}: inline elements overflowed viewport: ${JSON.stringify(metrics.overflowingInline)}`,
  );
  check(
    metrics.internalLinkDisplay === 'inline',
    `${namePrefix}: expected internal link display 'inline', got ${metrics.internalLinkDisplay}`,
  );
  check(
    metrics.table?.hasOverflowAttr === 'true' && metrics.table?.canScrollRight === 'true',
    `${namePrefix}: wide table did not activate local horizontal scroll cue: ${JSON.stringify(metrics.table)}`,
  );
  check(
    metrics.codeBlock?.toolsPosition === 'static' && metrics.codeBlock?.toolsOverlapsBody === false,
    `${namePrefix}: touch code block tools overlapped body or stayed absolute: ${JSON.stringify(metrics.codeBlock)}`,
  );
  check(
    (metrics.codeBlock?.bodyScrollWidth ?? 0) > (metrics.codeBlock?.bodyClientWidth ?? 0) + 50,
    `${namePrefix}: wide code block did not expose horizontal scroll width: ${JSON.stringify(metrics.codeBlock)}`,
  );
  check(
    (metrics.codeBlock?.toggleHeight ?? 0) >= 38,
    `${namePrefix}: code toggle touch height too small (${metrics.codeBlock?.toggleHeight})`,
  );
  check(
    (metrics.image?.height ?? 999) <= Math.min(height * 0.62, 405) && (metrics.image?.aspectRatioDiff ?? 1) < 0.03,
    `${namePrefix}: tall image exceeded mobile height cap or distorted aspect ratio: ${JSON.stringify(metrics.image)}`,
  );

  await page.screenshot({ path: join(outputDir, `${namePrefix}-02-table-code.png`) });

  if (width === 390 && theme === 'light') {
    // Exercise horizontal scroll on the wide table and verify left+right cues
    await page.evaluate(() => {
      const scroller = document.querySelector('.kiki-md-table-scroll');
      if (scroller) scroller.scrollLeft = 180;
    });
    await page.waitForTimeout(150);
    const afterTableScroll = await measureLayout(page);
    report.interactions.tableScrolled390 = afterTableScroll.table;
    check(
      afterTableScroll.table?.canScrollLeft === 'true' && afterTableScroll.table?.canScrollRight === 'true',
      `390-light: table mid-scroll cues missing: ${JSON.stringify(afterTableScroll.table)}`,
    );
    check(
      afterTableScroll.docScrollWidth <= afterTableScroll.viewportWidth,
      '390-light: scrolling table leaked into document width',
    );
    await page.screenshot({ path: join(outputDir, `${namePrefix}-03-table-scrolled.png`) });

    // Exercise code copy over simulated HTTP LAN (no navigator.clipboard) + code expand + horizontal code scroll
    await scrollElementIntoTranscriptView(page, '.kiki-cb', 'start');
    await page.locator('.kiki-cb-copy').tap();
    await page.waitForTimeout(150);
    const lanCopied = await page.evaluate(() => window.__lanCopied);
    report.interactions.lanCodeCopy = {
      count: lanCopied.length,
      startsWithSignature: (lanCopied[0] ?? '').startsWith('export async function verifyAndroidPeerSession'),
    };
    check(
      report.interactions.lanCodeCopy.count === 1 && report.interactions.lanCodeCopy.startsWithSignature,
      `390-light: HTTP LAN code copy fallback failed: ${JSON.stringify(report.interactions.lanCodeCopy)}`,
    );

    await page.locator('.kiki-cb-toggle').tap();
    await settle(page);
    await page.evaluate(() => {
      const cbBody = document.querySelector('.kiki-cb-body');
      if (cbBody) cbBody.scrollLeft = 160;
    });
    await page.waitForTimeout(120);
    const expandedCode = await measureLayout(page);
    report.interactions.codeExpanded390 = expandedCode.codeBlock;
    check(
      expandedCode.codeBlock?.expandedAttr === 'true' &&
        expandedCode.codeBlock?.collapsedAttr === null &&
        (expandedCode.codeBlock?.bodyScrollLeft ?? 0) >= 100,
      `390-light: code block did not expand & scroll horizontally cleanly: ${JSON.stringify(expandedCode.codeBlock)}`,
    );
    await page.screenshot({ path: join(outputDir, `${namePrefix}-04-code-expanded-copied.png`) });

    // Scroll to tall image, capture bounded inline view, then tap to verify Lightbox opens full image
    await scrollElementIntoTranscriptView(page, '.kiki-md-img-trigger', 'center');
    await page.screenshot({ path: join(outputDir, `${namePrefix}-05-tall-image-bounded.png`) });

    await page.locator('.kiki-md-img-trigger').tap();
    await page.waitForSelector('[role="dialog"]', { timeout: STEP_TIMEOUT });
    await settle(page);
    report.interactions.lightboxOpened390 = true;
    await page.screenshot({ path: join(outputDir, `${namePrefix}-06-image-lightbox.png`) });
  }

  if (width === 320 && theme === 'dark') {
    await scrollElementIntoTranscriptView(page, '.kiki-md-img-trigger', 'center');
    await page.screenshot({ path: join(outputDir, `${namePrefix}-03-tall-image.png`) });
  }

  await context.close();
}

async function runDesktopPass({ theme, namePrefix }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    report.errors.push(`${namePrefix} pageerror: ${error.message}`);
  });
  await page.addInitScript(
    ({ selectedTheme }) => {
      localStorage.setItem('kiki.locale', 'zh');
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: selectedTheme }));
    },
    { selectedTheme: theme },
  );

  await applyFixtureTheme(endpoint, theme, FIXTURE_TOKEN);
  await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
  await waitForMarkdownReady(page);
  await scrollElementIntoTranscriptView(page, '.kiki-md', 'start');

  const idleMetrics = await measureLayout(page);
  report.viewports[namePrefix] = idleMetrics;

  check(
    idleMetrics.resolvedTheme === theme,
    `${namePrefix}: expected resolved theme '${theme}', got '${idleMetrics.resolvedTheme}'`,
  );

  check(
    idleMetrics.codeBlock?.toolsPosition === 'absolute' && idleMetrics.codeBlock?.toolsOpacity === '0',
    `${namePrefix}: desktop code block lost quiet hover-reveal corner tools: ${JSON.stringify(idleMetrics.codeBlock)}`,
  );

  // Hover code block to confirm corner tools reveal on desktop
  await scrollElementIntoTranscriptView(page, '.kiki-cb', 'center');
  await page.locator('.kiki-cb').hover();
  await page.waitForTimeout(200);
  const hoverOpacity = await page.evaluate(() => {
    const tools = document.querySelector('.kiki-cb-tools');
    return tools ? getComputedStyle(tools).opacity : null;
  });
  check(hoverOpacity === '1', `${namePrefix}: desktop code block tools did not reveal on hover (opacity=${hoverOpacity})`);

  await page.screenshot({ path: join(outputDir, `${namePrefix}-01-desktop-overview.png`) });
  await context.close();
}

try {
  await runMobilePass({ width: 320, height: 690, theme: 'light', namePrefix: 'mobile-320-light' });
  await runMobilePass({ width: 320, height: 690, theme: 'dark', namePrefix: 'mobile-320-dark' });
  await runMobilePass({ width: 390, height: 844, theme: 'light', namePrefix: 'mobile-390-light' });
  await runMobilePass({ width: 390, height: 844, theme: 'dark', namePrefix: 'mobile-390-dark' });
  await runMobilePass({ width: 430, height: 932, theme: 'light', namePrefix: 'mobile-430-light' });
  await runDesktopPass({ theme: 'light', namePrefix: 'desktop-1440-light' });
  await runDesktopPass({ theme: 'dark', namePrefix: 'desktop-1440-dark' });
} catch (error) {
  report.errors.push(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await new Promise((done) => { staticServer.close(done); });
  await fixture.stop();
}

console.log(JSON.stringify({ outputDir, errorCount: report.errors.length, errors: report.errors, interactions: report.interactions }, null, 2));
if (report.errors.length > 0) {
  process.exitCode = 1;
}

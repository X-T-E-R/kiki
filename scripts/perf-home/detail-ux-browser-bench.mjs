import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import {
  assertKapServerWebAssets,
  createWebAssetsAuditRecorder,
  evaluateWebAssetsBudget,
} from '../ccp-chaos/web-assets-bridge.mjs';
import { roundMs } from './stats.mjs';

const kapRequire = createRequire(new URL('../../packages/kap-server/package.json', import.meta.url));
const { chromium } = kapRequire('playwright');

function installLongTaskProbe() {
  const state = { longTasks: [], rafGaps: [] };
  window.__kikiDetailPerfProbe = {
    reset() {
      state.longTasks = [];
      state.rafGaps = [];
    },
    drain() {
      const durations = state.longTasks.map((t) => t.duration);
      const maxLongTaskMs = durations.length > 0 ? Math.max(...durations) : 0;
      const totalBlockingTimeMs = durations.reduce((acc, d) => acc + Math.max(0, d - 50), 0);
      const maxRafGapMs = state.rafGaps.length > 0 ? Math.max(...state.rafGaps) : 0;
      const out = {
        longTaskCount: durations.length,
        maxLongTaskMs: Number(maxLongTaskMs.toFixed(2)),
        totalBlockingTimeMs: Number(totalBlockingTimeMs.toFixed(2)),
        maxRafGapMs: Number(maxRafGapMs.toFixed(2)),
      };
      state.longTasks = [];
      state.rafGaps = [];
      return out;
    },
  };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {}
  let prev = performance.now();
  const loop = (now) => {
    const gap = now - prev;
    prev = now;
    if (gap > 32) state.rafGaps.push(gap);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export async function runDetailUxBrowserSuite({
  endpoint,
  token,
  fixtures,
  gallerySession,
  browserClones,
  clearServerMediaPreviewCache,
  buildInfo = null,
  progress,
}) {
  progress('verifying kap-server native webAssets for Playwright...');
  const webInfo = await assertKapServerWebAssets(endpoint);
  const webUrl = webInfo.webUrl;
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });

  const deepLink = (routePath) =>
    `${webUrl}${routePath}?server=${encodeURIComponent(endpoint)}&token=${encodeURIComponent(token)}`;

  const metrics = {
    servedByKapServer: true,
    guiBuildReusedCache: buildInfo?.reusedCache ?? null,
    guiBuildMs: buildInfo?.buildMs ?? 0,
    webAssetsAudit: null,
    webAssetsGate: null,
    imagesAndLightbox: {},
    composerAndPreview: {},
    sidebarAndMenus: {},
  };
  let webAssetsRecorder = null;

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('kiki.locale', 'en');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch {}
    });
    await context.addInitScript(installLongTaskProbe);
    const page = await context.newPage();
    webAssetsRecorder = createWebAssetsAuditRecorder(page, endpoint);

    progress('Playwright 1/3: measuring 12-image turn paint (cold + warm) & MediaLightbox naturalWidth > 0...');
    if (typeof clearServerMediaPreviewCache === 'function') {
      await clearServerMediaPreviewCache();
    }
    await page.evaluate(() => window.__kikiDetailPerfProbe?.reset?.()).catch(() => {});
    const coldGalleryT0 = performance.now();
    await page.goto(deepLink(`/s/${encodeURIComponent(gallerySession.sessionId)}`), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForFunction(
      (minCount) => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (!scroller) return false;
        const imgs = [...scroller.querySelectorAll('img')];
        if (imgs.length < minCount) return false;
        return imgs.slice(0, minCount).every((img) => img.complete && img.naturalWidth > 0);
      },
      12,
      { timeout: 45_000 },
    );
    const turn12ColdPaintMs = roundMs(performance.now() - coldGalleryT0);
    const turn12ColdProbe = await page.evaluate(() => window.__kikiDetailPerfProbe?.drain?.());

    await page.evaluate(() => window.__kikiDetailPerfProbe?.reset?.());
    const firstThumb = page.locator('[data-transcript-scroll] img').first();
    const lightboxOpenT0 = performance.now();
    await firstThumb.click();
    await page.waitForFunction(
      () => {
        const img = document.querySelector('[data-lightbox-viewport] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      null,
      { timeout: 30_000 },
    );
    const lightboxOpenPaintMs = roundMs(performance.now() - lightboxOpenT0);

    const prevSrc = await page.evaluate(
      () => document.querySelector('[data-lightbox-viewport] img')?.getAttribute('src') ?? '',
    );
    const nextBtn = page.locator('[role="dialog"] button[aria-label="Next image"]').first();
    const lightboxNextT0 = performance.now();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
    } else {
      await page.locator('[data-lightbox-viewport]').focus();
      await page.keyboard.press('ArrowRight');
    }
    await page.waitForFunction(
      (oldSrc) => {
        const img = document.querySelector('[data-lightbox-viewport] img');
        return Boolean(img && img.getAttribute('src') !== oldSrc && img.complete && img.naturalWidth > 0);
      },
      prevSrc,
      { timeout: 30_000 },
    );
    const lightboxNextPaintMs = roundMs(performance.now() - lightboxNextT0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-lightbox-viewport]', { state: 'detached', timeout: 10_000 });

    await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-composer-toolbar]', { timeout: 30_000 });
    const warmGalleryT0 = performance.now();
    await page.goto(deepLink(`/s/${encodeURIComponent(gallerySession.sessionId)}`), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForFunction(
      (minCount) => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (!scroller) return false;
        const imgs = [...scroller.querySelectorAll('img')];
        return imgs.length >= minCount && imgs.slice(0, minCount).every((img) => img.complete && img.naturalWidth > 0);
      },
      12,
      { timeout: 45_000 },
    );
    const turn12WarmPaintMs = roundMs(performance.now() - warmGalleryT0);

    metrics.imagesAndLightbox = {
      turn12ImagesColdPaintMs: turn12ColdPaintMs,
      turn12ImagesColdLongTasks: turn12ColdProbe,
      turn12ImagesWarmPaintMs: turn12WarmPaintMs,
      lightboxOpenPaintMs,
      lightboxNextStepPaintMs: lightboxNextPaintMs,
    };

    progress('Playwright 2/3: measuring PreviewWorkspace open (code, markdown+image, PDF) & Composer uploads...');
    const clickLinkAndWait = async (linkText, readyFn) => {
      await page.evaluate(() => window.__kikiDetailPerfProbe?.reset?.());
      const link = page.locator('[data-transcript-scroll] a, [data-transcript-scroll] button', { hasText: linkText }).last();
      const t0 = performance.now();
      await link.click();
      await page.waitForFunction(readyFn, null, { timeout: 30_000 });
      const elapsedMs = roundMs(performance.now() - t0);
      const probe = await page.evaluate(() => window.__kikiDetailPerfProbe?.drain?.());
      return { elapsedMs, probe };
    };

    const codeOpen = await clickLinkAndWait(
      'engine.ts',
      () => Boolean(document.querySelector('.cm-content') && document.querySelector('.cm-content').textContent.length > 20),
    );
    const mdOpen = await clickLinkAndWait(
      'architecture.md',
      () => {
        const md = document.querySelector('[data-preview-scroll]');
        if (!md) return false;
        const img = md.querySelector('img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
    );
    const pdfOpen = await clickLinkAndWait(
      'spec.pdf',
      () => {
        if (document.querySelector('[data-pdf-page][data-state="ready"]')) return true;
        const img = document.querySelector('[data-preview-document] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
    );

    await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const fileInput = page.locator('[data-composer-toolbar] input[type="file"]:not([disabled])').first();
    await page.waitForSelector('[data-composer-toolbar]', { timeout: 30_000 });

    const clearComposerChips = async () => {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('[data-attachment-chips] button');
        for (const b of btns) {
          if ((b.getAttribute('aria-label') || '').toLowerCase().includes('remove')) b.click();
        }
      });
    };

    const waitChipsSettled = async (expectedCount) => {
      await page.waitForFunction(
        (count) => {
          const err = document.querySelector('[data-attachment-error]');
          if (err) throw new Error(`Composer attachment error: ${err.textContent}`);
          const chips = document.querySelector('[data-attachment-chips]');
          if (!chips || chips.children.length < count) return false;
          return !document.querySelector('[data-attachment-reading], [data-attachment-uploading]');
        },
        expectedCount,
        { timeout: 30_000 },
      );
    };

    await page.evaluate(() => window.__kikiDetailPerfProbe?.reset?.());
    const attach1xT0 = performance.now();
    await fileInput.setInputFiles([fixtures.single5MbPngPath]);
    await waitChipsSettled(1);
    const attach1x5MbMs = roundMs(performance.now() - attach1xT0);
    const attach1xProbe = await page.evaluate(() => window.__kikiDetailPerfProbe?.drain?.());
    await clearComposerChips();

    await page.evaluate(() => window.__kikiDetailPerfProbe?.reset?.());
    const attach6xT0 = performance.now();
    await fileInput.setInputFiles(fixtures.sixScreenshotPaths ?? fixtures.galleryPngPaths.slice(0, 6));
    await waitChipsSettled(6);
    const attach6xMs = roundMs(performance.now() - attach6xT0);
    const attach6xProbe = await page.evaluate(() => window.__kikiDetailPerfProbe?.drain?.());
    await clearComposerChips();

    const attachMixedT0 = performance.now();
    await fileInput.setInputFiles([fixtures.uploadPdfPath, fixtures.upload1MbCodePath]);
    await waitChipsSettled(2);
    const attachPdfAndCodeMs = roundMs(performance.now() - attachMixedT0);
    await clearComposerChips();

    metrics.composerAndPreview = {
      previewOpenCodeMs: codeOpen.elapsedMs,
      previewOpenMarkdownWithLocalImageMs: mdOpen.elapsedMs,
      previewOpenPdfFirstPageMs: pdfOpen.elapsedMs,
      composerAttach1x5MbPngMs: attach1x5MbMs,
      composerAttach1xLongTasks: attach1xProbe,
      composerAttach6xScreenshotsMs: attach6xMs,
      composerAttach6xLongTasks: attach6xProbe,
      composerAttachPdfAnd1MbCodeMs: attachPdfAndCodeMs,
    };

    progress('Playwright 3/3: measuring Sidebar rename, pin, archive, /archived restore, @ mention & / slash...');
    await page.goto(deepLink(`/s/${encodeURIComponent(browserClones.coldComposerMega.sessionId)}`), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
    const cmInput = page.locator('[data-composer-card] .composer-input .cm-content').first();
    await cmInput.waitFor({ state: 'visible', timeout: 30_000 });

    await cmInput.click();
    const slashOpenT0 = performance.now();
    await page.keyboard.type('/');
    await page.waitForSelector('[data-composer-menu] [role="option"]', { timeout: 15_000 });
    const slashMenuOpenMs = roundMs(performance.now() - slashOpenT0);

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    const atOpenT0 = performance.now();
    await page.keyboard.type('@feature_04');
    await page.waitForSelector('[data-composer-menu] [data-mention-file-list] [role="option"], [data-composer-menu] [role="option"]', {
      timeout: 30_000,
    });
    const atMentionOpenMs = roundMs(performance.now() - atOpenT0);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');

    const sidebarId = browserClones.sidebarTargetMega.sessionId;
    const rowSelector = `[data-session-row="${sidebarId}"]`;
    await page.waitForSelector(rowSelector, { timeout: 30_000 });

    const pinBtn = page.locator(`${rowSelector} [data-session-pin-toggle]`).first();
    const pinT0 = performance.now();
    await pinBtn.click({ force: true });
    await page.waitForSelector(`[data-session-group-block="pinned"] ${rowSelector}, ${rowSelector} [data-session-pin-toggle][aria-label^="Unpin"]`, {
      timeout: 30_000,
    });
    const sidebarPinMs = roundMs(performance.now() - pinT0);

    const targetRow = page.locator(rowSelector).first();
    await targetRow.click({ button: 'right' });
    await page.waitForSelector('[data-menu-item="rename"]', { timeout: 10_000 });
    await page.locator('[data-menu-item="rename"]').click();
    const renameInput = page.locator(`[data-rename-editor="${sidebarId}"] [data-rename-input]`);
    await renameInput.waitFor({ state: 'visible', timeout: 10_000 });
    await renameInput.fill('Instant Browser Rename');
    const renameSubmitT0 = performance.now();
    await page.locator(`[data-rename-editor="${sidebarId}"] [data-rename-confirm]`).click();
    await page.waitForSelector(`[data-rename-editor="${sidebarId}"]`, { state: 'detached', timeout: 30_000 });
    const sidebarRenameConfirmMs = roundMs(performance.now() - renameSubmitT0);

    await page.locator(rowSelector).first().click({ button: 'right' });
    await page.waitForSelector('[data-menu-item="archive"]', { timeout: 10_000 });
    const archiveClickT0 = performance.now();
    await page.locator('[data-menu-item="archive"]').click();
    await page.waitForSelector(rowSelector, { state: 'detached', timeout: 30_000 });
    const sidebarArchiveDisappearMs = roundMs(performance.now() - archiveClickT0);

    await page.goto(deepLink('/archived'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector(`[data-archive-item="${sidebarId}"]`, { timeout: 30_000 });
    await page.locator(`[data-archive-more="${sidebarId}"]`).click();
    await page.waitForSelector('[data-archive-action="restore"]', { timeout: 10_000 });
    const restoreClickT0 = performance.now();
    await page.locator('[role="menu"][data-archive-row-menu] [data-archive-action="restore"]').click();
    let archivedPageRestoreDisappearMs = null;
    let archivedPageRestoreStatus = 'ok';
    try {
      await page.waitForFunction(
        (id) => {
          const err = document.querySelector('[data-archive-error]');
          if (err) throw new Error(`Archive restore UI error: ${err.textContent}`);
          return !document.querySelector(`[data-archive-item="${id}"]`);
        },
        sidebarId,
        { timeout: 45_000 },
      );
      archivedPageRestoreDisappearMs = roundMs(performance.now() - restoreClickT0);
    } catch (error) {
      archivedPageRestoreDisappearMs = roundMs(performance.now() - restoreClickT0);
      archivedPageRestoreStatus = `failed: ${String(error?.message ?? error).slice(0, 120)}`;
    }

    metrics.sidebarAndMenus = {
      composerSlashMenuOpenMs: slashMenuOpenMs,
      composerAtMentionOpenColdMegaMs: atMentionOpenMs,
      sidebarPinTogglePerceivedMs: sidebarPinMs,
      sidebarInlineRenameSubmitMs: sidebarRenameConfirmMs,
      sidebarArchiveRowDisappearMs: sidebarArchiveDisappearMs,
      archivedPageRestoreDisappearMs,
      archivedPageRestoreStatus,
    };

    await context.close();
  } finally {
    if (webAssetsRecorder) {
      await webAssetsRecorder.settle();
      metrics.webAssetsAudit = webAssetsRecorder.snapshot();
      metrics.webAssetsGate = evaluateWebAssetsBudget(metrics.webAssetsAudit);
      webAssetsRecorder.detach();
    }
    await browser.close();
  }

  return metrics;
}

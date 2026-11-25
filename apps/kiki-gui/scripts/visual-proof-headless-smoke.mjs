import { join } from 'node:path';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import {
  SID_COMPLEX,
  SID_EXTERNAL,
  SID_FAILED_TAIL,
  SID_PERSONA,
  SID_WORKING,
} from '../fixtures/complex-timeline.scenario.mjs';

const HERO = '[data-phase="hero"]';
const COMPOSER_READY = '[data-composer-input]:not([disabled]):not([aria-disabled="true"])';
const TRANSCRIPT_SCROLL = '[data-transcript-scroll]';

async function applyThemeOnServer({ page, view, serverUrl }) {
  const headers = { authorization: `Bearer ${FIXTURE_TOKEN}` };
  const request = async (path, data) => {
    const url = new URL(`/api${path}`, serverUrl).href;
    const response = data === undefined
      ? await page.request.get(url, { headers })
      : await page.request.post(url, { headers, data });
    const body = await response.json();
    if (!response.ok() || body.code !== 0) {
      throw new Error(`Smoke fixture request failed at ${path}: ${body.msg}`);
    }
    return body.data;
  };
  const meta = await request('/meta');
  if (!meta.current_space_id) throw new Error('Smoke fixture has no space identity');
  const settings = `/homes/${encodeURIComponent(meta.current_space_id)}/settings`;
  const preview = await request(`${settings}/preview`, {
    action: 'edit',
    changes: [{ id: 'pref:theme', value: view.theme }],
  });
  await request(`${settings}/apply`, { token: preview.token, selected: ['pref:theme'] });
}

async function setupHero(ctx) {
  await applyThemeOnServer(ctx);
  await ctx.page.reload({ waitUntil: 'domcontentloaded' });
  await ctx.waitFor(`html[data-theme="${ctx.view.theme}"] ${HERO}`, { timeout: 15_000 });
  await ctx.waitFor(COMPOSER_READY, { timeout: 15_000 });
  await ctx.scroll('top');
}

async function setupComplexTimeline(ctx) {
  const { page, view, outputDir } = ctx;
  await page.waitForSelector(TRANSCRIPT_SCROLL, { timeout: 15_000 });
  await page.waitForSelector('[data-turn-footnote]', { timeout: 15_000 });

  if (view.viewport === 'wide') {
    if ((await page.locator('[data-session-rail]').count()) === 0) {
      const railToggle = page.locator('[data-rail-toggle]').first();
      if ((await railToggle.count()) > 0) {
        await railToggle.click();
        await page.waitForSelector('[data-session-rail]', { timeout: 10_000 });
      }
    }
    await page.waitForTimeout(250);

    // 1. `SID_COMPLEX` has `delivery: 'message'`, so it opens in `对话` (`message`) view first!
    // Verify `对话` view (partial TTS quota reason + centered hairline turn-end rule) and capture `@2x` PNG.
    const msgCheck = await page.evaluate(() => {
      const text = document.body.innerText;
      const footnote = document.querySelector('[data-turn-footnote]');
      const leftRule = footnote?.querySelector('[data-turn-tail-rule="left"]');
      const rightRule = footnote?.querySelector('[data-turn-tail-rule="right"]');
      return {
        hasLoadError: text.includes('无法打开会话') || text.includes('会话恢复失败'),
        hasQuotaReason: text.includes('quota') || text.includes('131000'),
        hasRules: leftRule !== null && rightRule !== null,
      };
    });
    if (msgCheck.hasLoadError || !msgCheck.hasQuotaReason || !msgCheck.hasRules) {
      throw new Error(`Complex timeline message-view check failed: ${JSON.stringify(msgCheck)}`);
    }
    await page.screenshot({
      path: join(outputDir, `complex-timeline-message--${view.locale}--${view.theme}--${view.viewport}.png`),
    });

    // 2. Switch to `过程` (`process`) view on the exact same session and run full DOM + geometric assertions!
    const processBtn = page.locator('[data-timeline-view-option="process"]').first();
    if ((await processBtn.count()) > 0) {
      await processBtn.click();
      await page.waitForSelector('.kiki-prose .kiki-md', { timeout: 10_000 });
      await page.waitForTimeout(250);
    }

    const metrics = await page.evaluate(() => {
      const folds = [...document.querySelectorAll('[data-history-fold]')];
      const callouts = [...document.querySelectorAll('[data-timeline-error-callout]')];
      const modelSteerVisible = [...document.querySelectorAll('[data-injection-variant="model_steering"]')].filter(
        (el) => el.closest('[data-history-fold]') === null,
      ).length;
      const divider = document.querySelector('[data-timeline-divider][data-compaction-phase="completed"]');
      const footnote = document.querySelector('[data-turn-footnote]');
      const leftRule = footnote?.querySelector('[data-turn-tail-rule="left"]');
      const rightRule = footnote?.querySelector('[data-turn-tail-rule="right"]');
      const prose = document.querySelector('.kiki-prose .kiki-md');
      const strongCode = document.querySelector('.kiki-md :is(strong, b, [data-streamdown="strong"]) code');
      const proseLeft = prose?.getBoundingClientRect().left ?? null;
      const endedRow = document.querySelector('[data-subagent-ended]');
      const endedLeft = endedRow?.getBoundingClientRect().left ?? null;
      const timelineArea = document.querySelector('[data-transcript-scroll]') ?? document;
      const proseBlocks = [...timelineArea.querySelectorAll('.kiki-prose')];
      const userBubbles = [...timelineArea.querySelectorAll('.bg-bubble-user')];
      let assistantToUserGap = null;
      for (const bubble of userBubbles) {
        const bRect = bubble.getBoundingClientRect();
        const prevProse = proseBlocks.filter((p) => p.getBoundingClientRect().bottom <= bRect.top + 2).at(-1);
        if (prevProse) {
          const pRect = prevProse.getBoundingClientRect();
          const dividerEl = timelineArea.querySelector('[data-timeline-divider]');
          const divRect = dividerEl?.getBoundingClientRect();
          const hasDividerBetween =
            divRect !== undefined &&
            divRect.top >= pRect.bottom - 2 &&
            divRect.bottom <= bRect.top + 2;
          if (!hasDividerBetween) {
            assistantToUserGap = Math.round(bRect.top - pRect.bottom);
            break;
          }
        }
      }
      const headerPluginBtns = [...document.querySelectorAll('[data-workspace-panel-item]')];
      const headerPluginLabelsVisible = headerPluginBtns.filter((btn) => {
        const span = btn.querySelector('span:not([aria-hidden])');
        return span !== null && getComputedStyle(span).display !== 'none';
      }).length;
      const sidebarNeedsYou = document.querySelectorAll('[data-sidebar-dot="needs_you"]').length;
      const sidebarWorking = document.querySelectorAll('[data-sidebar-dot="working"]').length;
      const sidebarUnread = document.querySelectorAll('[data-sidebar-dot="unread"]').length;
      const railText = document.querySelector('[data-session-rail]')?.textContent ?? '';
      const wealthInlineUnderRunning = [...document.querySelectorAll('[data-session-rail] [data-agent-tree] > *')].some(
        (el) => (el.textContent ?? '').includes('Render wealth audit'),
      );
      return {
        foldCount: folds.length,
        calloutCount: callouts.length,
        modelSteerVisible,
        hasCompactionDivider: divider !== null,
        hasLeftRule: leftRule !== null && leftRule.getBoundingClientRect().width > 20,
        hasRightRule: rightRule !== null && rightRule.getBoundingClientRect().width > 20,
        footnoteText: (footnote?.textContent ?? '').trim(),
        proseFontSize: prose ? getComputedStyle(prose).fontSize : null,
        strongCodeWeight: strongCode ? getComputedStyle(strongCode).fontWeight : null,
        keylineDelta: proseLeft !== null && endedLeft !== null ? Math.abs(Math.round(proseLeft - endedLeft)) : null,
        assistantToUserGap,
        headerPluginCount: headerPluginBtns.length,
        headerPluginLabelsVisible,
        sidebarNeedsYou,
        sidebarWorking,
        sidebarUnread,
        railHasRunning: railText.includes('3 运行中'),
        railHasUnknownChip: railText.includes('状态未知') || railText.includes('unknown'),
        wealthInlineUnderRunning,
      };
    });

    if (metrics.calloutCount !== 0) {
      throw new Error(`Expected 0 TimelineErrorCallouts on settled complex timeline, got ${metrics.calloutCount}`);
    }
    if (metrics.modelSteerVisible !== 0) {
      throw new Error(`Expected 0 naked Model Steer rows outside folds, got ${metrics.modelSteerVisible}`);
    }
    if (!metrics.hasCompactionDivider) {
      throw new Error('Expected completed compaction epoch divider on complex timeline');
    }
    if (!metrics.hasLeftRule || !metrics.hasRightRule) {
      throw new Error(`Expected centered hairline rules on TurnFootnote: ${JSON.stringify(metrics)}`);
    }
    if (metrics.proseFontSize !== '14.5px') {
      throw new Error(`Expected 14.5px default prose font size, got ${metrics.proseFontSize}`);
    }
    if (metrics.strongCodeWeight !== '700') {
      throw new Error(`Expected strong > code font-weight 700, got ${metrics.strongCodeWeight}`);
    }
    if (metrics.keylineDelta !== null && metrics.keylineDelta > 2) {
      throw new Error(`Expected SubagentEnded and Assistant prose left edges aligned (<=2px), got ${metrics.keylineDelta}px`);
    }
    if (metrics.assistantToUserGap === null || metrics.assistantToUserGap < 14 || metrics.assistantToUserGap > 32) {
      throw new Error(`Expected compact 14px-32px Assistant->User gap, got ${metrics.assistantToUserGap}px`);
    }
    if (metrics.headerPluginCount !== 3 || metrics.headerPluginLabelsVisible !== 0) {
      throw new Error(`Expected 3 header plugin buttons collapsed to icon-only: ${JSON.stringify(metrics)}`);
    }
    if (metrics.sidebarNeedsYou < 1 || metrics.sidebarWorking < 1 || metrics.sidebarUnread < 1) {
      throw new Error(`Expected all 3 distinct sidebar status dot kinds mounted: ${JSON.stringify(metrics)}`);
    }
    if (!metrics.railHasRunning || metrics.railHasUnknownChip || metrics.wealthInlineUnderRunning) {
      throw new Error(`Expected RightRail 3 running + completed parent folded into ended: ${JSON.stringify(metrics)}`);
    }

    // 3. Exercise & capture the unified @base-ui/react multiline annotation popover
    const selected = await page.evaluate(() => {
      const target = [...document.querySelectorAll('.kiki-prose p, .kiki-prose li')].findLast((el) => {
        const r = el.getBoundingClientRect();
        return (el.textContent ?? '').includes('自然观察口吻') && r.top > 80 && r.bottom < window.innerHeight - 80;
      });
      if (!target || !target.firstChild) return false;
      const textNode = [...target.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').length > 8) ?? target.firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(12, (textNode.textContent ?? '').length));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    });
    if (!selected) {
      throw new Error('Expected visible target paragraph for annotation popover check');
    }
    {
      const annotateBtn = page.locator('[data-selection-annotate-action]');
      await annotateBtn.waitFor({ timeout: 5_000 });
      await annotateBtn.click();
      const input = page.locator('[data-annotation-panel-input]');
      await input.waitFor({ timeout: 5_000 });
      await input.fill('第一行批注自动换行核验：离底部间距均衡，保留删除与保存动作。\n第二行补充说明：失焦自动收起，聚焦平滑展开。');
      await page.waitForTimeout(150);
      const popoverCheck = await page.evaluate(() => {
        const panel = document.querySelector('[data-annotation-panel]');
        const ta = document.querySelector('[data-annotation-panel-input]');
        const save = document.querySelector('[data-annotation-panel-save]');
        const remove = document.querySelector('[data-annotation-panel-remove]');
        return {
          hasPanel: panel !== null,
          isTextarea: ta?.tagName === 'TEXTAREA',
          focusedAttr: ta?.getAttribute('data-focused'),
          hasSave: save !== null && !save.hasAttribute('disabled'),
          hasRemove: remove !== null,
        };
      });
      if (!popoverCheck.hasPanel || !popoverCheck.isTextarea || popoverCheck.focusedAttr !== 'true' || !popoverCheck.hasSave || !popoverCheck.hasRemove) {
        throw new Error(`Annotation popover contract failed: ${JSON.stringify(popoverCheck)}`);
      }
      await page.screenshot({
        path: join(outputDir, `complex-timeline-annotation-open--${view.locale}--${view.theme}--${view.viewport}.png`),
      });
      await page.click('[data-annotation-panel-remove]');
      await page.locator('[data-annotation-panel]').waitFor({ state: 'detached', timeout: 5_000 });
    }
  } else {
    // Narrow viewport: switch into process view if the menu is available or keep default message view
    await page.waitForTimeout(200);
  }
}

async function setupPersonaMessage(ctx) {
  const { page, view } = ctx;
  await page.waitForSelector(TRANSCRIPT_SCROLL, { timeout: 15_000 });
  await page.waitForSelector('[data-turn-footnote]', { timeout: 15_000 });
  if (view.viewport === 'wide') {
    const check = await page.evaluate(() => {
      const text = document.body.innerText;
      const footnote = document.querySelector('[data-turn-footnote]');
      const leftRule = footnote?.querySelector('[data-turn-tail-rule="left"]');
      const rightRule = footnote?.querySelector('[data-turn-tail-rule="right"]');
      return {
        hasQuotaReason: text.includes('quota') || text.includes('131000'),
        hasRules: leftRule !== null && rightRule !== null,
      };
    });
    if (!check.hasQuotaReason || !check.hasRules) {
      throw new Error(`Persona message view check failed: ${JSON.stringify(check)}`);
    }
  }
}

async function setupFailedTail(ctx) {
  const { page, view } = ctx;
  await page.waitForSelector('[data-turn-tail-state="failed"] [data-timeline-error-callout]', { timeout: 15_000 });
  if (view.viewport === 'wide') {
    const tailCheck = await page.evaluate(() => {
      const callouts = document.querySelectorAll('[data-timeline-error-callout]');
      const primaryBtns = [...document.querySelectorAll('[data-turn-tail-state="failed"] [data-error-action]')].filter(
        (b) => b.className.includes('bg-ink/[0.06]'),
      );
      return { callouts: callouts.length, primaryBtns: primaryBtns.length };
    });
    if (tailCheck.callouts !== 1 || tailCheck.primaryBtns > 1) {
      throw new Error(`Failed tail error card check failed: ${JSON.stringify(tailCheck)}`);
    }
  }
}

async function setupWorkingComposer(ctx) {
  const { page, view } = ctx;
  await page.waitForSelector('[data-composer-status-line] [data-composer-working]', { timeout: 15_000 });
  await page.waitForSelector('[data-steer-status="waiting"]', { timeout: 15_000 });
  if (view.viewport === 'wide') {
    await page.waitForSelector('[data-composer-status-line] [data-composer-ssh-strip]', { timeout: 10_000 });
    const workingCheck = await page.evaluate(() => {
      const working = document.querySelector('[data-composer-status-line] [data-composer-working]');
      const sshStrip = document.querySelector('[data-composer-status-line] [data-composer-ssh-strip]');
      const steerBubble = document.querySelector('[data-steer-status="waiting"]');
      const steerStyle = steerBubble ? getComputedStyle(steerBubble) : null;
      return {
        orderOk: Boolean(working && sshStrip && (working.compareDocumentPosition(sshStrip) & Node.DOCUMENT_POSITION_FOLLOWING)),
        steerBorderStyle: steerStyle?.borderTopStyle ?? null,
        steerBorderWidth: steerStyle?.borderTopWidth ?? null,
        steerBorderColor: steerStyle?.borderTopColor ?? null,
      };
    });
    if (!workingCheck.orderOk) {
      throw new Error('Expected [data-composer-working] before [data-composer-ssh-strip] in composer status line');
    }
    if (workingCheck.steerBorderStyle !== 'dashed' || workingCheck.steerBorderColor === 'rgba(0, 0, 0, 0)') {
      throw new Error(`Expected dashed non-transparent border on Send now bubble: ${JSON.stringify(workingCheck)}`);
    }
  }
}

async function setupUsageLive(ctx) {
  const { page, view } = ctx;
  await page.waitForSelector('[data-governance-concurrency]', { timeout: 15_000 });
  await page.waitForSelector('[data-governance-sessions]', { timeout: 15_000 });
  if (view.viewport === 'wide') {
    const splitCheck = await page.evaluate(() => {
      const left = document.querySelector('[data-governance-concurrency]')?.getBoundingClientRect();
      const right = document.querySelector('[data-governance-sessions]')?.getBoundingClientRect();
      const activeCells = document.querySelectorAll('[data-governance-row-active]').length;
      const pendingPause = document.querySelector('[data-governance-needs-you] [data-execution-action="pause"]');
      return {
        sideBySide: Boolean(left && right && right.left >= left.right - 4),
        activeCells,
        hasPendingPause: pendingPause !== null,
      };
    });
    if (!splitCheck.sideBySide || splitCheck.activeCells < 4 || !splitCheck.hasPendingPause) {
      throw new Error(`Usage Live 2-column & tabular check failed: ${JSON.stringify(splitCheck)}`);
    }
  }
}

async function setupUsageQuota(ctx) {
  const { page } = ctx;
  await page.waitForSelector('[data-provider-quota-panel]', { timeout: 15_000 });
  await page.waitForSelector('[data-quota-engines]', { timeout: 15_000 });
  await page.waitForTimeout(250);
  const quotaCheck = await page.evaluate(() => {
    const topAttention = document.querySelector('[data-quota-attention]');
    const externalSection = document.querySelector('[data-quota-external-services]');
    const claudeMode = document.querySelector('[data-quota-engine="claude-acp"]')?.getAttribute('data-engine-quota-mode');
    const codexMode = document.querySelector('[data-quota-engine="codex-app-server"]')?.getAttribute('data-engine-quota-mode');
    const grokMode = document.querySelector('[data-quota-engine="grok-acp"]')?.getAttribute('data-engine-quota-mode');
    const agyText = document.querySelector('[data-quota-engine="antigravity-acp"]')?.textContent ?? '';
    const deadKimiInMain = document.querySelector('[data-quota-engine="kimi-cli"]');
    const unsupportedCount = document.querySelector('[data-quota-unsupported]')?.getAttribute('data-quota-unsupported');
    const bodyText = document.body.innerText;
    return {
      hasTopAttention: topAttention !== null,
      hasExternalSection: externalSection !== null,
      claudeMode,
      codexMode,
      grokMode,
      agyHasPercent: agyText.includes('%'),
      deadKimiInMain: deadKimiInMain !== null,
      unsupportedCount: Number(unsupportedCount ?? '0'),
      hasPartialWrapperNoise: bodyText.includes('部分额度表项状态异常'),
    };
  });
  if (
    quotaCheck.hasTopAttention ||
    !quotaCheck.hasExternalSection ||
    quotaCheck.claudeMode !== 'plugin' ||
    quotaCheck.codexMode !== 'plugin' ||
    quotaCheck.grokMode !== 'plugin' ||
    !quotaCheck.agyHasPercent ||
    quotaCheck.deadKimiInMain ||
    quotaCheck.unsupportedCount < 3 ||
    quotaCheck.hasPartialWrapperNoise
  ) {
    throw new Error(`Usage Quota panel verification failed: ${JSON.stringify(quotaCheck)}`);
  }
}

async function setupSettings(ctx) {
  const { page, view } = ctx;
  await page.waitForSelector('[data-settings-page-title]', { timeout: 15_000 });
  if (view.viewport === 'wide') {
    const navCheck = await page.evaluate(() => {
      const groupHeading = document.querySelector('[data-settings-nav-group] > p');
      const activeLeaf = document.querySelector('[data-settings-nav-tree] [aria-current="page"]');
      const headingWeight = groupHeading ? getComputedStyle(groupHeading).fontWeight : null;
      const leafColor = activeLeaf ? getComputedStyle(activeLeaf).color : null;
      const leafBg = activeLeaf ? getComputedStyle(activeLeaf).backgroundColor : null;
      return { headingWeight, leafColor, leafBg };
    });
    if (navCheck.headingWeight !== '700' || navCheck.leafColor === 'rgb(255, 255, 255)') {
      throw new Error(`SettingsNav hierarchy/contrast check failed: ${JSON.stringify(navCheck)}`);
    }
  }
}

export default {
  name: 'headless-smoke',
  scenario: 'complex-timeline',
  vite: true,
  deviceScaleFactor: 2,
  routes: [
    {
      name: 'hero-shell',
      path: '/new',
      waitFor: [HERO, COMPOSER_READY],
      setup: setupHero,
    },
    {
      name: 'complex-timeline-process',
      path: `/s/${SID_COMPLEX}`,
      waitFor: [TRANSCRIPT_SCROLL],
      setup: setupComplexTimeline,
    },
    {
      name: 'persona-message-timeline',
      path: `/s/${SID_PERSONA}`,
      waitFor: [TRANSCRIPT_SCROLL],
      setup: setupPersonaMessage,
    },
    {
      name: 'complex-timeline-failed-tail',
      path: `/s/${SID_FAILED_TAIL}`,
      waitFor: [TRANSCRIPT_SCROLL],
      setup: setupFailedTail,
    },
    {
      name: 'working-session-composer',
      path: `/s/${SID_WORKING}`,
      waitFor: [TRANSCRIPT_SCROLL],
      setup: setupWorkingComposer,
    },
    {
      name: 'external-harness-timeline',
      path: `/s/${SID_EXTERNAL}`,
      waitFor: [TRANSCRIPT_SCROLL],
    },
    {
      name: 'usage-live',
      path: '/usage',
      waitFor: ['[data-governance-concurrency]'],
      setup: setupUsageLive,
    },
    {
      name: 'usage-quota',
      path: '/usage?panel=quota',
      waitFor: ['[data-provider-quota-panel]'],
      setup: setupUsageQuota,
    },
    {
      name: 'settings-appearance',
      path: '/settings/appearance',
      waitFor: ['[data-settings-page-title]'],
      setup: setupSettings,
    },
  ],
  matrix: {
    themes: ['light', 'dark'],
    locales: ['zh'],
    viewports: ['wide', 'narrow'],
  },
};

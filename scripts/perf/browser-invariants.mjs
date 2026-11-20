import os from 'node:os';
import { performance } from 'node:perf_hooks';

export const REACT_ERROR_PATTERNS = [
  /Minified React error #\d+/i,
  /Rendered (?:more|fewer) hooks/i,
  /Invalid hook call/i,
  /\[app:error-boundary\]/,
  /\[settings:pane-error\]/,
  /The above error occurred in the <[^>]+> component/i,
];

const SAFE_QUERY_KEYS = new Set([
  'observe',
  'page_size',
  'limit',
  'ephemeral',
  'effective',
  'admission',
  'view',
  'per_persona_limit',
  'pinned',
  'tab',
  'include',
]);

function buildSanitizerTokens() {
  const tokens = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.trim().length < 3) return;
    tokens.push(value);
    const slashed = value.replaceAll('\\', '/');
    if (slashed !== value) tokens.push(slashed);
  };
  add(os.homedir());
  add(os.tmpdir());
  try {
    add(os.userInfo().username);
  } catch {
    // Ignore environments without OS user lookup.
  }
  return [...new Set(tokens)].toSorted((a, b) => b.length - a.length);
}

const SANITIZER_TOKENS = buildSanitizerTokens();

export function sanitizeDiagnosticText(raw, maxLen = 400) {
  if (typeof raw !== 'string') return '';
  let out = raw;
  for (const token of SANITIZER_TOKENS) {
    if (token.length < 3) continue;
    out = out.replaceAll(token, '<redacted>');
    const lowerToken = token.toLowerCase();
    if (lowerToken !== token) {
      out = out.replace(new RegExp(lowerToken.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '<redacted>');
    }
  }
  out = out.replace(/session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, 'session_<redacted>');
  return out.slice(0, maxLen);
}

function normalizeRouteKey(method, rawUrl) {
  const parsed = new URL(rawUrl);
  const normPath = parsed.pathname
    .replace(/\/sessions\/[^/]+/gu, '/sessions/:id')
    .replace(/\/agents\/(?!capabilities|references|shipped)[^/]+/gu, '/agents/:aid');
  const safeParams = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    safeParams.push(SAFE_QUERY_KEYS.has(k) ? `${k}=${v}` : `${k}=:redacted`);
  }
  const search = safeParams.length > 0 ? `?${safeParams.join('&')}` : '';
  return { parsed, routeKey: `${method} ${normPath}${search}` };
}

export function attachBrowserRuntimeGuards(page, { endpoint, rpcSlowBudgetMs = 1_500 }) {
  const pageErrors = [];
  const reactConsoleErrors = [];
  const failedApiResponses = [];
  const slowApiResponses = [];
  const inflightStarts = new WeakMap();
  let phase = 'boot';
  let coldOpenWindowActive = false;
  let maxColdRpcMs = 0;

  page.on('pageerror', (err) => {
    pageErrors.push({ phase, message: sanitizeDiagnosticText(String(err?.message ?? err), 500) });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (REACT_ERROR_PATTERNS.some((re) => re.test(text))) {
      reactConsoleErrors.push({ phase, text: sanitizeDiagnosticText(text, 500) });
    }
  });

  page.on('request', (req) => {
    if (req.url().startsWith(endpoint)) {
      inflightStarts.set(req, performance.now());
    }
  });

  page.on('response', async (res) => {
    const req = res.request();
    const url = req.url();
    if (!url.startsWith(endpoint)) return;
    const started = inflightStarts.get(req);
    const elapsedMs = started === undefined ? 0 : Number((performance.now() - started).toFixed(1));
    const { parsed, routeKey } = normalizeRouteKey(req.method(), url);

    if (res.status() >= 500) {
      failedApiResponses.push({ phase, routeKey, status: res.status(), elapsedMs });
    }
    if (coldOpenWindowActive && parsed.pathname.startsWith('/api/')) {
      if (elapsedMs > maxColdRpcMs) maxColdRpcMs = elapsedMs;
      if (elapsedMs > rpcSlowBudgetMs) {
        slowApiResponses.push({ phase, routeKey, status: res.status(), elapsedMs });
      }
    }
    if (
      parsed.searchParams.get('observe') === 'true' &&
      (parsed.pathname.endsWith('/auto-compact') || parsed.pathname.endsWith('/context-strategy')) &&
      res.status() === 200
    ) {
      const body = await res.json().catch(() => null);
      if (body && body.code === 40901) {
        failedApiResponses.push({
          phase,
          routeKey,
          status: 200,
          code: body.code,
          msg: sanitizeDiagnosticText(String(body.msg ?? ''), 200),
          elapsedMs,
        });
      }
    }
  });

  return {
    setPhase(next, { coldOpen = false } = {}) {
      phase = next;
      coldOpenWindowActive = coldOpen;
    },
    async assertNoErrorBoundary(stepLabel) {
      const hit = await page.evaluate(() => {
        try {
          const renderFail = sessionStorage.getItem('kiki.lastRenderFailure');
          if (renderFail) return { kind: 'sessionStorage.lastRenderFailure', detail: renderFail.slice(0, 400) };
        } catch {
          // Storage unavailable.
        }
        const settingsErr = document.querySelector('[data-settings-pane-error]');
        if (settingsErr) return { kind: 'SettingsPaneBoundary', detail: (settingsErr.textContent ?? '').trim().slice(0, 400) };
        const appAlertPre = document.querySelector('main > section[role="alert"] pre');
        if (appAlertPre) return { kind: 'AppErrorBoundary', detail: (appAlertPre.textContent ?? '').trim().slice(0, 400) };
        return null;
      }).catch(() => null);
      if (hit !== null) {
        reactConsoleErrors.push({
          phase: stepLabel,
          text: `${hit.kind}: ${sanitizeDiagnosticText(hit.detail, 400)}`,
        });
        return hit;
      }
      return null;
    },
    snapshot() {
      return {
        pageErrors: [...pageErrors],
        reactConsoleErrors: [...reactConsoleErrors],
        failedApiResponses: [...failedApiResponses],
        slowApiResponses: [...slowApiResponses],
        maxColdRpcMs,
      };
    },
  };
}

export async function verifyColdContextMeter(page) {
  const precheck = await page.evaluate(() => ({
    renderedItems: document.querySelectorAll('[data-transcript-scroll] [data-transcript-virtual-item]').length,
    isNativeMain: document.querySelector('[data-composer-variant="main"]') !== null,
  }));
  if (precheck.renderedItems === 0 || !precheck.isNativeMain) {
    return {
      applicable: false,
      ok: true,
      reason: precheck.renderedItems === 0 ? 'no_rendered_turns' : 'non_native_composer',
      hasNativeCompactSection: null,
      hasStrategySection: null,
      hasUsageSection: null,
      compactSource: null,
      strategy: null,
    };
  }

  const meter = page.locator('[data-context-meter]').first();
  const meterVisible = await meter.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (!meterVisible) {
    return {
      applicable: true,
      ok: false,
      reason: 'missing_context_meter',
      hasNativeCompactSection: false,
      hasStrategySection: false,
      hasUsageSection: false,
      compactSource: null,
      strategy: null,
    };
  }

  await meter.click();
  const details = page.locator('[data-context-details]').first();
  const detailsVisible = await details.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (!detailsVisible) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return {
      applicable: true,
      ok: false,
      reason: 'missing_context_details',
      hasNativeCompactSection: false,
      hasStrategySection: false,
      hasUsageSection: false,
      compactSource: null,
      strategy: null,
    };
  }

  await page.waitForFunction(
    () => {
      const compact = document.querySelector('[data-context-compact-section]') !== null;
      const strategyEl = document.querySelector('[data-context-strategy]');
      const strategyReady = strategyEl !== null && !strategyEl.hasAttribute('data-strategy-loading');
      return compact && strategyReady;
    },
    null,
    { timeout: 3_000 },
  ).catch(() => undefined);

  const panelState = await page.evaluate(() => {
    const compactEl = document.querySelector('[data-context-compact-section]');
    const strategyEl = document.querySelector('[data-context-strategy]');
    const strategyLoading = strategyEl?.hasAttribute('data-strategy-loading') ?? false;
    return {
      hasNativeCompactSection: compactEl !== null,
      hasStrategySection: strategyEl !== null && !strategyLoading,
      hasUsageSection: document.querySelector('[data-context-usage]') !== null,
      compactSource: compactEl?.getAttribute('data-compact-source') ?? null,
      strategy: strategyEl?.getAttribute('data-strategy') ?? null,
    };
  });

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('[data-context-details]').waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => undefined);
  const ok = panelState.hasNativeCompactSection && panelState.hasStrategySection;
  const reason = ok
    ? null
    : !panelState.hasNativeCompactSection && !panelState.hasStrategySection
      ? 'missing_compact_and_strategy'
      : !panelState.hasNativeCompactSection
        ? 'missing_compact_section'
        : 'missing_strategy_section';

  return {
    applicable: true,
    ok,
    reason,
    ...panelState,
  };
}

export async function verifyComposerFooterDrain(page, { timeoutMs = 3_500 } = {}) {
  return page.waitForFunction(
    () => {
      const hasRemainder = document.querySelector('[data-session-remainder]') !== null;
      const hasMorePromptRecords = document.querySelector('[data-prompt-records-remainder]') !== null;
      const hasQueuedPrompts = document.querySelector('[data-header-toggle="queue"]') !== null;
      if (!hasRemainder && (!hasMorePromptRecords || hasQueuedPrompts)) {
        return { ok: true, hasRemainder, hasMorePromptRecords, hasQueuedPrompts };
      }
      return false;
    },
    null,
    { timeout: timeoutMs },
  ).then((handle) => handle.jsonValue()).catch(async () => page.evaluate(() => ({
    ok: false,
    hasRemainder: document.querySelector('[data-session-remainder]') !== null,
    hasMorePromptRecords: document.querySelector('[data-prompt-records-remainder]') !== null,
    hasQueuedPrompts: document.querySelector('[data-header-toggle="queue"]') !== null,
  })));
}

const APP_WALK_ROUTES = [
  {
    route: '/settings/ai',
    readySelector: '[data-settings-page-title], [data-connection-list], [data-settings-pane-error], main > section[role="alert"] pre',
  },
  {
    route: '/settings/agents',
    readySelector: '[data-settings-page-title], [data-settings-pane-error], main > section[role="alert"] pre',
  },
  {
    route: '/settings/search?tab=fetch',
    readySelector: '[data-settings-page-title], [data-settings-pane-error], main > section[role="alert"] pre',
  },
  {
    route: '/usage',
    readySelector: '[data-usage-trend], [data-usage-summary-cost], [data-provider-quota-panel], [data-usage-empty], [data-usage-page], main > section[role="alert"] pre',
  },
  {
    route: '/capabilities',
    readySelector: '[data-capabilities-page], [data-capability-empty], [data-skill-row], main > section[role="alert"] pre',
  },
];

export async function verifyAddMenuSecondaryScrollable(page) {
  const trigger = page.locator('[data-add-menu-trigger]').first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) {
    return { applicable: false, ok: true, reason: 'no_add_menu_trigger', view: null, scrollable: null, overflowed: false };
  }

  await trigger.click();
  await page.waitForTimeout(150);

  const secondaryOrder = [
    ['skills', '[data-add-menu-skills]'],
    ['plugins', '[data-add-menu-plugins]'],
    ['mcp', '[data-add-menu-mcp]'],
    ['ssh', '[data-add-menu-ssh]'],
    ['mode', '[data-add-menu-mode]'],
  ];
  let pickedView = null;
  for (const [name, selector] of secondaryOrder) {
    const row = page.locator(selector).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      pickedView = name;
      break;
    }
  }

  if (pickedView === null) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { applicable: false, ok: true, reason: 'no_secondary_view_entry', view: null, scrollable: null, overflowed: false };
  }

  await page.waitForTimeout(200);
  const check = await page.evaluate(() => {
    const addPanel = document.querySelector('[data-add-panel]');
    const menuRoot = document.querySelector('[data-add-menu]');
    const scope = addPanel ?? menuRoot;
    const candidates = scope
      ? Array.from(scope.querySelectorAll('div'))
      : Array.from(document.querySelectorAll('[data-add-panel] div, [data-add-menu] div'));
    let bestScroller = null;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 40) continue;
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        if (!bestScroller || el.scrollHeight > bestScroller.scrollHeight) {
          bestScroller = el;
        }
      }
    }
    const panel = addPanel ?? bestScroller?.closest('[role="menu"], [role="dialog"], [data-add-menu] > div') ?? bestScroller;
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    const clipsViewport = panelRect !== null && (panelRect.bottom > window.innerHeight + 4 || panelRect.top < -4);
    if (!bestScroller) {
      return { foundScroller: false, overflowed: false, moved: false, clipsViewport };
    }
    const overflowed = bestScroller.scrollHeight > bestScroller.clientHeight + 2;
    let moved = true;
    if (overflowed) {
      const before = bestScroller.scrollTop;
      bestScroller.scrollTop = Math.min(bestScroller.scrollHeight - bestScroller.clientHeight, 120);
      moved = bestScroller.scrollTop > before;
      bestScroller.scrollTop = before;
    }
    return { foundScroller: true, overflowed, moved, clipsViewport };
  });

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(100);
  const ok = !check.clipsViewport && (!check.overflowed || (check.foundScroller && check.moved));
  return {
    applicable: true,
    ok,
    reason: ok ? null : check.clipsViewport ? 'panel_clips_viewport' : 'secondary_view_not_scrollable',
    view: pickedView,
    scrollable: check.foundScroller && check.moved,
    overflowed: check.overflowed,
  };
}

export async function verifyCapabilitiesToggleNoJumpNoOverlap(page) {
  const ready = await page.evaluate(() => {
    const hasPage = document.querySelector('[data-capabilities-page]') !== null;
    const switches = Array.from(document.querySelectorAll('button[role="switch"]:not([disabled])'));
    return { hasPage, switchCount: switches.length };
  });
  if (!ready.hasPage || ready.switchCount === 0) {
    return { applicable: false, ok: true, reason: 'no_capability_switches', scrollDeltaPx: 0, overlapCount: 0 };
  }

  const beforeState = await page.evaluate(() => {
    const findScroller = () => {
      const marked = document.querySelector('[data-settings-scroll]');
      if (marked) return marked;
      const pageEl = document.querySelector('[data-capabilities-page]');
      for (let el = pageEl; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
          return el;
        }
      }
      return document.scrollingElement || document.documentElement;
    };
    const scroller = findScroller();
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll > 80) {
      scroller.scrollTop = Math.min(maxScroll, 200);
    }
    const switches = Array.from(document.querySelectorAll('button[role="switch"]:not([disabled])'));
    const targetIdx = switches.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 40 && r.bottom <= window.innerHeight - 20;
    });
    return {
      scrollTop: scroller.scrollTop,
      targetIdx: targetIdx >= 0 ? targetIdx : 0,
    };
  });

  await page.waitForTimeout(120);
  const toggleBtn = page.locator('button[role="switch"]:not([disabled])').nth(beforeState.targetIdx);
  await toggleBtn.click();
  await page.waitForTimeout(300);

  const afterState = await page.evaluate(() => {
    const findScroller = () => {
      const marked = document.querySelector('[data-settings-scroll]');
      if (marked) return marked;
      const pageEl = document.querySelector('[data-capabilities-page]');
      for (let el = pageEl; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
          return el;
        }
      }
      return document.scrollingElement || document.documentElement;
    };
    const scroller = findScroller();
    let overlapCount = 0;
    for (const body of document.querySelectorAll('[data-list-body]')) {
      const rows = Array.from(body.querySelectorAll('[role="listitem"]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.width > 0)
        .sort((a, b) => a.top - b.top);
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].top < rows[i - 1].bottom - 1.5) {
          overlapCount += 1;
        }
      }
    }
    return { scrollTop: scroller.scrollTop, overlapCount };
  });

  // Restore original toggle state cleanly.
  await toggleBtn.click().catch(() => undefined);
  await page.waitForTimeout(150);

  const scrollDeltaPx = Math.round(Math.abs(afterState.scrollTop - beforeState.scrollTop));
  const ok = scrollDeltaPx <= 48 && afterState.overlapCount === 0;
  return {
    applicable: true,
    ok,
    reason: ok ? null : afterState.overlapCount > 0 ? 'list_rows_overlap' : `scroll_jumped_${scrollDeltaPx}px`,
    scrollDeltaPx,
    overlapCount: afterState.overlapCount,
  };
}

export async function verifyRightRailMergedBranchesFolded(page) {
  const result = await page.evaluate(() => {
    const list = document.querySelector('[data-branches-list]');
    if (!list) return { applicable: false, ok: true, reason: 'no_branches_list', expanded: null, visibleMerged: 0 };
    const moreToggle = list.querySelector('[data-branches-more]');
    if (!moreToggle) {
      return { applicable: false, ok: true, reason: 'no_open_and_merged_mix', expanded: null, visibleMerged: 0 };
    }
    const expanded = moreToggle.getAttribute('aria-expanded') === 'true';
    const visibleMerged = list.querySelectorAll('[data-branch-row][data-branch-state="merged"]').length;
    const focusedMerged = list.querySelector('[data-branch-row][data-branch-state="merged"][data-branch-focused]') !== null;
    if (focusedMerged) {
      return { applicable: false, ok: true, reason: 'focused_branch_is_merged', expanded, visibleMerged };
    }
    const ok = !expanded && visibleMerged === 0;
    return {
      applicable: true,
      ok,
      reason: ok ? null : 'merged_branches_not_folded_by_default',
      expanded,
      visibleMerged,
    };
  });
  return result;
}

export async function verifyScrollUpNoSnapBack(page, { settleMs = 700 } = {}) {
  const setup = await page.evaluate(() => {
    const scroller = document.querySelector('[data-transcript-scroll]');
    if (!scroller) return { applicable: false, reason: 'no_transcript_scroller' };
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll < 400) return { applicable: false, reason: 'short_transcript' };
    const targetTop = Math.floor(maxScroll * 0.25);
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    scroller.scrollTop = targetTop;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { applicable: true, targetTop, maxScroll, scrollTopImmediately: scroller.scrollTop };
  });
  if (!setup.applicable) {
    return { applicable: false, ok: true, reason: setup.reason, snappedToBottom: false, distanceFromBottomPx: null };
  }

  await page.waitForTimeout(settleMs);
  const settled = await page.evaluate(() => {
    const scroller = document.querySelector('[data-transcript-scroll]');
    if (!scroller) return null;
    const distanceFromBottomPx = Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
    return { scrollTop: Math.round(scroller.scrollTop), distanceFromBottomPx };
  });

  if (settled === null) {
    return { applicable: true, ok: false, reason: 'scroller_unmounted', snappedToBottom: true, distanceFromBottomPx: 0 };
  }
  const snappedToBottom = settled.distanceFromBottomPx < 120;
  return {
    applicable: true,
    ok: !snappedToBottom,
    reason: snappedToBottom ? `snapped_back_distance_${settled.distanceFromBottomPx}px` : null,
    snappedToBottom,
    distanceFromBottomPx: settled.distanceFromBottomPx,
  };
}

export async function runAppRoutesWalk(page, { deepLink, guards }) {
  const visited = [];
  let capabilitiesToggle = null;
  for (const spec of APP_WALK_ROUTES) {
    const started = performance.now();
    guards.setPhase(`route:${spec.route}`, { coldOpen: false });
    await page.goto(deepLink(spec.route), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector(spec.readySelector, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    if (spec.route === '/capabilities') {
      capabilitiesToggle = await verifyCapabilitiesToggleNoJumpNoOverlap(page);
    }
    const boundary = await guards.assertNoErrorBoundary(`route:${spec.route}`);
    visited.push({
      route: spec.route,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      boundaryHit: boundary?.kind ?? null,
    });
  }
  return { visited, capabilitiesToggle };
}

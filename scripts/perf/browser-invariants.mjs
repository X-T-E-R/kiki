import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { trustedWheelScrollUp } from './trusted-scroll.mjs';

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
      out = out.replaceAll(new RegExp(lowerToken.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '<redacted>');
    }
  }
  out = out.replaceAll(/session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, 'session_<redacted>');
  return out.slice(0, maxLen);
}

function normalizeRouteKey(method, rawUrl) {
  const parsed = new URL(rawUrl);
  const normPath = parsed.pathname
    .replaceAll(/\/sessions\/[^/]+/gu, '/sessions/:id')
    .replaceAll(/\/agents\/(?!capabilities|references|shipped)[^/]+/gu, '/agents/:aid');
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
      const strategyReady = strategyEl !== null && !Object.hasOwn(strategyEl.dataset, "strategyLoading");
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
      compactSource: compactEl.dataset.compactSource ?? null,
      strategy: strategyEl.dataset.strategy ?? null,
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
    const scrollerRect = bestScroller.getBoundingClientRect();
    return {
      foundScroller: true,
      overflowed,
      beforeScrollTop: bestScroller.scrollTop,
      hoverX: scrollerRect.left + scrollerRect.width * 0.5,
      hoverY: scrollerRect.top + scrollerRect.height * 0.5,
      clipsViewport,
    };
  });

  let moved = true;
  if (check.foundScroller && check.overflowed) {
    await page.mouse.move(check.hoverX, check.hoverY);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(120);
    const afterScrollTop = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('[data-add-menu] *, [role="menu"] *, [role="dialog"] *, [data-add-menu], [role="menu"]'),
      ];
      let best = null;
      for (const el of candidates) {
        const st = getComputedStyle(el);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
          if (!best || el.scrollHeight > best.scrollHeight) best = el;
        }
      }
      return best ? best.scrollTop : 0;
    });
    moved = afterScrollTop > (check.beforeScrollTop ?? 0);
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(100);
  const ok = !check.clipsViewport && (!check.overflowed || (check.foundScroller && moved));
  return {
    applicable: true,
    ok,
    reason: ok ? null : check.clipsViewport ? 'panel_clips_viewport' : 'secondary_view_not_scrollable',
    view: pickedView,
    scrollable: check.foundScroller && moved,
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
    const rect = scroller.getBoundingClientRect();
    return {
      maxScroll,
      x: rect.left + Math.min(200, Math.max(24, rect.width * 0.5)),
      y: rect.top + Math.min(200, Math.max(24, rect.height * 0.5)),
    };
  });
  if (beforeState.maxScroll > 80) {
    await page.mouse.move(beforeState.x, beforeState.y);
    await page.mouse.wheel(0, Math.min(beforeState.maxScroll, 200));
    await page.waitForTimeout(80);
  }
  const resolvedBeforeState = await page.evaluate(() => {
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
    const switches = Array.from(document.querySelectorAll('button[role="switch"]:not([disabled])'));
    const targetIdx = switches.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 40 && r.bottom <= window.innerHeight - 20;
    });
    return {
      scrollTop: scroller.scrollTop,
      targetIdx: Math.max(targetIdx, 0),
    };
  });

  await page.waitForTimeout(120);
  const toggleBtn = page.locator('button[role="switch"]:not([disabled])').nth(resolvedBeforeState.targetIdx);
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
        .toSorted((a, b) => a.top - b.top);
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

  const scrollDeltaPx = Math.round(Math.abs(afterState.scrollTop - resolvedBeforeState.scrollTop));
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

export async function verifyScrollUpNoSnapBack(page, { settleMs = 700, requireApplicable = false } = {}) {
  const outcome = await trustedWheelScrollUp(page, {
    deltaY: -1200,
    steps: 4,
    pauseMs: 90,
    settleMs,
  });
  if (!outcome.applicable) {
    return {
      applicable: requireApplicable,
      ok: !requireApplicable,
      reason: outcome.reason,
      snappedToBottom: false,
      olderTurnsLoaded: false,
      distanceFromBottomPx: null,
    };
  }
  return {
    applicable: true,
    ok: outcome.ok,
    reason: outcome.reason,
    snappedToBottom: outcome.snappedToBottom,
    olderTurnsLoaded: outcome.olderTurnsLoaded,
    distanceFromBottomPx: outcome.distanceFromBottomPx,
  };
}

/**
 * F13 regression gate: opening/viewing a session must clear any sticky unread dot
 * on that session's sidebar row (matches Sidebar.tsx `data-session-row` & `data-session-row-state`).
 * Fails closed when the viewed session row is absent instead of passing vacuously.
 */
export async function verifyViewedSessionClearsUnreadDot(page, sessionId) {
  return page.evaluate((sid) => {
    const escaped = CSS.escape(sid);
    const row = document.querySelector(`[data-session-row="${escaped}"]`);
    if (row) {
      const rowState = row.dataset.sessionRowState ?? '';
      const lifeEl = row.querySelector('[data-life]');
      const life = lifeEl?.dataset.life ?? '';
      const unreadEl = row.querySelector('[data-life="unread"], [data-unread-dot], [data-session-unread="true"]');
      const hasUnreadDot =
        rowState === 'unread' ||
        life === 'unread' ||
        row.dataset.sessionUnread === 'true' ||
        Boolean(unreadEl);
      return {
        applicable: true,
        ok: !hasUnreadDot,
        reason: hasUnreadDot ? `sticky_unread_dot_on_viewed_session(state=${rowState},life=${life})` : null,
        matchedRows: 1,
        rowState,
        hasUnreadDot,
      };
    }
    const inboxRow = document.querySelector(`[data-inbox-row="${escaped}"]`);
    if (inboxRow) {
      const inboxUnread = inboxRow.dataset.inboxUnread ?? '';
      const statusEl = inboxRow.querySelector('[data-inbox-status]');
      const status = statusEl?.dataset.inboxStatus ?? '';
      const unreadEl = inboxRow.querySelector('[data-inbox-status="unread"], [data-life="unread"], [data-unread-dot]');
      const hasUnreadDot = inboxUnread === 'true' || status === 'unread' || Boolean(unreadEl);
      return {
        applicable: true,
        ok: !hasUnreadDot,
        reason: hasUnreadDot ? `sticky_unread_dot_on_viewed_inbox_session(unread=${inboxUnread},status=${status})` : null,
        matchedRows: 1,
        rowState: status || (inboxUnread === 'true' ? 'unread' : 'seen'),
        hasUnreadDot,
      };
    }
    return {
      applicable: true,
      ok: false,
      reason: `target_session_row_not_rendered:${sid}`,
      matchedRows: 0,
      hasUnreadDot: false,
    };
  }, sessionId);
}

/**
 * F13 regression gate: Persona / subagent stream must render at most one active
 * status row per subagent id and must not pile up stale repeated error banners at
 * the bottom of the transcript.
 */
export async function verifyPersonaSubagentSingleRowNoErrorPileup(page) {
  return page.evaluate(() => {
    const subRows = [...document.querySelectorAll('[data-subagent-row][data-agent-id], [data-agent-row][data-agent-id]')];
    const seen = new Map();
    const duplicateAgentIds = [];
    for (const el of subRows) {
      const aid = el.dataset.agentId;
      if (!aid) continue;
      const count = (seen.get(aid) ?? 0) + 1;
      seen.set(aid, count);
      if (count === 2) duplicateAgentIds.push(aid);
    }
    const bottomErrors = [
      ...document.querySelectorAll('[data-transcript-scroll] [role="alert"], [data-persona-error], [data-toast="error"]'),
    ];
    const normalizedErrs = bottomErrors.map((e) => (e.textContent ?? '').trim()).filter(Boolean);
    const uniqueErrs = new Set(normalizedErrs);
    const duplicateErrorPileup = normalizedErrs.length - uniqueErrs.size;
    const ok = duplicateAgentIds.length === 0 && duplicateErrorPileup === 0;
    return {
      applicable: true,
      ok,
      reason: !ok
        ? duplicateAgentIds.length > 0
          ? `duplicate_subagent_rows:${duplicateAgentIds.slice(0, 5).join(',')}`
          : `stale_bottom_error_pileup:${duplicateErrorPileup}`
        : null,
      duplicateAgentIds: duplicateAgentIds.slice(0, 10),
      duplicateErrorPileup,
    };
  });
}

/**
 * F13 regression gate: cold open / top-of-scroll at t0 must never emit spurious
 * error toasts (matches Toasts.tsx `[data-toast="error"][role="status"]`).
 */
export async function verifyZeroFalseTopScrollErrorToast(page) {
  return page.evaluate(() => {
    const toasts = [...document.querySelectorAll('[data-toast="error"][role="status"], [data-toast="error"], [data-toast][role="alert"]')];
    const uniqueNodes = [...new Set(toasts)];
    const texts = uniqueNodes.map((t) => (t.textContent ?? '').trim()).filter(Boolean);
    return {
      applicable: true,
      ok: uniqueNodes.length === 0,
      reason: uniqueNodes.length > 0 ? `false_error_toast:${(texts[0] ?? 'empty').slice(0, 120)}` : null,
      errorToastCount: uniqueNodes.length,
      samples: texts.slice(0, 5),
    };
  });
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

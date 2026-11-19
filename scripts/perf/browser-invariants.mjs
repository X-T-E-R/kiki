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

export async function runAppRoutesWalk(page, { deepLink, guards }) {
  const visited = [];
  for (const spec of APP_WALK_ROUTES) {
    const started = performance.now();
    guards.setPhase(`route:${spec.route}`, { coldOpen: false });
    await page.goto(deepLink(spec.route), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector(spec.readySelector, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const boundary = await guards.assertNoErrorBoundary(`route:${spec.route}`);
    visited.push({
      route: spec.route,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      boundaryHit: boundary?.kind ?? null,
    });
  }
  return visited;
}

/**
 * Timeline integrity monitor for Playwright proofs. Installs an in-page
 * sampler that runs once per painted frame and checks every visible
 * transcript list:
 *   - overlap: consecutive virtual rows whose boxes intersect;
 *   - hole: a gap between consecutive rows larger than the list's row gap;
 *   - escape: row content painting below its own row box.
 * A violation seen on two consecutive samples is "persistent"; a one-frame
 * violation is "transient" (still a visible flicker, still reported).
 */

const MONITOR = () => {
  const GAP = 16;
  const TOLERANCE = 1.5;
  // `runs`: consecutive-frame count per live violation; `longest`: the worst
  // run per kind since the last drain (how long a user could see it).
  const state = { label: 'boot', frames: 0, counts: {}, samples: [], runs: new Map(), longest: {} };
  window.__kikiTimeline = state;
  const record = (kind, detail, signature, run) => {
    const persistent = run > 1;
    const bucket = `${state.label}|${kind}|${persistent ? 'persistent' : 'transient'}`;
    state.counts[bucket] = (state.counts[bucket] ?? 0) + 1;
    const worst = state.longest[kind];
    if (worst === undefined || run > worst.frames) state.longest[kind] = { frames: run, label: state.label, ...detail };
    if (state.samples.length < 400) {
      state.samples.push({ label: state.label, kind, persistent, frame: state.frames, ...detail });
    }
  };
  const describe = (element) =>
    element.querySelector('[data-block-id]')?.getAttribute('data-block-id')
    ?? `#${element.getAttribute('data-index')}`;
  const scan = () => {
    const found = [];
    for (const scroll of document.querySelectorAll('[data-transcript-scroll]')) {
      const viewport = scroll.getBoundingClientRect();
      if (viewport.height === 0 || viewport.width === 0) continue;
      const host = scroll.closest('[data-agent-workspace-target]')?.getAttribute('data-agent-workspace-target') ?? '?';
      const items = [...scroll.querySelectorAll('[data-transcript-virtual-item]')]
        .map((element) => ({ element, index: Number(element.getAttribute('data-index')), rect: element.getBoundingClientRect() }))
        .sort((left, right) => left.index - right.index);
      for (let i = 0; i < items.length; i += 1) {
        const current = items[i];
        const inView = current.rect.bottom > viewport.top && current.rect.top < viewport.bottom;
        const inner = current.element.firstElementChild;
        if (inner !== null && inView) {
          const escape = inner.getBoundingClientRect().bottom - current.rect.bottom;
          if (escape > TOLERANCE) {
            found.push({ kind: 'escape', signature: `${host}|escape|${current.index}`, detail: { host, index: current.index, row: describe(current.element), px: Math.round(escape) } });
          }
        }
        const next = items[i + 1];
        if (next === undefined || next.index !== current.index + 1) continue;
        const pairInView = Math.max(current.rect.bottom, next.rect.bottom) > viewport.top
          && Math.min(current.rect.top, next.rect.top) < viewport.bottom;
        if (!pairInView) continue;
        const gap = next.rect.top - current.rect.bottom;
        const kind = gap < -TOLERANCE ? 'overlap' : gap > GAP + TOLERANCE ? 'hole' : null;
        if (kind === null) continue;
        found.push({ kind, signature: `${host}|${kind}|${current.index}`, detail: {
          host, index: current.index, row: describe(current.element), nextRow: describe(next.element),
          px: Math.round(kind === 'overlap' ? -gap : gap - GAP),
        } });
      }
    }
    return found;
  };
  state.scan = () => scan().map(({ kind, detail }) => ({ kind, ...detail }));
  const check = () => {
    state.frames += 1;
    const runs = new Map();
    for (const { kind, signature, detail } of scan()) {
      const run = (state.runs.get(signature) ?? 0) + 1;
      runs.set(signature, run);
      record(kind, detail, signature, run);
    }
    state.runs = runs;
  };
  // Sample after layout of each frame: rAF queues a message that runs after
  // the frame's style/layout/ResizeObserver work has been delivered.
  const channel = new MessageChannel();
  channel.port1.onmessage = check;
  const loop = () => {
    channel.port2.postMessage(0);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

/** Install before the first navigation; re-applied on every reload. */
export async function installTimelineMonitor(page) {
  await page.addInitScript(MONITOR);
}

/** Tag subsequent samples with the step being exercised. */
export async function labelTimeline(page, label) {
  await page.evaluate((next) => {
    if (window.__kikiTimeline !== undefined) window.__kikiTimeline.label = next;
  }, label);
}

/** Read and clear the collected violations. */
export async function drainTimeline(page) {
  return page.evaluate(() => {
    const state = window.__kikiTimeline;
    if (state === undefined) return { frames: 0, counts: {}, samples: [], longest: {} };
    const out = { frames: state.frames, counts: state.counts, samples: state.samples, longest: state.longest };
    state.counts = {};
    state.samples = [];
    state.longest = {};
    return out;
  });
}

/**
 * Settled-state check: wait until the list geometry is unchanged for
 * `frames` consecutive frames (or `timeoutMs`), then scan once.
 */
export async function timelineAtRest(page, { frames = 6, timeoutMs = 3000 } = {}) {
  return page.evaluate(async ({ frames: need, timeoutMs: budget }) => {
    const state = window.__kikiTimeline;
    if (state === undefined) return [];
    const shape = () => [...document.querySelectorAll('[data-transcript-virtual-item]')]
      .map((el) => { const r = el.getBoundingClientRect(); return `${el.dataset.index}:${Math.round(r.top)}:${Math.round(r.height)}`; }).join(',');
    const started = performance.now();
    let last = shape();
    let stable = 0;
    while (stable < need && performance.now() - started < budget) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const next = shape();
      stable = next === last ? stable + 1 : 0;
      last = next;
    }
    return state.scan();
  }, { frames, timeoutMs });
}

/**
 * Longest consecutive-frame run tolerated for an overlap/escape while the
 * layout is changing. One or two frames is the ResizeObserver → reposition
 * hand-off; anything longer is a stale size model the user can read.
 */
export const TIMELINE_MAX_TRANSIENT_FRAMES = 3;

/**
 * Collect both settled-state (at-rest) and live (> transient frame budget)
 * timeline overlap/escape violations without throwing.
 */
export async function collectTimelineIntegrity(page) {
  const rest = await timelineAtRest(page);
  const report = await drainTimeline(page);
  const failures = rest.filter((violation) => violation.kind !== 'hole').map((violation) => ({ at: 'rest', ...violation }));
  for (const kind of ['overlap', 'escape']) {
    const worst = report.longest[kind];
    if (worst !== undefined && worst.frames > TIMELINE_MAX_TRANSIENT_FRAMES) failures.push({ at: 'live', kind, ...worst });
  }
  const totals = summarizeTimeline(report);
  return { frames: report.frames, totals, failures };
}

/**
 * Proof gate: fail when rows overlap / escape at rest, or when an overlap or
 * escape stayed on screen longer than the transient budget. Holes (gaps) are
 * reported but not gated — they never hide content.
 */
export async function assertTimelineIntegrity(page, context) {
  const { frames, totals, failures } = await collectTimelineIntegrity(page);
  if (failures.length > 0) {
    throw new Error(`${context}: timeline rows overlap — ${JSON.stringify(failures.slice(0, 4))} totals=${JSON.stringify(totals)}`);
  }
  return { frames, totals };
}

/**
 * Verify that rendered non-system turns display visible user message content
 * outside collapsed `[data-history-fold]` groups without requiring manual
 * fold expansion.
 */
export async function inspectTranscriptVisibility(page, targetAgentId = 'main') {
  return page.evaluate((aid) => {
    const host = document.querySelector(`[data-agent-workspace-target="${aid}"]`);
    const scroller = host?.querySelector('[data-transcript-scroll]') ?? document.querySelector('[data-transcript-scroll]');
    if (!scroller) {
      return { ok: false, reason: 'no_scroller', turnsChecked: 0, totalVisibleUserBlocks: 0, hiddenUserTurns: [] };
    }
    const rows = [...scroller.querySelectorAll('[data-transcript-virtual-item]')].sort(
      (a, b) => Number(a.getAttribute('data-index') ?? 0) - Number(b.getAttribute('data-index') ?? 0),
    );
    const byTurn = new Map();
    for (let rIdx = 0; rIdx < rows.length; rIdx += 1) {
      const row = rows[rIdx];
      const turnNode = row.querySelector('[data-turn-id]');
      let turnId = turnNode?.getAttribute('data-turn-id');
      if (!turnId && row.querySelector('[data-block-id^="user-"]') !== null) {
        for (let nextIdx = rIdx + 1; nextIdx < rows.length; nextIdx += 1) {
          const nextTurn = rows[nextIdx].querySelector('[data-turn-id]')?.getAttribute('data-turn-id');
          if (nextTurn) {
            turnId = nextTurn;
            break;
          }
        }
      }
      if (!turnId) continue;
      if (!byTurn.has(turnId)) {
        byTurn.set(turnId, { rows: [], visibleUserBlocks: 0, foldedBlocks: 0, assistantBlocks: 0 });
      }
      const entry = byTurn.get(turnId);
      entry.rows.push(row);
      for (const el of row.querySelectorAll('[data-block-id^="user-"]')) {
        const insideCollapsedFold = el.closest('[data-history-fold]:not([data-history-fold-open])') !== null;
        const text = (el.textContent ?? '').trim();
        const hasMedia = el.querySelector('[data-user-media]') !== null;
        if (!insideCollapsedFold && (text.length > 0 || hasMedia)) {
          entry.visibleUserBlocks += 1;
        }
      }
      if (row.querySelector('[data-history-fold]') !== null) entry.foldedBlocks += 1;
      if (row.querySelector('[data-block-id^="assistant-"], [data-block-id^="agent-frame-"], [data-assistant-prose]') !== null) {
        entry.assistantBlocks += 1;
      }
    }
    const turnIds = [...byTurn.keys()];
    const hiddenUserTurns = [];
    const systemSelector = [
      '[data-subagent-ended]',
      '[data-subagent-event]',
      '[data-agent-message-id]',
      '[data-agent-message-sender]',
      '[data-model-switch-notice]',
      '[data-compaction-history]',
      '[data-compaction-summary]',
      '[data-notice-key]',
      '[data-history-fold-origin="system"]',
      '[data-history-fold-incomplete]',
      '[data-turn-gap="start"]',
      '[data-turn-gap="turn"]',
      '[data-block-id^="system-"]',
      '[data-block-id^="reminder-"]',
      '[data-block-id^="skill-"]',
      '[data-block-id^="shell-"]',
      '[data-block-id^="fold-system-"]',
      '[data-block-id^="fold-reminder-"]',
      '[data-block-id^="fold-skill-"]',
      '[data-block-id^="fold-shell-"]',
    ].join(', ');
    let nonSystemTurnsChecked = 0;
    for (let i = 1; i < turnIds.length; i += 1) {
      const tid = turnIds[i];
      const info = byTurn.get(tid);
      const hasSystemOrigin = info.rows.some((r) => r.querySelector(systemSelector) !== null);
      if (hasSystemOrigin) continue;
      nonSystemTurnsChecked += 1;
      if (info.visibleUserBlocks === 0 && (info.foldedBlocks > 0 || info.assistantBlocks > 0)) {
        hiddenUserTurns.push(tid);
      }
    }
    const totalVisibleUserBlocks = [...byTurn.values()].reduce((acc, v) => acc + v.visibleUserBlocks, 0);
    const ok = hiddenUserTurns.length === 0 && (nonSystemTurnsChecked === 0 || totalVisibleUserBlocks > 0);
    return {
      ok,
      reason: ok ? null : hiddenUserTurns.length > 0 ? 'hidden_user_turns' : 'no_visible_user_blocks',
      turnsChecked: nonSystemTurnsChecked,
      totalVisibleUserBlocks,
      hiddenUserTurns,
    };
  }, targetAgentId);
}

/** Totals per `kind:persistence` across labels. */
export function summarizeTimeline(report) {
  const totals = {};
  for (const [bucket, count] of Object.entries(report.counts)) {
    const [, kind, persistence] = bucket.split('|');
    const key = `${kind}:${persistence}`;
    totals[key] = (totals[key] ?? 0) + count;
  }
  return totals;
}

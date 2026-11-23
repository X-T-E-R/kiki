/**
 * Timeline integrity monitor for Playwright proofs. Installs an in-page
 * sampler that runs once per painted frame and checks every visible
 * transcript list:
 *   - overlap: consecutive virtual rows whose boxes have positive-area intersection;
 *   - tail-overlap: last virtual row intersecting `[data-transcript-tail-slot]`;
 *   - escape: visible row content (respecting legitimate scroll clips) painting
 *     below its own row box;
 *   - hole: a gap between consecutive rows larger than the list's row gap (diagnostic).
 * Every painted frame is gated: zero multi-frame pardons and zero multi-pixel
 * tolerances (only a 0.5px float-rounding subpixel epsilon). Missing monitor
 * installation or zero sampled frames is a hard failure.
 */

const MONITOR = () => {
  const GAP = 16;
  const EPSILON = 0.5;
  const INTERSECTION_EPSILON = 0.01;
  const round2 = (value) => Number(value.toFixed(2));
  const getZoom = () => {
    const inline = Number.parseFloat(document.documentElement.style.zoom);
    if (Number.isFinite(inline) && inline > 0) return inline;
    const computed = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    return Number.isFinite(computed) && computed > 0 ? computed : 1;
  };
  const state = {
    installed: true,
    label: 'boot',
    frames: 0,
    windowFrames: 0,
    rowPairSamples: 0,
    tailPairSamples: 0,
    observedHeightChanges: 0,
    counts: {},
    samples: [],
    runs: new Map(),
    longest: {},
    firstOffendingFrame: null,
    lastHeights: new Map(),
  };
  window.__kikiTimeline = state;
  const record = (kind, detail, signature, run) => {
    const persistent = run > 1;
    const bucket = `${state.label}|${kind}|${persistent ? 'persistent' : 'transient'}`;
    state.counts[bucket] = (state.counts[bucket] ?? 0) + 1;
    const worst = state.longest[kind];
    if (worst === undefined || run > worst.frames || (run === worst.frames && detail.px > (worst.px ?? 0))) {
      state.longest[kind] = { frames: run, label: state.label, ...detail };
    }
    if (kind !== 'hole' && state.firstOffendingFrame === null) {
      state.firstOffendingFrame = { frame: state.frames, label: state.label, kind, ...detail };
    }
    if (state.samples.length < 400) {
      state.samples.push({ label: state.label, kind, persistent, frame: state.frames, ...detail });
    }
  };
  const describe = (element) =>
    element.querySelector('[data-block-id]')?.getAttribute('data-block-id')
    ?? `#${element.getAttribute('data-index')}`;
  const isVerticalClip = (el) => {
    const oy = getComputedStyle(el).overflowY;
    return oy === 'hidden' || oy === 'clip' || oy === 'auto' || oy === 'scroll';
  };
  const visibleBottomRespectingClips = (rowElement, rowRect) => {
    let maxBottom = rowRect.bottom;
    const inner = rowElement.firstElementChild;
    if (inner === null) return maxBottom;
    const innerRect = inner.getBoundingClientRect();
    if (innerRect.width > EPSILON && innerRect.height > EPSILON) {
      maxBottom = Math.max(maxBottom, innerRect.bottom);
    }
    const stack = [{ node: inner, clipBottom: isVerticalClip(inner) ? innerRect.bottom : Infinity }];
    let visited = 0;
    while (stack.length > 0 && visited < 48) {
      const { node, clipBottom } = stack.pop();
      visited += 1;
      for (let child = node.firstElementChild; child !== null; child = child.nextElementSibling) {
        if (child.hasAttribute('data-row-actions')) continue;
        const st = getComputedStyle(child);
        if (
          st.display === 'none' ||
          st.visibility === 'hidden' ||
          Number.parseFloat(st.opacity) === 0 ||
          st.position === 'absolute' ||
          st.position === 'fixed'
        ) {
          continue;
        }
        const rect = child.getBoundingClientRect();
        if (rect.width <= EPSILON || rect.height <= EPSILON) continue;
        const effectiveBottom = Math.min(rect.bottom, clipBottom);
        if (effectiveBottom > maxBottom) maxBottom = effectiveBottom;
        const nextClip = isVerticalClip(child) ? Math.min(clipBottom, rect.bottom) : clipBottom;
        if (child.firstElementChild !== null) {
          stack.push({ node: child, clipBottom: nextClip });
        }
      }
    }
    return maxBottom;
  };
  const rectIntersection2D = (a, b) => {
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return { overlapX, overlapY, positiveArea: overlapX > INTERSECTION_EPSILON && overlapY > INTERSECTION_EPSILON };
  };
  const packRect = (r) => ({
    top: round2(r.top),
    bottom: round2(r.bottom),
    left: round2(r.left),
    right: round2(r.right),
    width: round2(r.width),
    height: round2(r.height),
  });
  const scan = (countSamples = false) => {
    const found = [];
    const zoom = getZoom();
    for (const scroll of document.querySelectorAll('[data-transcript-scroll]')) {
      const viewport = scroll.getBoundingClientRect();
      if (viewport.height === 0 || viewport.width === 0) continue;
      const host = scroll.closest('[data-agent-workspace-target]')?.getAttribute('data-agent-workspace-target') ?? '?';
      const items = [...scroll.querySelectorAll('[data-transcript-virtual-item]')]
        .map((element) => ({ element, index: Number(element.getAttribute('data-index')), rect: element.getBoundingClientRect() }))
        .sort((left, right) => left.index - right.index);
      for (let i = 0; i < items.length; i += 1) {
        const current = items[i];
        const heightKey = `${host}|${current.index}`;
        const prevHeight = state.lastHeights.get(heightKey);
        if (prevHeight !== undefined && Math.abs(current.rect.height - prevHeight) > 1) {
          if (countSamples) state.observedHeightChanges += 1;
        }
        state.lastHeights.set(heightKey, current.rect.height);

        const inView = current.rect.bottom > viewport.top && current.rect.top < viewport.bottom;
        if (inView && current.rect.width > EPSILON && current.rect.height > EPSILON) {
          const contentBottom = visibleBottomRespectingClips(current.element, current.rect);
          const escape = contentBottom - current.rect.bottom;
          if (escape > EPSILON) {
            found.push({
              kind: 'escape',
              signature: `${host}|escape|${current.index}`,
              detail: {
                host,
                index: current.index,
                row: describe(current.element),
                px: round2(escape),
                zoom,
                rowRect: packRect(current.rect),
                contentBottom: round2(contentBottom),
              },
            });
          }
        }
        const next = items[i + 1];
        if (next === undefined || next.index !== current.index + 1) continue;
        const pairInView = Math.max(current.rect.bottom, next.rect.bottom) > viewport.top
          && Math.min(current.rect.top, next.rect.top) < viewport.bottom;
        if (!pairInView) continue;
        if (countSamples) state.rowPairSamples += 1;
        const inter = rectIntersection2D(current.rect, next.rect);
        const gap = next.rect.top - current.rect.bottom;
        const kind = inter.positiveArea ? 'overlap' : gap > GAP + EPSILON ? 'hole' : null;
        if (kind === null) continue;
        found.push({
          kind,
          signature: `${host}|${kind}|${current.index}`,
          detail: {
            host,
            index: current.index,
            row: describe(current.element),
            nextRow: describe(next.element),
            px: round2(kind === 'overlap' ? inter.overlapY : gap - GAP),
            zoom,
            rowRect: packRect(current.rect),
            nextRect: packRect(next.rect),
          },
        });
      }
      const tailSlot = scroll.querySelector('[data-transcript-tail-slot]');
      if (tailSlot !== null && items.length > 0) {
        const tailRect = tailSlot.getBoundingClientRect();
        const last = items[items.length - 1];
        if (tailRect.height > EPSILON && tailRect.width > EPSILON) {
          const pairInView = Math.max(last.rect.bottom, tailRect.bottom) > viewport.top
            && Math.min(last.rect.top, tailRect.top) < viewport.bottom;
          if (pairInView) {
            if (countSamples) state.tailPairSamples += 1;
            const tailInter = rectIntersection2D(last.rect, tailRect);
            if (tailInter.positiveArea) {
              found.push({
                kind: 'tail-overlap',
                signature: `${host}|tail-overlap|${last.index}`,
                detail: {
                  host,
                  index: last.index,
                  row: describe(last.element),
                  nextRow: '[data-transcript-tail-slot]',
                  px: round2(tailInter.overlapY),
                  zoom,
                  rowRect: packRect(last.rect),
                  tailRect: packRect(tailRect),
                },
              });
            }
          }
        }
      }
    }
    return found;
  };
  state.scan = () => scan(false).map(({ kind, detail }) => ({ kind, ...detail }));
  const check = () => {
    state.frames += 1;
    state.windowFrames += 1;
    const runs = new Map();
    for (const { kind, signature, detail } of scan(true)) {
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
    if (state === undefined) {
      return {
        installed: false,
        frames: 0,
        windowFrames: 0,
        rowPairSamples: 0,
        tailPairSamples: 0,
        observedHeightChanges: 0,
        counts: {},
        samples: [],
        longest: {},
        firstOffendingFrame: null,
      };
    }
    const out = {
      installed: true,
      frames: state.frames,
      windowFrames: state.windowFrames,
      rowPairSamples: state.rowPairSamples,
      tailPairSamples: state.tailPairSamples,
      observedHeightChanges: state.observedHeightChanges,
      counts: state.counts,
      samples: state.samples,
      longest: state.longest,
      firstOffendingFrame: state.firstOffendingFrame,
    };
    state.windowFrames = 0;
    state.rowPairSamples = 0;
    state.tailPairSamples = 0;
    state.observedHeightChanges = 0;
    state.counts = {};
    state.samples = [];
    state.longest = {};
    state.firstOffendingFrame = null;
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
    if (state === undefined) return { installed: false, violations: [] };
    const shape = () => [...document.querySelectorAll('[data-transcript-virtual-item]')]
      .map((el) => { const r = el.getBoundingClientRect(); return `${el.dataset.index}:${r.top.toFixed(1)}:${r.height.toFixed(1)}`; }).join(',');
    const started = performance.now();
    let last = shape();
    let stable = 0;
    while (stable < need && performance.now() - started < budget) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const next = shape();
      stable = next === last ? stable + 1 : 0;
      last = next;
    }
    return { installed: true, violations: state.scan() };
  }, { frames, timeoutMs });
}

/**
 * Zero multi-frame pardon: even a single painted frame with an overlap,
 * tail-overlap, or content escape is a visible geometry defect and fails.
 */
export const TIMELINE_MAX_TRANSIENT_FRAMES = 0;

/**
 * Collect both settled-state (at-rest) and live painted-frame
 * timeline overlap/tail-overlap/escape violations without throwing.
 * Fails closed if the monitor is missing or sampled zero frames.
 */
export async function collectTimelineIntegrity(page, options = {}) {
  const restResult = await timelineAtRest(page, options);
  const report = await drainTimeline(page);
  const rest = Array.isArray(restResult) ? restResult : (restResult?.violations ?? []);
  const installed = Boolean(report.installed && (Array.isArray(restResult) || restResult?.installed !== false));
  const failures = [];
  if (!installed) {
    failures.push({ at: 'monitor', kind: 'monitor-missing', reason: 'window.__kikiTimeline was not installed' });
  } else if (report.frames === 0) {
    failures.push({ at: 'monitor', kind: 'zero-frames', reason: 'timeline monitor sampled 0 frames' });
  }
  for (const violation of rest) {
    if (violation.kind !== 'hole') {
      failures.push({ at: 'rest', ...violation });
    }
  }
  for (const kind of ['overlap', 'escape', 'tail-overlap']) {
    const worst = report.longest[kind];
    if (worst !== undefined && worst.frames > TIMELINE_MAX_TRANSIENT_FRAMES) {
      failures.push({ at: 'live', kind, ...worst });
    }
  }
  const totals = summarizeTimeline(report);
  return {
    installed,
    frames: report.frames,
    windowFrames: report.windowFrames ?? report.frames,
    rowPairSamples: report.rowPairSamples ?? 0,
    tailPairSamples: report.tailPairSamples ?? 0,
    observedHeightChanges: report.observedHeightChanges ?? 0,
    firstOffendingFrame: report.firstOffendingFrame ?? null,
    totals,
    failures,
  };
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
      '[data-turn-origin="non-user"]',
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

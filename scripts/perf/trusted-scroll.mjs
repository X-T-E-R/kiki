import { performance } from 'node:perf_hooks';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

/**
 * Locate a safe pointer point inside `[data-transcript-scroll]` that avoids
 * nested scrollable reminder bodies so `page.mouse.wheel` scrolls the main
 * transcript rather than an inner reminder container.
 */
export async function findSafeTranscriptHoverPoint(page, selector = '[data-transcript-scroll]') {
  return page.evaluate((sel) => {
    const scroller = document.querySelector(sel);
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) return null;

    const nestedScrolls = [...scroller.querySelectorAll('.overflow-auto, [data-activity-row] [class*="overflow-"]')]
      .filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2;
      })
      .map((el) => el.getBoundingClientRect());

    const isInsideNested = (x, y) =>
      nestedScrolls.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);

    const candidateXs = [
      rect.left + Math.min(20, rect.width * 0.12),
      rect.right - Math.min(20, rect.width * 0.12),
      rect.left + rect.width * 0.5,
    ];
    const candidateYs = [
      rect.top + rect.height * 0.25,
      rect.top + rect.height * 0.5,
      rect.top + rect.height * 0.72,
      rect.top + Math.min(28, rect.height * 0.12),
    ];
    for (const y of candidateYs) {
      for (const x of candidateXs) {
        if (!isInsideNested(x, y)) {
          return {
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
          };
        }
      }
    }
    return {
      x: Number((rect.left + Math.min(12, rect.width * 0.08)).toFixed(1)),
      y: Number((rect.top + Math.min(18, rect.height * 0.15)).toFixed(1)),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  }, selector);
}

/**
 * Snapshot rendered virtual transcript rows, turn IDs, manifest markers, and
 * scroll geometry from the live DOM.
 */
export async function snapshotVisibleTurns(page, selector = '[data-transcript-scroll]') {
  return page.evaluate((sel) => {
    const scroller = document.querySelector(sel);
    if (!scroller) {
      return {
        found: false,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        maxScroll: 0,
        distanceFromBottomPx: 0,
        itemCount: 0,
        turnIds: [],
        numericTurnIds: [],
        markers: [],
        minMarkerNumber: null,
        maxMarkerNumber: null,
        anchor: null,
        preparingVisible: false,
      };
    }
    const viewport = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll('[data-transcript-virtual-item]')]
      .map((el) => ({
        el,
        index: Number(el.getAttribute('data-index') ?? 0),
        rect: el.getBoundingClientRect(),
      }))
      .sort((a, b) => a.index - b.index);

    const turnIdSet = new Set();
    const numericTurnSet = new Set();
    const markerNumbers = new Set();
    const markers = [];
    let anchor = null;

    for (const row of rows) {
      const turnAttr =
        row.el.getAttribute('data-turn-id') ??
        row.el.querySelector('[data-turn-id]')?.getAttribute('data-turn-id') ??
        null;
      if (turnAttr) {
        turnIdSet.add(turnAttr);
        const numMatch = /(\d+)/u.exec(turnAttr);
        if (numMatch) numericTurnSet.add(Number(numMatch[1]));
      }
      const text = row.el.textContent ?? '';
      const markerMatches = text.match(/TURN_MARKER_(\d{6})/gu);
      if (markerMatches) {
        for (const m of markerMatches) {
          if (!markers.includes(m)) markers.push(m);
          const n = Number(m.slice('TURN_MARKER_'.length));
          if (Number.isFinite(n)) markerNumbers.add(n);
        }
      }
      if (
        anchor === null &&
        row.rect.height > 0 &&
        row.rect.bottom > viewport.top + 4 &&
        row.rect.top < viewport.bottom - 4
      ) {
        const blockId = row.el.querySelector('[data-block-id]')?.getAttribute('data-block-id') ?? null;
        anchor = {
          index: row.index,
          blockId,
          turnId: turnAttr,
          marker: markerMatches?.[0] ?? null,
          offsetFromViewportTop: Number((row.rect.top - viewport.top).toFixed(2)),
        };
      }
    }

    const sortedMarkerNums = [...markerNumbers].sort((a, b) => a - b);
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const distanceFromBottomPx = Number(Math.max(0, maxScroll - scroller.scrollTop).toFixed(2));
    const bodyText = document.body?.innerText ?? '';
    const preparingVisible = /History is preparing|正在加载更早的消息|加载更早/u.test(bodyText);

    return {
      found: true,
      scrollTop: Number(scroller.scrollTop.toFixed(2)),
      scrollHeight: Number(scroller.scrollHeight.toFixed(2)),
      clientHeight: Number(scroller.clientHeight.toFixed(2)),
      maxScroll: Number(maxScroll.toFixed(2)),
      distanceFromBottomPx,
      itemCount: rows.length,
      turnIds: [...turnIdSet],
      numericTurnIds: [...numericTurnSet].sort((a, b) => a - b),
      markers,
      minMarkerNumber: sortedMarkerNums.length > 0 ? sortedMarkerNums[0] : null,
      maxMarkerNumber: sortedMarkerNums.length > 0 ? sortedMarkerNums[sortedMarkerNums.length - 1] : null,
      anchor,
      preparingVisible,
    };
  }, selector);
}

/**
 * Real trusted mouse-wheel scroll upward over `[data-transcript-scroll]`.
 * Never writes `scroller.scrollTop` or dispatches synthetic `new Event('scroll')`.
 */
export async function trustedWheelScrollUp(
  page,
  {
    deltaY = -1200,
    steps = 6,
    pauseMs = 100,
    settleMs = 500,
    selector = '[data-transcript-scroll]',
  } = {},
) {
  const before = await snapshotVisibleTurns(page, selector);
  if (!before.found) {
    return {
      ok: false,
      applicable: false,
      reason: 'no_transcript_scroller',
      wheelsDispatched: 0,
      scrollMoved: false,
      snappedToBottom: false,
      olderTurnsLoaded: false,
      before,
      after: before,
    };
  }
  if (before.maxScroll < 200) {
    return {
      ok: false,
      applicable: false,
      reason: 'short_transcript',
      wheelsDispatched: 0,
      scrollMoved: false,
      snappedToBottom: false,
      olderTurnsLoaded: false,
      before,
      after: before,
    };
  }

  const hover = await findSafeTranscriptHoverPoint(page, selector);
  if (!hover) {
    return {
      ok: false,
      applicable: false,
      reason: 'no_hover_point',
      wheelsDispatched: 0,
      scrollMoved: false,
      snappedToBottom: false,
      olderTurnsLoaded: false,
      before,
      after: before,
    };
  }

  await page.mouse.move(hover.x, hover.y);
  let wheelsDispatched = 0;
  let minScrollTopSeen = before.scrollTop;
  let maxDistanceFromBottomSeen = before.distanceFromBottomPx;
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, deltaY);
    wheelsDispatched += 1;
    await sleep(pauseMs);
    const snap = await snapshotVisibleTurns(page, selector);
    if (snap.scrollTop < minScrollTopSeen) minScrollTopSeen = snap.scrollTop;
    if (snap.distanceFromBottomPx > maxDistanceFromBottomSeen) {
      maxDistanceFromBottomSeen = snap.distanceFromBottomPx;
    }
  }
  if (settleMs > 0) {
    await sleep(settleMs);
  }
  const after = await snapshotVisibleTurns(page, selector);
  const scrollMoved =
    after.distanceFromBottomPx > before.distanceFromBottomPx + 40 ||
    minScrollTopSeen < before.scrollTop - 40;
  const snappedToBottom = scrollMoved && after.distanceFromBottomPx < 120;
  const olderTurnIdAppeared =
    (before.minMarkerNumber !== null &&
      after.minMarkerNumber !== null &&
      after.minMarkerNumber < before.minMarkerNumber) ||
    (before.numericTurnIds.length > 0 &&
      after.numericTurnIds.length > 0 &&
      after.numericTurnIds[0] < before.numericTurnIds[0]) ||
    after.turnIds.some((tid) => !before.turnIds.includes(tid));

  return {
    ok: scrollMoved && !snappedToBottom,
    applicable: true,
    reason: !scrollMoved
      ? 'wheel_did_not_move_scroller'
      : snappedToBottom
        ? `snapped_back_distance_${Math.round(after.distanceFromBottomPx)}px`
        : null,
    wheelsDispatched,
    scrollMoved,
    snappedToBottom,
    olderTurnsLoaded: olderTurnIdAppeared,
    distanceFromBottomPx: after.distanceFromBottomPx,
    before,
    after,
  };
}

/**
 * Real trusted mobile touch-drag gestures via CDP `Input.dispatchTouchEvent`.
 * Replaces synthetic `scroller.scrollTop = ...` + `new Event('scroll')` loops.
 */
export async function trustedTouchDragScroll(
  page,
  cdp,
  {
    upSwipes = 6,
    downSwipes = 0,
    distancePx = 280,
    stepsPerSwipe = 6,
    stepDelayMs = 12,
    pauseBetweenSwipesMs = 45,
    selector = '[data-transcript-scroll]',
  } = {},
) {
  const before = await snapshotVisibleTurns(page, selector);
  if (!before.found) {
    return {
      ok: false,
      reason: 'no_transcript_scroller',
      swipesCompleted: 0,
      scrollMoved: false,
      before,
      after: before,
    };
  }
  const hover = await findSafeTranscriptHoverPoint(page, selector);
  if (!hover) {
    return {
      ok: false,
      reason: 'no_touch_point',
      swipesCompleted: 0,
      scrollMoved: false,
      before,
      after: before,
    };
  }

  const { rect } = hover;
  const centerX = Math.round(rect.left + rect.width * 0.5);
  const topY = Math.round(rect.top + Math.max(40, rect.height * 0.22));
  const bottomY = Math.round(rect.top + Math.min(rect.height - 40, rect.height * 0.78));
  const span = Math.max(60, Math.min(distancePx, bottomY - topY));

  const performSwipe = async (startY, endY) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: centerX, y: startY, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
    });
    for (let s = 1; s <= stepsPerSwipe; s += 1) {
      const y = Math.round(startY + ((endY - startY) * s) / stepsPerSwipe);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: centerX, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
      });
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  };

  let swipesCompleted = 0;
  let movedAtAnyPoint = false;
  // Swiping finger DOWN (topY -> topY + span) scrolls the transcript UP toward older messages.
  for (let i = 0; i < upSwipes; i += 1) {
    const prev = await snapshotVisibleTurns(page, selector);
    await performSwipe(topY, topY + span);
    swipesCompleted += 1;
    await sleep(pauseBetweenSwipesMs);
    const curr = await snapshotVisibleTurns(page, selector);
    if (Math.abs(curr.scrollTop - prev.scrollTop) > 8 || curr.distanceFromBottomPx > prev.distanceFromBottomPx + 8) {
      movedAtAnyPoint = true;
    }
  }
  // Swiping finger UP (bottomY -> bottomY - span) scrolls the transcript DOWN toward newer messages.
  for (let i = 0; i < downSwipes; i += 1) {
    const prev = await snapshotVisibleTurns(page, selector);
    await performSwipe(bottomY, bottomY - span);
    swipesCompleted += 1;
    await sleep(pauseBetweenSwipesMs);
    const curr = await snapshotVisibleTurns(page, selector);
    if (Math.abs(curr.scrollTop - prev.scrollTop) > 8) {
      movedAtAnyPoint = true;
    }
  }

  const after = await snapshotVisibleTurns(page, selector);
  const scrollMoved = movedAtAnyPoint || Math.abs(after.scrollTop - before.scrollTop) > 8;
  return {
    ok: swipesCompleted > 0 && (before.maxScroll < 40 || scrollMoved),
    reason: !scrollMoved && before.maxScroll >= 40 ? 'touch_drag_did_not_move_scroller' : null,
    swipesCompleted,
    scrollMoved,
    before,
    after,
  };
}

/**
 * Trusted upward mouse-wheel pagination across `requiredPages` successive
 * unloaded older pages, measuring on a single monotonic host clock from the
 * external boundary-crossing `page.mouse.wheel(0, deltaY)` dispatch until
 * strictly older manifest turn IDs commit & paint without snapping to bottom.
 */
export async function wheelAcrossUnloadedOlderPages(
  page,
  {
    requiredPages = 3,
    pageBudgetMs = 500,
    deltaY = -1200,
    maxApproachWheels = 64,
    pageTimeoutMs = 8_000,
    selector = '[data-transcript-scroll]',
  } = {},
) {
  const pages = [];
  const failures = [];
  const seenMinMarkers = [];
  const olderHttpResponses = [];
  let inFlightOlderRequests = 0;

  const onRequest = (req) => {
    if (req.method() !== 'GET') return;
    const url = req.url();
    if (!url.includes('/transcript')) return;
    if (!url.includes('before_turn=') && !url.includes('before_item=') && !url.includes('beforeTurn=')) return;
    inFlightOlderRequests += 1;
  };
  const onResponse = async (res) => {
    const req = res.request();
    if (req.method() !== 'GET') return;
    const url = req.url();
    if (!url.includes('/transcript')) return;
    if (!url.includes('before_turn=') && !url.includes('before_item=') && !url.includes('beforeTurn=')) return;
    inFlightOlderRequests = Math.max(0, inFlightOlderRequests - 1);
    const receivedAtMs = performance.now();
    const json = await res.json().catch(() => null);
    const data = json?.data ?? json;
    const readiness = data?.read?.readiness ?? data?.read?.kind ?? 'ready';
    const items = Array.isArray(data?.items) ? data.items : [];
    const turnOrdinals = [];
    const markerNums = [];
    for (const item of items) {
      if (item?.kind === 'turn') {
        const ord = Number(item.ordinal);
        if (Number.isFinite(ord)) turnOrdinals.push(ord);
        const m = /TURN_MARKER_(\d{6})/u.exec(String(item.prompt ?? ''));
        if (m) markerNums.push(Number(m[1]));
      }
    }
    let beforeTurn = null;
    let beforeItem = null;
    try {
      const parsedUrl = new URL(res.url());
      beforeTurn = parsedUrl.searchParams.get('before_turn') ?? parsedUrl.searchParams.get('beforeTurn') ?? parsedUrl.searchParams.get('cursor');
      beforeItem = parsedUrl.searchParams.get('before_item') ?? parsedUrl.searchParams.get('beforeItem') ?? parsedUrl.searchParams.get('before');
    } catch {
      // ignore non-standard URLs
    }
    olderHttpResponses.push({
      atMs: receivedAtMs,
      url: res.url(),
      beforeTurn,
      beforeItem,
      status: res.status(),
      readiness,
      itemCount: items.length,
      turnCount: turnOrdinals.length,
      minTurnOrdinal: turnOrdinals.length > 0 ? Math.min(...turnOrdinals) : null,
      minMarkerNumber: markerNums.length > 0 ? Math.min(...markerNums) : null,
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  const initial = await snapshotVisibleTurns(page, selector);
  if (!initial.found || initial.itemCount === 0) {
    page.off('request', onRequest);
    page.off('response', onResponse);
    return {
      ok: false,
      requiredPages,
      completedPages: 0,
      pages,
      failures: ['Transcript scroller or virtual items missing before upward wheel pagination'],
    };
  }

  let lastCommittedServerOldestMarker = null;
  let lastCommittedServerOldestOrdinal = null;
  let consumedHttpIndex = 0;
  const seenOlderCursors = new Set();
  const findQualifyingOlderHttp = () => {
    for (let idx = consumedHttpIndex; idx < olderHttpResponses.length; idx += 1) {
      const r = olderHttpResponses[idx];
      if (r.readiness === 'preparing' || r.itemCount === 0 || r.turnCount === 0) continue;
      const cursorKey = `${r.beforeTurn ?? ''}|${r.beforeItem ?? ''}`;
      if (cursorKey !== '|' && seenOlderCursors.has(cursorKey)) continue;
      const strictlyOlderMarker =
        r.minMarkerNumber !== null &&
        (lastCommittedServerOldestMarker === null || r.minMarkerNumber < lastCommittedServerOldestMarker);
      const strictlyOlderOrdinal =
        r.minTurnOrdinal !== null &&
        (lastCommittedServerOldestOrdinal === null || r.minTurnOrdinal < lastCommittedServerOldestOrdinal);
      if (strictlyOlderMarker || strictlyOlderOrdinal) {
        return { index: idx, response: r, cursorKey };
      }
    }
    return null;
  };

  // Install lightweight rAF gap observer on the page for this pagination series
  await page.evaluate(() => {
    const gaps = [];
    let prev = performance.now();
    let active = true;
    const tick = (now) => {
      const dt = now - prev;
      prev = now;
      if (dt > 34) gaps.push(Number(dt.toFixed(1)));
      if (active) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__kikiWheelGapProbe = {
      drain() {
        const out = [...gaps];
        gaps.length = 0;
        return out;
      },
      stop() {
        active = false;
      },
    };
  });

  try {
    for (let pageIdx = 1; pageIdx <= requiredPages; pageIdx += 1) {
      const hover = await findSafeTranscriptHoverPoint(page, selector);
      if (!hover) {
        failures.push(`Page ${pageIdx}: no safe hover point inside transcript scroller`);
        break;
      }
      await page.mouse.move(hover.x, hover.y);

      await page.evaluate(() => window.__kikiWheelGapProbe?.drain?.());

      // Wheel upward with real trusted wheel events to reach the unloaded top boundary.
      // The first wheel that triggers an in-flight older-page request (or crosses scrollTop <= 180)
      // starts the monotonic boundary-crossing clock.
      let approachWheels = 0;
      let dispatchT0 = null;
      let preBoundarySnap = await snapshotVisibleTurns(page, selector);

      while (approachWheels < maxApproachWheels) {
        const cur = await snapshotVisibleTurns(page, selector);
        if (findQualifyingOlderHttp() !== null) {
          dispatchT0 = dispatchT0 ?? performance.now();
          break;
        }
        if (cur.scrollTop <= 180) {
          preBoundarySnap = cur;
          break;
        }
        const wheelT0 = performance.now();
        const prevInFlight = inFlightOlderRequests;
        const prevRespLen = olderHttpResponses.length;
        await page.mouse.wheel(0, deltaY);
        approachWheels += 1;
        await sleep(30);
        if (inFlightOlderRequests > prevInFlight || olderHttpResponses.length > prevRespLen) {
          dispatchT0 = wheelT0;
          preBoundarySnap = cur;
          break;
        }
        preBoundarySnap = await snapshotVisibleTurns(page, selector);
      }

      const anchorBefore = preBoundarySnap.anchor;
      if (dispatchT0 === null) {
        dispatchT0 = performance.now();
        await page.mouse.wheel(0, deltaY);
      }

      let matchedHttp = null;
      let sawPreparing = false;
      let elapsedMs = null;
      let settledSnap = null;
      let extraNudges = 0;
      const deadline = dispatchT0 + pageTimeoutMs;

      while (performance.now() < deadline) {
        // Check if any preparing response arrived in this page window
        for (let idx = consumedHttpIndex; idx < olderHttpResponses.length; idx += 1) {
          if (olderHttpResponses[idx].readiness === 'preparing') sawPreparing = true;
        }
        const snap = await snapshotVisibleTurns(page, selector);
        if (snap.preparingVisible) sawPreparing = true;

        matchedHttp = findQualifyingOlderHttp();
        if (matchedHttp !== null) {
          // Wait for actual DOM commit (not just HTTP receipt or unrelated bottom growth):
          // timeline must paint a strictly older marker/turn or the matched older page's row
          await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => { r(); }); }));
          const candidateSnap = await snapshotVisibleTurns(page, selector);
          const resp = matchedHttp.response;
          const respMarkerVisible =
            resp.minMarkerNumber !== null &&
            candidateSnap.minMarkerNumber !== null &&
            candidateSnap.minMarkerNumber <= resp.minMarkerNumber;
          const respOrdinalVisible =
            resp.minTurnOrdinal !== null &&
            candidateSnap.numericTurnIds.length > 0 &&
            candidateSnap.numericTurnIds[0] <= resp.minTurnOrdinal;
          const domCommittedOlder =
            (candidateSnap.minMarkerNumber !== null &&
              (preBoundarySnap.minMarkerNumber === null || candidateSnap.minMarkerNumber < preBoundarySnap.minMarkerNumber)) ||
            (candidateSnap.numericTurnIds.length > 0 &&
              (preBoundarySnap.numericTurnIds.length === 0 || candidateSnap.numericTurnIds[0] < preBoundarySnap.numericTurnIds[0])) ||
            respMarkerVisible ||
            respOrdinalVisible ||
            (candidateSnap.anchor?.blockId !== null &&
              preBoundarySnap.anchor?.blockId !== null &&
              candidateSnap.anchor.blockId === preBoundarySnap.anchor.blockId &&
              candidateSnap.anchor.index > preBoundarySnap.anchor.index);
          if (domCommittedOlder) {
            elapsedMs = roundMs(performance.now() - dispatchT0);
            settledSnap = candidateSnap;
            break;
          }
        }

        if (extraNudges < 10) {
          await page.mouse.wheel(0, deltaY);
          extraNudges += 1;
        }
        await sleep(25);
      }

      const rafGaps = await page.evaluate(() => window.__kikiWheelGapProbe?.drain?.() ?? []);
      if (matchedHttp === null || settledSnap === null) {
        const finalSnap = await snapshotVisibleTurns(page, selector);
        const failElapsed = roundMs(performance.now() - dispatchT0);
        pages.push({
          pageIndex: pageIdx,
          ok: false,
          elapsedMs: failElapsed,
          budgetMs: pageBudgetMs,
          approachWheels,
          sawPreparing,
          httpPagesSeenTotal: olderHttpResponses.length,
          previousOldestMarker: lastCommittedServerOldestMarker,
          newOldestMarker: finalSnap.minMarkerNumber,
          snappedToBottom: finalSnap.distanceFromBottomPx < 120,
          anchorBefore,
          anchorAfter: finalSnap.anchor,
          rafGapCount: rafGaps.length,
          maxRafGapMs: rafGaps.length > 0 ? Math.max(...rafGaps) : 0,
          reason: sawPreparing ? 'timed_out_while_preparing' : 'unloaded_older_page_never_committed',
        });
        failures.push(
          `Page ${pageIdx}: timed out after ${failElapsed}ms waiting for unloaded older page (< ${lastCommittedServerOldestMarker ?? lastCommittedServerOldestOrdinal ?? 'initial_tail'})`,
        );
        break;
      }

      consumedHttpIndex = matchedHttp.index + 1;
      if (matchedHttp.cursorKey && matchedHttp.cursorKey !== '|') {
        seenOlderCursors.add(matchedHttp.cursorKey);
      }
      const resp = matchedHttp.response;

      // Hold briefly to verify no snap-back to bottom and reading anchor stays preserved
      await sleep(160);
      const postHoldSnap = await snapshotVisibleTurns(page, selector);
      const snappedToBottom = postHoldSnap.distanceFromBottomPx < 120;
      const anchorStillPresent = Boolean(
        anchorBefore?.blockId &&
          postHoldSnap.anchor?.blockId === anchorBefore.blockId &&
          Math.abs((postHoldSnap.anchor.offsetFromViewportTop ?? 0) - (anchorBefore.offsetFromViewportTop ?? 0)) <= 240,
      );
      const stayedAtOlderBoundaryWithoutBlockAnchor =
        !anchorBefore?.blockId &&
        postHoldSnap.scrollTop < postHoldSnap.maxScroll - 120 &&
        ((postHoldSnap.minMarkerNumber !== null &&
          preBoundarySnap.minMarkerNumber !== null &&
          postHoldSnap.minMarkerNumber < preBoundarySnap.minMarkerNumber) ||
          (postHoldSnap.numericTurnIds.length > 0 &&
            preBoundarySnap.numericTurnIds.length > 0 &&
            postHoldSnap.numericTurnIds[0] < preBoundarySnap.numericTurnIds[0]));
      const anchorPreserved = !snappedToBottom && (anchorStillPresent || stayedAtOlderBoundaryWithoutBlockAnchor);
      const withinBudget = elapsedMs !== null && elapsedMs < pageBudgetMs;

      const pageRecord = {
        pageIndex: pageIdx,
        ok: withinBudget && !snappedToBottom && anchorPreserved,
        elapsedMs,
        budgetMs: pageBudgetMs,
        approachWheels,
        sawPreparing,
        httpStatus: resp.status,
        httpItemCount: resp.itemCount,
        httpTurnCount: resp.turnCount,
        previousOldestMarker: lastCommittedServerOldestMarker,
        newOldestMarker: resp.minMarkerNumber,
        previousOldestOrdinal: lastCommittedServerOldestOrdinal,
        newOldestOrdinal: resp.minTurnOrdinal,
        domVisibleOldestMarker: postHoldSnap.minMarkerNumber,
        distanceFromBottomPx: postHoldSnap.distanceFromBottomPx,
        snappedToBottom,
        anchorPreserved,
        anchorBefore,
        anchorAfter: postHoldSnap.anchor,
        rafGapCount: rafGaps.length,
        maxRafGapMs: rafGaps.length > 0 ? Math.max(...rafGaps) : 0,
      };
      pages.push(pageRecord);

      if (!withinBudget) {
        failures.push(`Page ${pageIdx}: elapsedMs=${elapsedMs}ms >= ${pageBudgetMs}ms budget`);
      }
      if (snappedToBottom) {
        failures.push(`Page ${pageIdx}: snapped back to bottom (distance=${postHoldSnap.distanceFromBottomPx}px)`);
      }

      if (resp.minMarkerNumber !== null) {
        lastCommittedServerOldestMarker = resp.minMarkerNumber;
        seenMinMarkers.push(resp.minMarkerNumber);
      }
      if (resp.minTurnOrdinal !== null) {
        lastCommittedServerOldestOrdinal = resp.minTurnOrdinal;
      }
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    await page.evaluate(() => window.__kikiWheelGapProbe?.stop?.()).catch(() => undefined);
  }

  const completedPages = pages.filter((p) => p.ok).length;
  return {
    ok: failures.length === 0 && completedPages >= requiredPages,
    requiredPages,
    completedPages,
    seenMinMarkers,
    totalOlderHttpResponses: olderHttpResponses.length,
    pages,
    failures,
  };
}

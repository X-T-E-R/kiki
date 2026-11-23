function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

/**
 * Verify product CSS root zoom (`document.documentElement.style.zoom`) and
 * desktop `xl:` breakpoint match without substituting DPR or pinch zoom.
 */
export async function verifyCssRootZoomAndViewport(page, expectedZoom = 1.25) {
  return page.evaluate((target) => {
    const root = document.documentElement;
    const inlineZoom = Number.parseFloat(root.style.zoom);
    const computedZoom = Number.parseFloat(getComputedStyle(root).zoom);
    const effectiveZoom = Number.isFinite(inlineZoom) && inlineZoom > 0
      ? inlineZoom
      : Number.isFinite(computedZoom) && computedZoom > 0
        ? computedZoom
        : 1;
    const kikiZoomDataset = root.dataset.kikiZoom ?? null;
    const xlMatches = window.matchMedia('(min-width: 1280px)').matches;
    const lgMatches = window.matchMedia('(min-width: 1024px)').matches;
    return {
      ok: Math.abs(effectiveZoom - target) < 0.01 && xlMatches,
      expectedZoom: target,
      inlineZoom: Number.isFinite(inlineZoom) ? inlineZoom : null,
      computedZoom: Number.isFinite(computedZoom) ? computedZoom : null,
      effectiveZoom,
      kikiZoomDataset,
      xlMatches,
      lgMatches,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
  }, expectedZoom);
}

/**
 * Measure the 4 desktop panes (Sidebar, Center, Plugin Workbench/Preview, Right
 * Inspector Rail), recording layout width (`offsetWidth`) and scaled DOMRect
 * separately, and checking non-overlay, independent, non-overlapping placement.
 */
export async function measureFourColumns(page) {
  return page.evaluate(() => {
    const pack = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible =
        !el.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        r.width > 1 &&
        r.height > 1;
      const isOverlay = style.position === 'fixed' || style.position === 'absolute';
      return {
        visible,
        isOverlay,
        layoutWidthPx: Math.round(el.offsetWidth),
        layoutHeightPx: Math.round(el.offsetHeight),
        rect: {
          left: Number(r.left.toFixed(2)),
          right: Number(r.right.toFixed(2)),
          top: Number(r.top.toFixed(2)),
          bottom: Number(r.bottom.toFixed(2)),
          width: Number(r.width.toFixed(2)),
          height: Number(r.height.toFixed(2)),
        },
      };
    };

    const sidebar = document.querySelector('[data-session-sidebar]');
    const center = document.querySelector('.conversation-center') ?? document.querySelector('.conversation-shell');
    const workbench = document.querySelector('[data-preview-workspace]:not([hidden])');
    const rail = document.querySelector('[data-session-rail]');

    const panes = {
      sidebar: pack(sidebar),
      center: pack(center),
      workbench: pack(workbench),
      rail: pack(rail),
    };

    const ordered = [
      ['sidebar', panes.sidebar],
      ['center', panes.center],
      ['workbench', panes.workbench],
      ['rail', panes.rail],
    ];
    const failures = [];
    for (const [name, info] of ordered) {
      if (!info || !info.visible) {
        failures.push(`column_${name}_not_visible`);
      } else if (info.isOverlay) {
        failures.push(`column_${name}_is_overlay`);
      } else if (info.layoutWidthPx <= 0 || info.rect.width <= 0) {
        failures.push(`column_${name}_zero_width`);
      }
    }
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const [aName, a] = ordered[i];
      const [bName, b] = ordered[i + 1];
      if (a?.visible && b?.visible && a.rect.right - b.rect.left > 1.0) {
        failures.push(`columns_overlap:${aName}_and_${bName}(${(a.rect.right - b.rect.left).toFixed(2)}px)`);
      }
    }

    return {
      ok: failures.length === 0,
      panes,
      centerLayoutWidthPx: panes.center?.layoutWidthPx ?? 0,
      centerScaledWidthPx: panes.center?.rect?.width ?? 0,
      failures,
    };
  });
}

/**
 * Open all 4 desktop columns through real UI controls:
 *   1. Left Sidebar (expanded)
 *   2. Center conversation column
 *   3. Plugin Workbench / Preview pane (`[data-preview-toggle]` or plugin panel button)
 *   4. Right Inspector Rail (`[data-rail-toggle]`)
 */
export async function openFourColumnDesktopLayout(page) {
  // 1. Ensure sidebar is expanded (not collapsed)
  const sidebarCollapsed = await page.evaluate(
    () => document.querySelector('[data-session-sidebar]')?.getAttribute('data-sidebar-collapsed') === 'true',
  );
  if (sidebarCollapsed) {
    const expandBtn = page.locator('[data-sidebar-toggle], button[aria-controls="app-sidebar"]').first();
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click({ timeout: 5_000 }).catch(() => undefined);
      await sleep(200);
    }
  }

  // 2. Ensure Right Inspector Rail is open
  const railVisible = await page.locator('[data-session-rail]').first().isVisible().catch(() => false);
  if (!railVisible) {
    const railToggle = page.locator('[data-rail-toggle]').first();
    if (await railToggle.isVisible().catch(() => false)) {
      await railToggle.click({ timeout: 5_000 });
      await page.locator('[data-session-rail]').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
      await sleep(200);
    }
  }

  // 3. Open Plugin Workbench or Preview pane via real header button or file reference
  const workbenchVisible = await page.locator('[data-preview-workspace]:not([hidden])').first().isVisible().catch(() => false);
  if (!workbenchVisible) {
    const pluginBtn = page.locator('[data-workspace-panels-group] button:not([data-preview-toggle])').first();
    const previewBtn = page.locator('[data-preview-toggle]').first();
    if (await pluginBtn.isVisible().catch(() => false)) {
      await pluginBtn.click({ timeout: 5_000 }).catch(() => undefined);
      await sleep(250);
    }
    let stillHidden = !(await page.locator('[data-preview-workspace]:not([hidden])').first().isVisible().catch(() => false));
    if (stillHidden && (await previewBtn.isVisible().catch(() => false))) {
      await previewBtn.click({ timeout: 5_000 });
      await page.locator('[data-preview-workspace]:not([hidden])').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
      await sleep(250);
      stillHidden = !(await page.locator('[data-preview-workspace]:not([hidden])').first().isVisible().catch(() => false));
    }
    if (stillHidden) {
      // Expand Right Rail's folded `动态` (`[data-inspector-recent]`) and click a real file entry to open Preview Workspace
      const recentSection = page.locator('[data-session-rail] [data-inspector-recent]').first();
      if (await recentSection.count().catch(() => 0)) {
        await recentSection.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        const foldBtn = recentSection.locator('> button').first();
        const fileList = recentSection.locator('ol button:not([data-rail-open-agent])');
        if ((await fileList.count().catch(() => 0)) === 0 && (await foldBtn.isVisible().catch(() => false))) {
          await foldBtn.click({ timeout: 5_000 }).catch(() => undefined);
          await sleep(250);
        }
        const firstFileBtn = recentSection.locator('ol button:not([data-rail-open-agent])').first();
        if (await firstFileBtn.isVisible().catch(() => false)) {
          await firstFileBtn.click({ timeout: 5_000 }).catch(() => undefined);
          await page.locator('[data-preview-workspace]:not([hidden])').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
          await sleep(300);
          stillHidden = !(await page.locator('[data-preview-workspace]:not([hidden])').first().isVisible().catch(() => false));
        }
      }
    }
    if (stillHidden) {
      // Secondary real-UI fallback: click a file button inside the transcript
      const fileTrigger = page
        .locator('[data-transcript-scroll] button:has-text("README.md"), [data-transcript-scroll] button:has-text("mod-")')
        .first();
      if (await fileTrigger.isVisible().catch(() => false)) {
        await fileTrigger.click({ timeout: 5_000 }).catch(() => undefined);
        await page.locator('[data-preview-workspace]:not([hidden])').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
        await sleep(250);
      }
    }
  }

  // Re-verify Right Rail didn't auto-yield; if it yielded, reopen via real toggle
  const railStillVisible = await page.locator('[data-session-rail]').first().isVisible().catch(() => false);
  if (!railStillVisible) {
    const railToggle = page.locator('[data-rail-toggle]').first();
    if (await railToggle.isVisible().catch(() => false)) {
      await railToggle.click({ timeout: 5_000 }).catch(() => undefined);
      await page.locator('[data-session-rail]').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      await sleep(200);
    }
  }

  return measureFourColumns(page);
}

/**
 * Resize the center conversation column toward `targetLayoutPx` (e.g. 360 or 480)
 * using real pointer drags on `.preview-workspace__resizer` (and `[data-rail-resizer]`).
 */
export async function resizeCenterColumnToWidth(page, targetLayoutPx) {
  const getZoom = () =>
    page.evaluate(() => {
      const z = Number.parseFloat(document.documentElement.style.zoom || getComputedStyle(document.documentElement).zoom);
      return Number.isFinite(z) && z > 0 ? z : 1;
    });

  const dragResizer = async (selector, deltaLayoutPx) => {
    const zoom = await getZoom();
    const deltaViewportPx = deltaLayoutPx * zoom;
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 220) };
    }, selector);
    if (!box) return false;
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    const steps = 4;
    for (let s = 1; s <= steps; s += 1) {
      await page.mouse.move(box.x + (deltaViewportPx * s) / steps, box.y);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(120);
    return true;
  };

  // Pick a desktop xl: (>= 1360px) viewport that can physically hold all 4 docked columns at zoom 1.25
  // around the requested center layout width (1360px naturally reproduces narrow 360px 4-col compression;
  // ~1680px accommodates 480px center + 240 sidebar + 320 preview + 300 rail at zoom 1.25).
  let snap = await measureFourColumns(page);
  const zoom = await getZoom();
  const currentViewport = page.viewportSize() ?? { width: 1360, height: 860 };
  if (targetLayoutPx <= 400) {
    // Compressed 4-column reference viewport (1360x860 @ zoom 1.25)
    if (currentViewport.width !== 1360 || currentViewport.height !== 860) {
      await page.setViewportSize({ width: 1360, height: 860 });
      await sleep(240);
      snap = await measureFourColumns(page);
    }
  } else if (snap.ok && Math.abs(targetLayoutPx - snap.centerLayoutWidthPx) > 28) {
    const nonCenterLayoutPx =
      (snap.panes.sidebar?.layoutWidthPx ?? 240) +
      (snap.panes.workbench?.layoutWidthPx ?? 320) +
      (snap.panes.rail?.layoutWidthPx ?? 280) +
      32;
    const desiredViewportW = Math.max(1360, Math.min(1920, Math.round((targetLayoutPx + nonCenterLayoutPx) * zoom)));
    if (Math.abs(desiredViewportW - currentViewport.width) >= 24) {
      await page.setViewportSize({ width: desiredViewportW, height: currentViewport.height });
      await sleep(220);
      snap = await measureFourColumns(page);
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const diff = targetLayoutPx - snap.centerLayoutWidthPx;
    if (Math.abs(diff) <= 28) break;
    // Moving preview resizer RIGHT (+x) makes center wider; LEFT (-x) makes center narrower
    const draggedPreview = await dragResizer('.preview-workspace__resizer', diff);
    await sleep(100);
    snap = await measureFourColumns(page);
    const remaining = targetLayoutPx - snap.centerLayoutWidthPx;
    if (Math.abs(remaining) > 28) {
      await dragResizer('[data-rail-resizer]', remaining);
      await sleep(100);
      snap = await measureFourColumns(page);
    }
    if (!draggedPreview) break;
  }

  const cssMinWidthPx = await page.evaluate(() => {
    const c = document.querySelector('.conversation-center');
    const raw = c ? Number.parseFloat(getComputedStyle(c).minWidth) : Number.NaN;
    return Number.isFinite(raw) ? raw : null;
  });

  return {
    targetLayoutPx,
    cssMinWidthPx,
    achievedLayoutWidthPx: snap.centerLayoutWidthPx,
    achievedScaledWidthPx: snap.centerScaledWidthPx,
    viewportWidthPx: page.viewportSize()?.width ?? null,
    fourColumns: snap,
  };
}

/**
 * Select Plan or Goal mode on main via real composer controls (`+` menu -> Mode -> Plan/Goal)
 * and verify `[data-composer-card][data-run-mode="<mode>"]`.
 */
export async function selectRunModeOnMain(page, mode = 'plan') {
  const currentMode = await page.evaluate(
    () => document.querySelector('[data-composer-card]')?.getAttribute('data-run-mode') ?? null,
  );
  if (currentMode === mode) {
    return { ok: true, mode, runModeAttr: currentMode, alreadyActive: true };
  }
  const addTrigger = page.locator('[data-add-menu-trigger]').first();
  if (!(await addTrigger.isVisible().catch(() => false))) {
    return { ok: false, mode, runModeAttr: currentMode, reason: 'add_menu_trigger_not_visible' };
  }
  try {
    await addTrigger.click({ timeout: 5_000 });
    await sleep(180);
    const modeEntry = page.locator('[data-add-menu-mode]').first();
    if (!(await modeEntry.isVisible().catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return { ok: false, mode, runModeAttr: currentMode, reason: 'add_menu_mode_entry_not_visible' };
    }
    await modeEntry.click({ timeout: 5_000 });
    await sleep(180);
    const modeSwitch = page.locator(`[data-mode-switch="${mode}"]`).first();
    if (!(await modeSwitch.isVisible().catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return { ok: false, mode, runModeAttr: currentMode, reason: `mode_switch_${mode}_not_visible` };
    }
    await modeSwitch.click({ timeout: 5_000 });
    await sleep(180);
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(120);
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { ok: false, mode, runModeAttr: currentMode, reason: `select_run_mode_error:${String(err?.message ?? err).slice(0, 160)}` };
  }

  const afterMode = await page.evaluate(
    () => document.querySelector('[data-composer-card]')?.getAttribute('data-run-mode') ?? null,
  );
  return {
    ok: afterMode === mode,
    mode,
    runModeAttr: afterMode,
    reason: afterMode === mode ? null : `expected_run_mode_${mode}_got_${afterMode}`,
  };
}

/**
 * Audit unrounded bounding-rect horizontal overflow on Center Top Bar and
 * Bottom `<Composer />` Bar (never trusting integer `scrollWidth` alone because
 * `overflow: hidden` hides clipped pixels) plus required control visibility,
 * in-bounds placement, and hit-test clickability (`elementFromPoint`).
 */
export async function auditCenterBarsOverflowAndControls(page, { expectedRunMode = 'plan' } = {}) {
  return page.evaluate((runMode) => {
    const EPS = 0.5;
    const round = (v) => Number(v.toFixed(2));
    const packRect = (r) => ({
      left: round(r.left),
      right: round(r.right),
      top: round(r.top),
      bottom: round(r.bottom),
      width: round(r.width),
      height: round(r.height),
    });

    const center = document.querySelector('.conversation-center') ?? document.querySelector('.conversation-shell');
    if (!center) {
      return {
        ok: false,
        reason: 'missing_conversation_shell',
        topBar: null,
        bottomBar: null,
        requiredControls: {},
        offendingItems: [{ bar: 'center', reason: 'missing_conversation_shell' }],
      };
    }

    const centerRect = center.getBoundingClientRect();
    const inspectBar = (barEl, barName, requiredSelectors) => {
      if (!barEl) {
        return {
          ok: false,
          found: false,
          barName,
          overflowPx: null,
          scrollOverflowPx: null,
          rect: null,
          offending: [{ bar: barName, reason: `missing_${barName}` }],
          controls: {},
        };
      }
      const rawBarRect = barEl.getBoundingClientRect();
      const clipLeft = Math.max(rawBarRect.left, centerRect.left);
      const clipRight = Math.min(rawBarRect.right, centerRect.right);
      const barRect = {
        left: clipLeft,
        right: clipRight,
        top: rawBarRect.top,
        bottom: rawBarRect.bottom,
        width: Math.max(0, clipRight - clipLeft),
        height: rawBarRect.height,
      };
      const barShellOverflow = Math.max(0, centerRect.left - rawBarRect.left, rawBarRect.right - centerRect.right);
      const scrollOverflowPx = round(Math.max(0, barEl.scrollWidth - barEl.clientWidth, barShellOverflow));
      const offending = [];
      let maxOverflowPx = scrollOverflowPx;

      // Inspect every visible interactive/text element inside the bar against
      // the bar's own unrounded clipping rect (catches overflow:hidden clipping!).
      const candidates = barEl.querySelectorAll('button, a, input, [role="button"], [data-run-mode-chip], [data-composer-ssh-strip], [data-header-working], [data-preview-toggle], [data-rail-toggle]');
      for (const el of candidates) {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number.parseFloat(st.opacity) === 0) continue;
        // Skip sr-only text spans
        if (el.classList.contains('sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0.5 || r.height <= 0.5) continue;
        const leftClip = barRect.left - r.left;
        const rightClip = r.right - barRect.right;
        const horizOverflow = Math.max(leftClip, rightClip);
        if (horizOverflow > EPS) {
          if (horizOverflow > maxOverflowPx) maxOverflowPx = horizOverflow;
          offending.push({
            bar: barName,
            kind: 'child-horizontal-overflow',
            tag: el.tagName.toLowerCase(),
            label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 60),
            dataAttrs: Object.keys(el.dataset).slice(0, 6),
            overflowPx: round(horizOverflow),
            leftClipPx: round(Math.max(0, leftClip)),
            rightClipPx: round(Math.max(0, rightClip)),
            barRect: packRect(barRect),
            childRect: packRect(r),
          });
        }
      }

      if (scrollOverflowPx > EPS && offending.length === 0) {
        offending.push({
          bar: barName,
          kind: 'bar-scroll-overflow',
          overflowPx: scrollOverflowPx,
          scrollWidth: barEl.scrollWidth,
          clientWidth: barEl.clientWidth,
          barRect: packRect(barRect),
        });
      }

      const controls = {};
      for (const [key, sel] of Object.entries(requiredSelectors)) {
        const el = barEl.querySelector(sel) ?? center.querySelector(sel);
        if (!el) {
          controls[key] = { found: false, visible: false, inBounds: false, clickable: false, reason: 'not_found' };
          offending.push({ bar: barName, kind: 'required-control-missing', control: key, selector: sel });
          continue;
        }
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const visible = st.display !== 'none' && st.visibility !== 'hidden' && r.width > 1 && r.height > 1;
        const leftClip = barRect.left - r.left;
        const rightClip = r.right - barRect.right;
        const inBounds =
          visible &&
          leftClip <= EPS &&
          rightClip <= EPS &&
          r.top >= barRect.top - 2 &&
          r.bottom <= barRect.bottom + 2 &&
          r.right <= window.innerWidth + EPS &&
          r.left >= -EPS;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = visible ? document.elementFromPoint(cx, cy) : null;
        const clickable = Boolean(
          visible &&
            inBounds &&
            hit &&
            (hit === el || el.contains(hit) || hit.contains(el)),
        );
        controls[key] = {
          found: true,
          visible,
          inBounds,
          clickable,
          rect: packRect(r),
          barRect: packRect(barRect),
          overflowPx: round(Math.max(0, leftClip, rightClip)),
        };
        if (!visible || !inBounds || !clickable) {
          offending.push({
            bar: barName,
            kind: !visible ? 'required-control-hidden' : !inBounds ? 'required-control-clipped' : 'required-control-occluded',
            control: key,
            selector: sel,
            overflowPx: round(Math.max(0, leftClip, rightClip)),
            controlRect: packRect(r),
            barRect: packRect(barRect),
          });
        }
      }

      return {
        ok: offending.length === 0 && maxOverflowPx <= EPS,
        found: true,
        barName,
        overflowPx: round(maxOverflowPx),
        scrollOverflowPx,
        rect: packRect(barRect),
        offending,
        controls,
      };
    };

    const topBarEl = center.querySelector('header');
    const composerCard = center.querySelector('[data-composer-card]');
    const composerToolbar = center.querySelector('[data-composer-toolbar]');
    const composerStatusLine = center.querySelector('[data-composer-status-line]');

    const topBar = inspectBar(topBarEl, 'center-top-bar', {
      previewToggle: '[data-preview-toggle]',
      railToggle: '[data-rail-toggle]',
    });

    const bottomRequired = {
      addMenuTrigger: '[data-add-menu-trigger]',
      ...(runMode && runMode !== 'normal' ? { runModeChip: `[data-run-mode-chip="${runMode}"]` } : {}),
    };
    const bottomToolbar = inspectBar(composerToolbar ?? composerCard, 'center-bottom-toolbar', bottomRequired);
    const bottomStatusLine = composerStatusLine
      ? inspectBar(composerStatusLine, 'center-bottom-status-line', {})
      : { ok: true, found: false, barName: 'center-bottom-status-line', overflowPx: 0, offending: [], controls: {} };

    const offendingItems = [
      ...topBar.offending,
      ...bottomToolbar.offending,
      ...bottomStatusLine.offending,
    ];

    return {
      ok: topBar.ok && bottomToolbar.ok && bottomStatusLine.ok,
      topBar,
      bottomBar: {
        ok: bottomToolbar.ok && bottomStatusLine.ok,
        toolbar: bottomToolbar,
        statusLine: bottomStatusLine,
        overflowPx: round(Math.max(bottomToolbar.overflowPx ?? 0, bottomStatusLine.overflowPx ?? 0)),
      },
      requiredControls: {
        ...topBar.controls,
        ...bottomToolbar.controls,
      },
      offendingItems,
      firstOffending: offendingItems[0] ?? null,
    };
  }, expectedRunMode);
}

/**
 * Expand and collapse a genuinely overflowing tall `系统提醒` (`SystemReminderMessage`)
 * while live streaming continues, asserting real overflow (`scrollHeight > clientHeight`)
 * and measurable row height change across expand & collapse.
 */
export async function exerciseTallSystemReminderExpandCollapse(page, { holdExpandedMs = 450 } = {}) {
  const triedBlockIds = new Set();
  const findReminder = (preferTallSeededOnly = true) =>
    page.evaluate(
      ({ preferSeeded, skipIds }) => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (!scroller) return null;
        const rows = [...scroller.querySelectorAll('[data-transcript-virtual-item]')]
          .map((row) => ({ row, index: Number(row.getAttribute('data-index') ?? 0) }))
          .sort((a, b) => b.index - a.index);
        for (const { row, index } of rows) {
          const reminderBlocks = [...row.querySelectorAll('[data-block-id^="reminder-"]')];
          for (const reminderBlock of reminderBlocks) {
            const blockId = reminderBlock.getAttribute('data-block-id') ?? '';
            if (skipIds.includes(blockId)) continue;
            if (preferSeeded && !blockId.startsWith('reminder-msg-reminder-')) continue;
            const toggle =
              reminderBlock.querySelector('[data-activity-toggle]') ??
              reminderBlock.querySelector('button[aria-expanded]');
            if (!toggle) continue;
            const rect = row.getBoundingClientRect();
            return {
              index,
              blockId,
              beforeHeightPx: Number(rect.height.toFixed(2)),
              initiallyExpanded: toggle.getAttribute('aria-expanded') === 'true',
            };
          }
        }
        return null;
      },
      { preferSeeded: preferTallSeededOnly, skipIds: [...triedBlockIds] },
    );

  const openedFoldKeys = new Set();
  const discoveryDeadline = Date.now() + 28_000;

  const findCollapsedHistoryFold = () =>
    page.evaluate((alreadyTried) => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (!scroller) return null;
      const rows = [...scroller.querySelectorAll('[data-transcript-virtual-item]')]
        .map((row) => ({ row, index: Number(row.getAttribute('data-index') ?? 0) }))
        .sort((a, b) => b.index - a.index);
      const scrollerRect = scroller.getBoundingClientRect();
      const composerTop = document.querySelector('[data-composer-card]')?.getBoundingClientRect().top ?? scrollerRect.bottom;
      const safeTop = scrollerRect.top + 4;
      const safeBottom = Math.min(scrollerRect.bottom, composerTop) - 8;
      const candidates = [];
      for (const { row, index } of rows) {
        const fold = row.querySelector('[data-history-fold]:not([data-history-fold-open])');
        if (!fold) continue;
        const toggle = fold.querySelector('[data-activity-toggle], button[aria-expanded]');
        if (!toggle) continue;
        const blockKey = fold.closest('[data-block-id]')?.getAttribute('data-block-id') ?? `idx:${index}`;
        if (alreadyTried.includes(blockKey)) continue;
        const text = (fold.textContent ?? '').trim();
        const hasReminderHint =
          fold.getAttribute('data-history-fold-origin') === 'system' || /提示|reminder/iu.test(text);
        if (!hasReminderHint) continue;
        const tRect = toggle.getBoundingClientRect();
        if (tRect.width < 8 || tRect.height < 8) continue;
        const unobstructed = tRect.top >= safeTop && tRect.bottom <= safeBottom;
        if (!unobstructed) continue;
        candidates.push({
          index,
          blockKey,
          text: text.slice(0, 80),
          cx: tRect.left + Math.min(48, tRect.width * 0.5),
          cy: tRect.top + tRect.height * 0.5,
        });
      }
      return candidates[0] ?? null;
    }, [...openedFoldKeys]);

  const tryOpenFoldsForReminder = async (preferSeeded = true) => {
    let found = await findReminder(preferSeeded);
    if (found) return found;
    for (let attempt = 0; attempt < 3 && !found && Date.now() < discoveryDeadline; attempt += 1) {
      const fold = await findCollapsedHistoryFold();
      if (!fold) break;
      await page.mouse.click(fold.cx, fold.cy);
      openedFoldKeys.add(fold.blockKey);
      await sleep(160);
      found = await findReminder(preferSeeded);
    }
    return found;
  };

  let located = await tryOpenFoldsForReminder(true);
  // If live stream appended new rows below the tail seeded reminder, wheel up gently with trusted wheel events to bring it into view
  if (!located) {
    const scrollerBox = await page.evaluate(() => {
      const el = document.querySelector('[data-transcript-scroll]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
    });
    if (scrollerBox) {
      await page.mouse.move(scrollerBox.x, scrollerBox.y);
      for (let w = 0; w < 60 && !located && Date.now() < discoveryDeadline; w += 1) {
        await page.mouse.wheel(0, -360);
        await sleep(55);
        located = await tryOpenFoldsForReminder(true);
      }
    }
  }
  if (!located) {
    located = await tryOpenFoldsForReminder(false);
  }

  if (!located) {
    return {
      ok: false,
      found: false,
      reason: 'no_system_reminder_row_found_in_visible_transcript',
    };
  }

  const blockSelector = located.blockId
    ? `[data-transcript-scroll] [data-block-id="${located.blockId}"]`
    : `[data-transcript-scroll] [data-transcript-virtual-item][data-index="${located.index}"]`;
  const toggleLocator = page
    .locator(`${blockSelector} [data-activity-toggle], ${blockSelector} button[aria-expanded]`)
    .first();

  await toggleLocator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await toggleLocator.click({ timeout: 5_000 });
  await sleep(holdExpandedMs);

  const expandedState = await page.evaluate((blockSel) => {
    const blockEl = document.querySelector(blockSel);
    const row = blockEl?.closest('[data-transcript-virtual-item]') ?? blockEl;
    if (!row || !blockEl) return null;
    const rect = row.getBoundingClientRect();
    const scrollBodies = [...blockEl.querySelectorAll('div')].filter((d) => {
      const s = getComputedStyle(d);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && d.clientHeight > 60;
    });
    const bestScrollBody = scrollBodies.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] ?? null;
    return {
      heightPx: Number(rect.height.toFixed(2)),
      hasOverflowingScrollBody: bestScrollBody !== null && bestScrollBody.scrollHeight > bestScrollBody.clientHeight + 8,
      bodyScrollHeight: bestScrollBody?.scrollHeight ?? 0,
      bodyClientHeight: bestScrollBody?.clientHeight ?? 0,
    };
  }, blockSelector);

  // Collapse it back cleanly during live stream
  await toggleLocator.click({ timeout: 5_000 });
  await sleep(250);

  const collapsedState = await page.evaluate((blockSel) => {
    const blockEl = document.querySelector(blockSel);
    const row = blockEl?.closest('[data-transcript-virtual-item]') ?? blockEl;
    if (!row) return null;
    return { heightPx: Number(row.getBoundingClientRect().height.toFixed(2)) };
  }, blockSelector);

  const expandDeltaPx = expandedState ? round2(expandedState.heightPx - located.beforeHeightPx) : 0;
  const collapseDeltaPx = expandedState && collapsedState ? round2(expandedState.heightPx - collapsedState.heightPx) : 0;
  const ok = Boolean(
    expandedState &&
      expandedState.hasOverflowingScrollBody &&
      expandDeltaPx > 60 &&
      collapseDeltaPx > 60,
  );

  return {
    ok,
    found: true,
    index: located.index,
    blockId: located.blockId,
    beforeHeightPx: located.beforeHeightPx,
    expandedHeightPx: expandedState?.heightPx ?? null,
    collapsedHeightPx: collapsedState?.heightPx ?? null,
    expandDeltaPx,
    collapseDeltaPx,
    hasOverflowingScrollBody: expandedState?.hasOverflowingScrollBody ?? false,
    bodyScrollHeight: expandedState?.bodyScrollHeight ?? 0,
    bodyClientHeight: expandedState?.bodyClientHeight ?? 0,
    reason: ok
      ? null
      : !expandedState?.hasOverflowingScrollBody
        ? 'expanded_reminder_body_not_overflowing'
        : `insufficient_height_change(expand=${expandDeltaPx}px,collapse=${collapseDeltaPx}px)`,
  };
}

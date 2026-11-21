/**
 * Mobile device profiles and pure visual-geometry / anti-slop invariants.
 *
 * Standards & physical device references (verified against primary specs):
 * - WCAG 2.2 SC 2.5.8 Target Size (Minimum, Level AA): >= 24x24 CSS px (or 24px spacing circle)
 * - WCAG 2.2 SC 2.5.5 / Apple HIG: >= 44x44 CSS px (pt) primary touch target
 * - Material Design 3 Accessibility: >= 48x48 dp touch target, >= 8dp target separation
 * - iOS Simulator safe-area insets (iPhone 16 / 15 Pro):
 *     portrait  393x852 @3x: top 59px (Dynamic Island), bottom 34px (Home Indicator)
 *     landscape 852x393 @3x: left 59px, right 59px, bottom 21px (>767px coarse pointer!)
 * - iPad Air/Pro portrait 820x1180 @2x: top 24px, bottom 20px (>767px coarse pointer!)
 * - Android high-DPI narrow 360x800 @3x: top 28px, bottom 24px
 */

export const TOUCH_STANDARDS = Object.freeze({
  wcagMinimumPx: 24,
  appleHigPrimaryPx: 44,
  material3RecommendedPx: 48,
  minSpacingPx: 8,
  maxOverlapPx2: 4,
});

export const BLANK_VOID_THRESHOLDS = Object.freeze({
  minHeightPx: 200,
  minWidthPx: 140,
});

export const MOBILE_DEVICE_PROFILES = Object.freeze({
  'iphone-16-portrait': Object.freeze({
    id: 'iphone-16-portrait',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    safeArea: Object.freeze({ top: 59, right: 0, bottom: 34, left: 0 }),
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KikiApp/ios',
    standard: 'iPhone 16 / 15 Pro portrait (393x852 @3x, top=59px Dynamic Island, bottom=34px Home Indicator)',
  }),
  'iphone-16-landscape': Object.freeze({
    id: 'iphone-16-landscape',
    width: 852,
    height: 393,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    safeArea: Object.freeze({ top: 0, right: 59, bottom: 21, left: 59 }),
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KikiApp/ios',
    standard: 'iPhone 16 landscape (852x393 @3x, >767px coarse pointer, left/right=59px, bottom=21px)',
  }),
  'android-narrow': Object.freeze({
    id: 'android-narrow',
    width: 360,
    height: 800,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    safeArea: Object.freeze({ top: 28, right: 0, bottom: 24, left: 0 }),
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36 KikiApp/android',
    standard: 'Android high-DPI narrow (360x800 @3x, top=28px status bar, bottom=24px gesture bar)',
  }),
  'ipad-portrait': Object.freeze({
    id: 'ipad-portrait',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    safeArea: Object.freeze({ top: 24, right: 0, bottom: 20, left: 0 }),
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KikiApp/ios',
    standard: 'iPad portrait (820x1180 @2x, >767px coarse pointer, top=24px, bottom=20px)',
  }),
});

function rectOverlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

function centerDistance(a, b) {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const bx = (b.left + b.right) / 2;
  const by = (b.top + b.bottom) / 2;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Evaluates interactive touch targets against WCAG 2.2 SC 2.5.8 (24x24 hard floor),
 * Apple HIG primary hit target (44x44 advisory/finding for primary chrome actions),
 * pairwise box overlap, and overflow clipping.
 */
export function evaluateTouchTargets(controls, {
  coarsePointer = true,
  requireCoarsePointer = true,
  wcagMinimumPx = TOUCH_STANDARDS.wcagMinimumPx,
  appleHigPrimaryPx = TOUCH_STANDARDS.appleHigPrimaryPx,
  maxOverlapPx2 = TOUCH_STANDARDS.maxOverlapPx2,
} = {}) {
  const findings = [];
  if (!coarsePointer) {
    if (requireCoarsePointer) {
      findings.push({
        ruleId: 'COARSE_POINTER_NOT_ACTIVE',
        severity: 'error',
        standard: 'Mobile touch checks require active coarse pointer emulation (matchMedia("(pointer: coarse)") === true)',
        actual: { coarsePointer: Boolean(coarsePointer) },
        expected: { coarsePointer: true },
      });
    }
    return findings;
  }

  const visible = controls.filter((c) => c && c.rect && c.rect.width > 0 && c.rect.height > 0);
  for (const ctrl of visible) {
    const { width, height } = ctrl.rect;
    if (width < wcagMinimumPx - 0.5 || height < wcagMinimumPx - 0.5) {
      findings.push({
        ruleId: 'TOUCH_TARGET_BELOW_WCAG_24',
        severity: 'error',
        standard: 'WCAG 2.2 SC 2.5.8 Target Size (Minimum >= 24x24 CSS px)',
        selector: ctrl.selector,
        label: ctrl.label,
        actual: { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 },
        expected: { minWidth: wcagMinimumPx, minHeight: wcagMinimumPx },
      });
    } else if (ctrl.primary && (width < appleHigPrimaryPx - 0.5 || height < appleHigPrimaryPx - 0.5)) {
      findings.push({
        ruleId: 'PRIMARY_TOUCH_TARGET_BELOW_HIG_44',
        severity: 'error',
        standard: 'Apple HIG / WCAG 2.2 SC 2.5.5 (>= 44x44 CSS px for primary controls)',
        selector: ctrl.selector,
        label: ctrl.label,
        actual: { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 },
        expected: { minWidth: appleHigPrimaryPx, minHeight: appleHigPrimaryPx },
      });
    }

    if (ctrl.clippedByOverflow) {
      findings.push({
        ruleId: 'CONTROL_CLIPPED_BY_OVERFLOW',
        severity: 'error',
        standard: 'Zero clipped text/badges inside overflow:hidden containers',
        selector: ctrl.selector,
        label: ctrl.label,
        actual: ctrl.clipDetail ?? { clipped: true },
        expected: { clipped: false },
      });
    }
  }

  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i];
      const b = visible[j];
      if (a.group !== b.group) continue;
      if (a.containsOther || b.containsOther) continue;
      const area = rectOverlapArea(a.rect, b.rect);
      if (area > maxOverlapPx2) {
        findings.push({
          ruleId: 'TOUCH_TARGETS_OVERLAPPING',
          severity: 'error',
          standard: 'Zero overlapping interactive hit boxes on touch surfaces',
          selector: `${a.selector} <-> ${b.selector}`,
          label: `${a.label} overlaps ${b.label}`,
          actual: { overlapPx2: Math.round(area), a: a.rect, b: b.rect },
          expected: { overlapPx2: 0 },
        });
      } else if (
        (a.rect.width < wcagMinimumPx || a.rect.height < wcagMinimumPx || b.rect.width < wcagMinimumPx || b.rect.height < wcagMinimumPx)
        && centerDistance(a.rect, b.rect) < wcagMinimumPx
      ) {
        findings.push({
          ruleId: 'TOUCH_TARGETS_INSUFFICIENT_SPACING',
          severity: 'error',
          standard: 'WCAG 2.2 SC 2.5.8 24px spacing circle',
          selector: `${a.selector} <-> ${b.selector}`,
          label: `${a.label} too close to ${b.label}`,
          actual: { centerDistancePx: Math.round(centerDistance(a.rect, b.rect) * 10) / 10 },
          expected: { minCenterDistancePx: wcagMinimumPx },
        });
      }
    }
  }

  return findings;
}

/**
 * Evaluates safe-area inset compliance across portrait phones, >767px landscape
 * phones, and tablets.
 */
export function evaluateSafeAreaGeometry({
  viewport,
  safeArea,
  headerRect,
  composerRect,
  tabbarRect,
  stagePadding,
  horizontalOverflowPx = 0,
  requireHeader = false,
  requireComposer = false,
  requireBottomSurface = false,
}) {
  const findings = [];
  if (requireHeader && !headerRect) {
    findings.push({
      ruleId: 'REQUIRED_HEADER_MISSING',
      severity: 'error',
      standard: 'Session/mobile route must render a visible top header for safe-area verification',
      actual: { headerRect: null },
      expected: { headerPresent: true },
    });
  }
  if (requireComposer && !composerRect) {
    findings.push({
      ruleId: 'REQUIRED_COMPOSER_MISSING',
      severity: 'error',
      standard: 'Chat/session route must render a visible composer card for bottom safe-area verification',
      actual: { composerRect: null },
      expected: { composerPresent: true },
    });
  }
  if (requireBottomSurface && !composerRect && !tabbarRect) {
    findings.push({
      ruleId: 'REQUIRED_BOTTOM_SURFACE_MISSING',
      severity: 'error',
      standard: 'Mobile route must render a visible composer or bottom tabbar for Home Indicator clearance verification',
      actual: { composerRect: null, tabbarRect: null },
      expected: { bottomSurfacePresent: true },
    });
  }
  if (horizontalOverflowPx > 1) {
    findings.push({
      ruleId: 'HORIZONTAL_OVERFLOW',
      severity: 'error',
      standard: 'Zero horizontal page overflow across mobile & tablet viewports',
      actual: { horizontalOverflowPx },
      expected: { horizontalOverflowPx: 0 },
    });
  }

  if (safeArea.top > 0 && headerRect) {
    // Full-bleed sticky headers (like mobile launcher `.topbar`) intentionally sit at top=0
    // to paint background color behind the status bar while padding their content below safeArea.top.
    const effectiveTop = headerRect.top + (headerRect.paddingTop ?? 0);
    if (effectiveTop < safeArea.top - 1) {
      findings.push({
        ruleId: 'SAFE_AREA_TOP_VIOLATION',
        severity: 'error',
        standard: `iOS/Android top cutout clearance (header content top >= safeArea.top=${safeArea.top}px)`,
        actual: {
          headerTop: Math.round(headerRect.top),
          headerPaddingTop: Math.round(headerRect.paddingTop ?? 0),
          effectiveTop: Math.round(effectiveTop),
          stagePaddingTop: stagePadding?.top ?? null,
        },
        expected: { minHeaderContentTop: safeArea.top },
      });
    }
  }

  if (safeArea.left > 0 && headerRect) {
    // Check either stage/sidebar left edge clearance or header content left clearance
    const effectiveLeft = headerRect.left + (headerRect.paddingLeft ?? 0);
    const leftEdgeClipped = (stagePadding !== null && stagePadding !== undefined && stagePadding.left < safeArea.left - 1)
      || effectiveLeft < safeArea.left - 1;
    if (leftEdgeClipped) {
      findings.push({
        ruleId: 'SAFE_AREA_LEFT_LANDSCAPE_VIOLATION',
        severity: 'error',
        standard: `Landscape cutout clearance on >767px coarse pointer (left safe inset >= ${safeArea.left}px)`,
        actual: {
          headerLeft: Math.round(headerRect.left),
          effectiveLeft: Math.round(effectiveLeft),
          viewportWidth: viewport.width,
          stagePaddingLeft: stagePadding?.left ?? null,
        },
        expected: { minSafeLeft: safeArea.left },
      });
    }
  }

  if (safeArea.right > 0 && headerRect) {
    const rightContentClearance = viewport.width - (headerRect.right - (headerRect.paddingRight ?? 0));
    if (rightContentClearance < safeArea.right - 1) {
      findings.push({
        ruleId: 'SAFE_AREA_RIGHT_LANDSCAPE_VIOLATION',
        severity: 'error',
        standard: `Landscape right-edge safe-area clearance (rightContentClearance >= safeArea.right=${safeArea.right}px)`,
        actual: {
          rightContentClearance: Math.round(rightContentClearance),
          viewportWidth: viewport.width,
          stagePaddingRight: stagePadding?.right ?? null,
        },
        expected: { minRightClearance: safeArea.right },
      });
    }
  }

  if (safeArea.bottom > 0) {
    if (composerRect) {
      const bottomClearance = viewport.height - composerRect.bottom;
      if (bottomClearance < safeArea.bottom - 2) {
        findings.push({
          ruleId: 'SAFE_AREA_BOTTOM_COMPOSER_VIOLATION',
          severity: 'error',
          standard: `Home Indicator clearance below composer (bottomClearance >= safeArea.bottom=${safeArea.bottom}px)`,
          actual: {
            composerBottom: Math.round(composerRect.bottom),
            viewportHeight: viewport.height,
            bottomClearance: Math.round(bottomClearance),
          },
          expected: { minBottomClearance: safeArea.bottom },
        });
      }
    } else if (tabbarRect) {
      const padBottom = tabbarRect.paddingBottom ?? 0;
      if (padBottom < safeArea.bottom - 1) {
        findings.push({
          ruleId: 'SAFE_AREA_BOTTOM_TABBAR_VIOLATION',
          severity: 'error',
          standard: `Home Indicator padding on fixed bottom tabbar (paddingBottom >= ${safeArea.bottom}px)`,
          actual: { paddingBottom: Math.round(padBottom) },
          expected: { minPaddingBottom: safeArea.bottom },
        });
      }
    }
  }

  return findings;
}

/**
 * Evaluates soft-keyboard open geometry under shrunk `visualViewport.height`
 * and iOS WebKit `visualViewport.offsetTop > 0` scroll shift.
 */
export function evaluateSoftKeyboardGeometry({
  headerRect,
  composerRect,
  visualViewport,
  safeArea = { top: 0, bottom: 0, left: 0, right: 0 },
  rootVisualHeightVar = '',
  rootOffsetTopVar = '',
  requireHeader = true,
  requireComposer = true,
}) {
  const findings = [];
  const vvTop = visualViewport.offsetTop ?? 0;
  const vvBottom = vvTop + visualViewport.height;

  if (requireHeader && !headerRect) {
    findings.push({
      ruleId: 'REQUIRED_HEADER_MISSING',
      severity: 'error',
      standard: 'Soft-keyboard geometry check requires a visible header element',
      actual: { headerRect: null },
      expected: { headerPresent: true },
    });
  }
  if (requireComposer && !composerRect) {
    findings.push({
      ruleId: 'REQUIRED_COMPOSER_MISSING',
      severity: 'error',
      standard: 'Soft-keyboard geometry check requires a visible composer element',
      actual: { composerRect: null },
      expected: { composerPresent: true },
    });
  }

  if (headerRect) {
    if (headerRect.top < vvTop - 1) {
      findings.push({
        ruleId: 'IOS_KEYBOARD_HEADER_PUSHED_OFFSCREEN',
        severity: 'error',
        standard: 'iOS WebKit visualViewport.offsetTop > 0 must not push h-12 header above visible viewport',
        actual: {
          headerTop: Math.round(headerRect.top),
          visualViewportOffsetTop: vvTop,
          visualViewportHeight: visualViewport.height,
          rootVisualHeightVar,
          rootOffsetTopVar,
        },
        expected: { minHeaderTop: vvTop },
      });
    } else if (vvTop === 0 && safeArea.top > 0 && headerRect.top < safeArea.top - 1) {
      findings.push({
        ruleId: 'KEYBOARD_HEADER_SAFE_AREA_COLLAPSE',
        severity: 'error',
        standard: 'Header keeps top safe-area clearance while soft keyboard is open',
        actual: { headerTop: Math.round(headerRect.top) },
        expected: { minHeaderTop: safeArea.top },
      });
    }
  }

  if (composerRect) {
    if (composerRect.bottom > vvBottom + 2) {
      findings.push({
        ruleId: 'SOFT_KEYBOARD_OCCLUDES_COMPOSER',
        severity: 'error',
        standard: 'Composer card must stay fully above the soft keyboard (composer.bottom <= visualViewport bottom)',
        actual: {
          composerBottom: Math.round(composerRect.bottom),
          visualViewportBottom: Math.round(vvBottom),
          occludedPx: Math.round(composerRect.bottom - vvBottom),
          rootVisualHeightVar,
        },
        expected: { maxComposerBottom: Math.round(vvBottom) },
      });
    }
  }

  return findings;
}

/**
 * Detects forced large blank voids (e.g. `min-h-[280px]`) inside sidebars,
 * drawers, rails, and panels outside the main transcript scroller.
 */
export function evaluateUnintendedBlankVoids(blocks, {
  minHeightPx = BLANK_VOID_THRESHOLDS.minHeightPx,
  minWidthPx = BLANK_VOID_THRESHOLDS.minWidthPx,
} = {}) {
  const findings = [];
  for (const blk of blocks) {
    if (!blk || !blk.rect) continue;
    if (blk.rect.height > minHeightPx && blk.rect.width >= minWidthPx && blk.visibleTextLength === 0 && blk.visibleMediaCount === 0 && blk.visibleInteractiveCount === 0) {
      findings.push({
        ruleId: 'UNINTENDED_BLANK_VOID',
        severity: 'error',
        standard: `No forced empty container > ${minHeightPx}px tall without visible text/media/controls outside main transcript`,
        selector: blk.selector,
        actual: {
          height: Math.round(blk.rect.height),
          width: Math.round(blk.rect.width),
          minHeightCss: blk.minHeightCss ?? null,
        },
        expected: { maxEmptyHeightPx: minHeightPx },
      });
    }
  }
  return findings;
}

/**
 * Evaluates contradictory UI states and duplicate icons caught by historical escapes.
 */
export function evaluateContradictoryUiState({
  connectionSource = null,
  hasLocalDaemon = true,
  spaceSwitcherOpen = false,
  hasBackToLocal = false,
  spaceItemCount = 0,
  expectedMinSpaces = 0,
  toasts = [],
  atT0Top = false,
  hasRedLoadError = false,
}) {
  const findings = [];

  if (connectionSource === 'app-shell' && !hasLocalDaemon && spaceSwitcherOpen) {
    if (hasBackToLocal) {
      findings.push({
        ruleId: 'APP_SHELL_DEAD_BACK_TO_LOCAL',
        severity: 'error',
        standard: 'app-shell without local daemon must never render dead "<- Back to local space" button',
        actual: { connectionSource, hasLocalDaemon, hasBackToLocal },
        expected: { hasBackToLocal: false },
      });
    }
    if (expectedMinSpaces > 0 && spaceItemCount < expectedMinSpaces) {
      findings.push({
        ruleId: 'APP_SHELL_EMPTY_SPACE_SWITCHER',
        severity: 'error',
        standard: 'app-shell connected to multi-space host must list available spaces instead of empty menu',
        actual: { connectionSource, spaceItemCount, expectedMinSpaces },
        expected: { minSpaceItemCount: expectedMinSpaces },
      });
    }
  }

  for (const toast of toasts) {
    if ((toast.closeGlyphCount ?? 0) >= 2) {
      findings.push({
        ruleId: 'TOAST_DUPLICATE_CLOSE_GLYPH',
        severity: 'error',
        standard: 'Error/info toast must never render duplicate left+right close (X) glyphs',
        actual: { tone: toast.tone, closeGlyphCount: toast.closeGlyphCount, text: toast.text },
        expected: { maxCloseGlyphCount: 1 },
      });
    }
  }

  if (atT0Top && hasRedLoadError) {
    findings.push({
      ruleId: 'T0_FALSE_LOAD_ERROR',
      severity: 'error',
      standard: 'Reaching t0 top must never raise an older-history load failure banner or error toast',
      actual: { atT0Top, hasRedLoadError },
      expected: { hasRedLoadError: false },
    });
  }

  return findings;
}

/**
 * Browser-side DOM snapshot function executed inside `page.evaluate(...)`.
 * Returns raw structured measurements for the pure evaluators above.
 */
export function collectMobileDomSnapshot() {
  const toRect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return null;
    const cs = getComputedStyle(el);
    return {
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
      width: r.width,
      height: r.height,
      paddingTop: Number.parseFloat(cs.paddingTop) || 0,
      paddingRight: Number.parseFloat(cs.paddingRight) || 0,
      paddingBottom: Number.parseFloat(cs.paddingBottom) || 0,
      paddingLeft: Number.parseFloat(cs.paddingLeft) || 0,
    };
  };

  const describeEl = (el) => {
    const tag = el.tagName.toLowerCase();
    const attrs = ['data-sidebar-menu', 'data-rail-toggle', 'data-send-ready', 'data-space-switcher', 'data-space-back-local', 'data-toast', 'data-tab', 'id'];
    for (const attr of attrs) {
      const v = el.getAttribute(attr);
      if (v !== null) return v === '' ? `${tag}[${attr}]` : `${tag}[${attr}="${v}"]`;
    }
    const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
  };

  const isVisible = (el) => {
    if (!el || !(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity) <= 0.02) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5 && r.bottom > 0 && r.top < window.innerHeight + 600 && r.right > 0 && r.left < window.innerWidth + 100;
  };

  const headerEl =
    document.querySelector('[data-main-header]')
    ?? document.querySelector('.workspace-header')
    ?? document.querySelector('.conversation-header-slot > header')
    ?? document.querySelector('header.topbar');

  const composerEl = document.querySelector('[data-composer-card]');
  const tabbarEl = document.querySelector('nav.tabbar');
  const stageEl = document.querySelector('.app-stage') ?? document.querySelector('.shell');

  const stageCs = stageEl ? getComputedStyle(stageEl) : null;
  const stagePadding = stageCs
    ? {
        top: Number.parseFloat(stageCs.paddingTop) || 0,
        right: Number.parseFloat(stageCs.paddingRight) || 0,
        bottom: Number.parseFloat(stageCs.paddingBottom) || 0,
        left: Number.parseFloat(stageCs.paddingLeft) || 0,
      }
    : null;

  const primarySelectors = [
    '[data-sidebar-menu]',
    '[data-rail-toggle]',
    'button[data-send-ready]',
    'button[data-stop-turn]',
    '[data-needs-you-tray] button',
    '[data-space-switcher]',
    '[data-space-switcher-menu] button[role="menuitem"]',
    'nav.tabbar button.tab',
    '#scan-qr',
    '#paste-link',
    '#manual-toggle',
    '#open',
    '#test-server',
  ];

  const seenControls = new Set();
  const controls = [];
  const registerControl = (el, primary, group) => {
    if (!isVisible(el) || seenControls.has(el)) return;
    seenControls.add(el);
    const rect = toRect(el);
    if (!rect) return;
    const cs = getComputedStyle(el);
    let clippedByOverflow = false;
    let clipDetail = null;
    if (
      (cs.overflowX === 'hidden' || cs.overflowX === 'clip')
      && cs.textOverflow !== 'ellipsis'
      && el.scrollWidth > el.clientWidth + 3
    ) {
      clippedByOverflow = true;
      clipDetail = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60) || describeEl(el);
    controls.push({
      selector: describeEl(el),
      label,
      primary,
      group,
      rect,
      clippedByOverflow,
      clipDetail,
      containsOther: false,
    });
  };

  for (const sel of primarySelectors) {
    for (const el of document.querySelectorAll(sel)) {
      const grp = el.closest('header')
        ? 'header'
        : el.closest('[data-composer-card]')
          ? 'composer'
          : el.closest('[data-space-switcher-menu]')
            ? 'space-menu'
            : el.closest('nav.tabbar')
              ? 'tabbar'
              : 'main';
      registerControl(el, true, grp);
    }
  }
  for (const containerSel of ['header', '[data-composer-toolbar]', '[data-space-switcher-menu]', 'nav.tabbar']) {
    for (const container of document.querySelectorAll(containerSel)) {
      if (!isVisible(container)) continue;
      for (const btn of container.querySelectorAll('button:not([disabled]), a[href]')) {
        registerControl(btn, false, containerSel);
      }
    }
  }

  // Blank void scan inside sidebars, rails, drawers, and panels (outside main transcript scroller).
  const voidRoots = [
    ...document.querySelectorAll('aside.app-sidebar.open, aside.app-rail.open, [data-session-rail], [data-space-switcher-menu], main.views'),
  ].filter(isVisible);

  const blankVoidBlocks = [];
  for (const root of voidRoots) {
    for (const node of root.querySelectorAll('div, section, ul')) {
      if (node.closest('[data-transcript-scroll]')) continue;
      if (!isVisible(node)) continue;
      const clsStr = String(node.className || '');
      if (/(?:scrim|backdrop|overlay-bg)/i.test(clsStr)) continue;
      const cs = getComputedStyle(node);
      if (cs.position === 'fixed' && Number.parseFloat(cs.width) >= window.innerWidth - 2 && Number.parseFloat(cs.height) >= window.innerHeight - 2) continue;
      const r = node.getBoundingClientRect();
      if (r.height <= 190 || r.width < 120) continue;
      // Only inspect leaf-ish visual blocks or containers whose visible children take < 15% of height
      const text = (node.innerText || '').trim();
      const visibleMediaCount = [...node.querySelectorAll('img, svg, video, canvas')].filter(isVisible).length;
      const visibleInteractiveCount = [...node.querySelectorAll('button, input, textarea, select, a[href]')].filter(isVisible).length;
      if (text.length === 0 && visibleMediaCount === 0 && visibleInteractiveCount === 0) {
        blankVoidBlocks.push({
          selector: describeEl(node),
          rect: toRect(node),
          visibleTextLength: 0,
          visibleMediaCount: 0,
          visibleInteractiveCount: 0,
          minHeightCss: cs.minHeight,
        });
      }
    }
  }

  // Toast glyph inspection
  const toasts = [...document.querySelectorAll('[data-toast]')].map((el) => {
    const closeIcons = el.querySelectorAll('[data-icon="close"], [data-icon="x"], svg.lucide-x').length;
    return {
      tone: el.getAttribute('data-toast'),
      closeGlyphCount: closeIcons,
      text: (el.textContent || '').trim().slice(0, 120),
    };
  });

  const rootStyle = getComputedStyle(document.documentElement);
  const vv = window.visualViewport
    ? {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        offsetTop: window.visualViewport.offsetTop,
        offsetLeft: window.visualViewport.offsetLeft,
        scale: window.visualViewport.scale,
      }
    : { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 };

  const spaceMenu = document.querySelector('[data-space-switcher-menu]');
  const spaceItems = spaceMenu
    ? spaceMenu.querySelectorAll('[data-space-switch-item], [data-space-remote-item]').length
    : 0;
  const hasBackToLocal = spaceMenu ? spaceMenu.querySelector('[data-space-back-local]') !== null : false;

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visualViewport: vv,
    media: {
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
    },
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    headerRect: toRect(headerEl),
    composerRect: toRect(composerEl),
    tabbarRect: toRect(tabbarEl),
    stagePadding,
    controls,
    blankVoidBlocks,
    toasts,
    spaceSwitcherOpen: spaceMenu !== null && isVisible(spaceMenu),
    spaceItemCount: spaceItems,
    hasBackToLocal,
    rootCssVars: {
      visualHeight: document.documentElement.style.getPropertyValue('--kiki-visual-height') || rootStyle.getPropertyValue('--kiki-visual-height').trim(),
      imeOffset: document.documentElement.style.getPropertyValue('--kiki-ime-offset') || rootStyle.getPropertyValue('--kiki-ime-offset').trim(),
      offsetTop: document.documentElement.style.getPropertyValue('--kiki-visual-offset-top') || rootStyle.getPropertyValue('--kiki-visual-offset-top').trim(),
      safeTop: rootStyle.getPropertyValue('--kiki-safe-top-inset').trim(),
      safeBottom: rootStyle.getPropertyValue('--kiki-safe-bottom-inset').trim(),
    },
  };
}

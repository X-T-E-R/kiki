import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateContradictoryUiState,
  evaluateSafeAreaGeometry,
  evaluateSoftKeyboardGeometry,
  evaluateTouchTargets,
  evaluateUnintendedBlankVoids,
  MOBILE_DEVICE_PROFILES,
} from './lib/mobile-geometry-probes.mjs';
import { parseMobileRigorArgs } from './visual-proof-mobile-rigor.mjs';

test('MOBILE_DEVICE_PROFILES covers >767px landscape and iPad coarse-pointer viewports', () => {
  assert.equal(MOBILE_DEVICE_PROFILES['iphone-16-portrait'].safeArea.top, 59);
  assert.equal(MOBILE_DEVICE_PROFILES['iphone-16-portrait'].safeArea.bottom, 34);
  assert.ok(MOBILE_DEVICE_PROFILES['iphone-16-landscape'].width > 767);
  assert.equal(MOBILE_DEVICE_PROFILES['iphone-16-landscape'].safeArea.left, 59);
  assert.equal(MOBILE_DEVICE_PROFILES['iphone-16-landscape'].safeArea.bottom, 21);
  assert.ok(MOBILE_DEVICE_PROFILES['ipad-portrait'].width > 767);
  assert.equal(MOBILE_DEVICE_PROFILES['android-narrow'].width, 360);
});

test('evaluateSafeAreaGeometry catches >767px landscape safe-area leakage and horizontal overflow', () => {
  const findings = evaluateSafeAreaGeometry({
    viewport: { width: 852, height: 393 },
    safeArea: { top: 0, right: 59, bottom: 21, left: 59 },
    headerRect: { top: 8, left: 0, right: 844, bottom: 56, width: 844, height: 48 },
    composerRect: { top: 310, left: 0, right: 844, bottom: 385, width: 844, height: 75 },
    horizontalOverflowPx: 12,
  });
  const ids = new Set(findings.map((f) => f.ruleId));
  assert.ok(ids.has('HORIZONTAL_OVERFLOW'));
  assert.ok(ids.has('SAFE_AREA_LEFT_LANDSCAPE_VIOLATION'));
  assert.ok(ids.has('SAFE_AREA_RIGHT_LANDSCAPE_VIOLATION'));
  assert.ok(ids.has('SAFE_AREA_BOTTOM_COMPOSER_VIOLATION'));
});

test('evaluateSoftKeyboardGeometry catches iOS visualViewport.offsetTop header push-out and composer occlusion', () => {
  const findings = evaluateSoftKeyboardGeometry({
    headerRect: { top: 59, bottom: 107, left: 0, right: 393 },
    composerRect: { top: 610, bottom: 690, left: 0, right: 393 },
    visualViewport: { width: 393, height: 480, offsetTop: 180 },
    safeArea: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  const ids = new Set(findings.map((f) => f.ruleId));
  assert.ok(ids.has('IOS_KEYBOARD_HEADER_PUSHED_OFFSCREEN'));
  assert.ok(ids.has('SOFT_KEYBOARD_OCCLUDES_COMPOSER'));
});

test('evaluateTouchTargets enforces WCAG 2.2 SC 2.5.8 24px floor, Apple HIG 44px primary, overlap, and overflow clip', () => {
  const findings = evaluateTouchTargets([
    { selector: 'btn-tiny', label: 'Close', primary: false, group: 'hdr', rect: { left: 10, top: 10, right: 28, bottom: 28, width: 18, height: 18 }, clippedByOverflow: false },
    { selector: 'btn-send', label: 'Send', primary: true, group: 'bar', rect: { left: 100, top: 10, right: 136, bottom: 46, width: 36, height: 36 }, clippedByOverflow: true },
    { selector: 'btn-stop', label: 'Stop', primary: true, group: 'bar', rect: { left: 120, top: 10, right: 164, bottom: 54, width: 44, height: 44 }, clippedByOverflow: false },
  ], { coarsePointer: true });
  const ids = new Set(findings.map((f) => f.ruleId));
  assert.ok(ids.has('TOUCH_TARGET_BELOW_WCAG_24'));
  assert.ok(ids.has('PRIMARY_TOUCH_TARGET_BELOW_HIG_44'));
  assert.ok(ids.has('CONTROL_CLIPPED_BY_OVERFLOW'));
  assert.ok(ids.has('TOUCH_TARGETS_OVERLAPPING'));
});

test('evaluateUnintendedBlankVoids catches forced min-h-[280px] blank voids', () => {
  const findings = evaluateUnintendedBlankVoids([
    { selector: 'div.rail-section', rect: { width: 280, height: 280 }, visibleTextLength: 0, visibleMediaCount: 0, visibleInteractiveCount: 0, minHeightCss: '280px' },
    { selector: 'div.small-gap', rect: { width: 280, height: 48 }, visibleTextLength: 0, visibleMediaCount: 0, visibleInteractiveCount: 0 },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'UNINTENDED_BLANK_VOID');
});

test('evaluateContradictoryUiState catches app-shell empty spaces, dead back-to-local, double-X toast, and t0 false error', () => {
  const findings = evaluateContradictoryUiState({
    connectionSource: 'app-shell',
    hasLocalDaemon: false,
    spaceSwitcherOpen: true,
    hasBackToLocal: true,
    spaceItemCount: 0,
    expectedMinSpaces: 1,
    toasts: [{ tone: 'error', closeGlyphCount: 2, text: 'Could not load earlier messages' }],
    atT0Top: true,
    hasRedLoadError: true,
  });
  const ids = new Set(findings.map((f) => f.ruleId));
  assert.ok(ids.has('APP_SHELL_DEAD_BACK_TO_LOCAL'));
  assert.ok(ids.has('APP_SHELL_EMPTY_SPACE_SWITCHER'));
  assert.ok(ids.has('TOAST_DUPLICATE_CLOSE_GLYPH'));
  assert.ok(ids.has('T0_FALSE_LOAD_ERROR'));
});

test('parseMobileRigorArgs switches cleanly between strict and --report-findings modes', () => {
  const def = parseMobileRigorArgs([]);
  assert.equal(def.strict, true);
  assert.equal(def.reportFindings, false);
  const audit = parseMobileRigorArgs(['--report-findings', '--no-build', '--only=iphone-landscape-safe-area']);
  assert.equal(audit.strict, false);
  assert.equal(audit.reportFindings, true);
  assert.equal(audit.noBuild, true);
  assert.deepEqual(audit.only, ['iphone-landscape-safe-area']);
});

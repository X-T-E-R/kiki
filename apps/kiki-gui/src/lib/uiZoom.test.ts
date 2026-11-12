// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSettings, writeSettings } from '@kiki/session-core/settings';

import {
  applyCssRootZoom,
  applyUiZoomAction,
  clearCssRootZoom,
  cssZoomFactor,
  desktopZoomShortcut,
  startZoomSync,
  unzoomedPoint,
  unzoomedRect,
  unzoomedViewport,
} from './uiZoom';

describe('uiZoom synchronization and viewport geometry', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.zoom = '';
    delete document.documentElement.dataset['kikiZoom'];
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.style.zoom = '';
    delete document.documentElement.dataset['kikiZoom'];
  });

  it('applies root CSS zoom in browser mode and clears it back at 100%', () => {
    const stop = startZoomSync({});
    try {
      expect(document.documentElement.dataset['kikiZoom']).toBe('100');
      expect(document.documentElement.style.zoom).toBe('');
      expect(cssZoomFactor()).toBe(1);

      writeSettings({ uiZoom: 125 });
      expect(document.documentElement.dataset['kikiZoom']).toBe('125');
      expect(document.documentElement.style.zoom).toBe('1.25');
      expect(cssZoomFactor()).toBe(1.25);

      writeSettings({ uiZoom: 100 });
      expect(document.documentElement.dataset['kikiZoom']).toBe('100');
      expect(document.documentElement.style.zoom).toBe('');
      expect(cssZoomFactor()).toBe(1);
    } finally {
      stop();
    }
  });

  it('uses native WebView setZoom in Tauri without double-applying CSS zoom', async () => {
    const setZoom = vi.fn().mockResolvedValue(true);
    applyCssRootZoom(125);
    expect(document.documentElement.style.zoom).toBe('1.25');

    writeSettings({ uiZoom: 140 });
    const stop = startZoomSync({ setZoom });
    try {
      expect(setZoom).toHaveBeenCalledWith(1.4);
      await vi.waitFor(() => {
        expect(document.documentElement.style.zoom).toBe('');
      });
      expect(document.documentElement.dataset['kikiZoom']).toBe('140');
      expect(cssZoomFactor()).toBe(1);
    } finally {
      stop();
    }
  });

  it('falls back to CSS root zoom when native setZoom fails', async () => {
    const setZoom = vi.fn().mockResolvedValue(false);
    writeSettings({ uiZoom: 125 });
    const stop = startZoomSync({ setZoom });
    try {
      expect(setZoom).toHaveBeenCalledWith(1.25);
      await vi.waitFor(() => {
        expect(document.documentElement.style.zoom).toBe('1.25');
      });
      expect(document.documentElement.dataset['kikiZoom']).toBe('125');
    } finally {
      stop();
    }
  });

  it('converts viewport, rect, and pointer coordinates accurately under CSS zoom', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });

    clearCssRootZoom(100);
    expect(unzoomedViewport()).toEqual({ width: 1500, height: 1000 });
    expect(unzoomedPoint(300, 150)).toEqual({ x: 300, y: 150 });

    applyCssRootZoom(125);
    expect(unzoomedViewport()).toEqual({ width: 1200, height: 800 });
    expect(unzoomedPoint(300, 150)).toEqual({ x: 240, y: 120 });
    expect(
      unzoomedRect({ top: 125, bottom: 250, left: 250, right: 500, width: 250, height: 125 }),
    ).toEqual({
      top: 100,
      bottom: 200,
      left: 200,
      right: 400,
      width: 200,
      height: 100,
      x: 200,
      y: 100,
    });
  });

  it('matches desktop zoom shortcuts and steps uiZoom cleanly', () => {
    expect(desktopZoomShortcut({ key: '=', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false })).toBe('in');
    expect(desktopZoomShortcut({ key: '+', code: 'Equal', ctrlKey: false, metaKey: true, altKey: false })).toBe('in');
    expect(desktopZoomShortcut({ key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false })).toBe('out');
    expect(desktopZoomShortcut({ key: '_', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false })).toBe('out');
    expect(desktopZoomShortcut({ key: '0', code: 'Digit0', ctrlKey: true, metaKey: false, altKey: false })).toBe('reset');
    expect(desktopZoomShortcut({ key: '=', ctrlKey: true, metaKey: false, altKey: true })).toBeNull();
    expect(desktopZoomShortcut({ key: '=', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();

    expect(readSettings().uiZoom).toBe(100);
    expect(applyUiZoomAction('in')).toBe(110);
    expect(applyUiZoomAction('in')).toBe(125);
    expect(readSettings().uiZoom).toBe(125);
    expect(applyUiZoomAction('out')).toBe(110);
    expect(applyUiZoomAction('reset')).toBe(100);
    expect(readSettings().uiZoom).toBe(100);
  });
});

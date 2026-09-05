import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DANCE_FLOW_MS,
  DANCE_FRAME_MS,
  getRainbowDanceView,
  installRainbowDance,
  RainbowDance,
  rainbowText,
  setRainbowDance,
} from '#/tui/easter-eggs/dance';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

/** Ordered list of "r,g,b" truecolor codes in the order they appear. */
function truecolorCodes(text: string): string[] {
  return [...text.matchAll(TRUECOLOR_PATTERN)].map((m) => `${m[1]},${m[2]},${m[3]}`);
}

describe('RainbowDance', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts uncolored — the banner keeps its default look', () => {
    const dance = new RainbowDance(vi.fn());

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
  });

  it('flows while dancing and requests renders', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: false });
    expect(dance.colored).toBe(true);

    const before = dance.phase;
    vi.advanceTimersByTime(DANCE_FRAME_MS);
    expect(dance.phase).not.toBe(before);
    expect(requestRender).toHaveBeenCalled();
  });

  it('fades back to default after the flow when not holding', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: false });
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
  });

  it('freezes into a static rainbow after the flow when holding', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(true);
    const frozen = dance.phase;
    vi.advanceTimersByTime(DANCE_FRAME_MS * 10);
    expect(dance.phase).toBe(frozen);
  });

  it('stops on demand back to the default colors and clears its timers', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 3);
    expect(dance.phase).toBeGreaterThan(0);

    requestRender.mockClear();
    dance.stop();
    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('dispose clears timers silently, without a final render', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dance = new RainbowDance(requestRender);

    dance.start({ hold: false });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 2);
    requestRender.mockClear();

    dance.dispose();
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('advances the phase by one per frame while flowing', () => {
    vi.useFakeTimers();
    const dance = new RainbowDance(vi.fn());

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(5);

    // Monotonic — the dance state itself has no palette-length cycle.
    vi.advanceTimersByTime(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(10);
  });
});

describe('rainbowText', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('assigns each visible character the next palette color', () => {
    const out = rainbowText('abcd', ['#111111', '#226622', '#aa33cc', '#44ddee'], 0);

    expect(truecolorCodes(out)).toEqual([
      '17,17,17',
      '34,102,34',
      '170,51,204',
      '68,221,238',
    ]);
  });

  it('does not consume a palette slot for spaces', () => {
    const out = rainbowText('a b', ['#111111', '#226622'], 0);

    expect(truecolorCodes(out)).toEqual(['17,17,17', '34,102,34']);
  });

  it('starts from the given offset', () => {
    const out = rainbowText('a', ['#111111', '#226622'], 1);

    expect(truecolorCodes(out)).toEqual(['34,102,34']);
  });
});

describe('installRainbowDance', () => {
  afterEach(() => {
    setRainbowDance(undefined);
    vi.useRealTimers();
  });

  it('returns a disposer that clears timers and uninstalls the controller', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const dispose = installRainbowDance(requestRender);
    const dance = getRainbowDanceView() as RainbowDance;

    dance.start({ hold: true });
    vi.advanceTimersByTime(DANCE_FRAME_MS * 2);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    dispose();

    expect(getRainbowDanceView()).toBeUndefined();
    vi.advanceTimersByTime(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });
});

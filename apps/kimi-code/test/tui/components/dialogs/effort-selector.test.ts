import { describe, expect, it, vi } from 'vitest';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function text(component: EffortSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('EffortSelectorComponent', () => {
  it('sorts the displayed intensity slots, keeps vendor values and commits the original selection', () => {
    const efforts = ['high', 'Vendor-ULTRA', 'max', 'low', 'medium', 'xhigh'];
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({ efforts, currentValue: 'high', onSelect, onCancel: vi.fn() });
    const row = picker.render(140).map(strip).find((line) => line.includes('[ High ]'))!;
    const labels = ['Low', 'Vendor-ULTRA', 'Medium', 'High', 'Xhigh', 'Max'];
    expect(labels.map((label) => row.indexOf(label))).toEqual(labels.map((label) => row.indexOf(label)).toSorted((a, b) => a - b));
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('high');
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('xhigh');
    expect(efforts).toEqual(['high', 'Vendor-ULTRA', 'max', 'low', 'medium', 'xhigh']);
  });

  it('keeps boolean on/off segments in their existing order', () => {
    const picker = new EffortSelectorComponent({ efforts: ['on', 'off'], currentValue: 'on', onSelect: vi.fn(), onCancel: vi.fn() });
    const row = picker.render(120).map(strip).find((line) => line.includes('[ On ]'))!;
    expect(row.indexOf('On')).toBeLessThan(row.indexOf('Off'));
  });

  it('renders efforts as horizontal segments with the active one bracketed', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    // All efforts are rendered on a single row.
    expect(out).toContain('Off');
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).toContain('Max');
    // The active level is wrapped in brackets; the rest are not.
    expect(out).toContain('[ High ]');
    expect(out).not.toContain('[ Off ]');
    expect(out).not.toContain('[ Max ]');
  });

  it('invokes onSelect with the chosen effort on Enter', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('high');
  });

  it('moves the active segment with Left/Right and stops at the edges', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    // index 2 (high) -> 3 (max).
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    // Already at the right edge — another Right stays put.
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    // Walk back to the left edge (max -> high -> low -> off).
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');

    // Already at the left edge — another Left stays put.
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');
  });

  it('invokes onSessionOnlySelect on Alt+S instead of onSelect', () => {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancels on Escape', () => {
    const onCancel = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
  });

  it('renders no warning line without the warning option', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe('');
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(40).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    // Word-wrapped: nothing dropped — the full warning survives across lines.
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });
});

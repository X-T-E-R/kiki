// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { LifeMark, resetLifeMarks } from './LifeMark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetLifeMarks();
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, root };
}

describe('LifeMark', () => {
  it('draws nothing for idle', () => {
    const { container } = render(<LifeMark markId="a" life="idle" />);
    expect(container.querySelector('[data-life]')).toBeNull();
  });

  it('keeps a still working mark from breathing', () => {
    const { container } = render(<LifeMark markId="a" life="working" still />);
    expect(container.querySelector('[data-life="working"]')?.hasAttribute('data-life-still')).toBe(true);
  });

  it('gives each state its own shape, not only its own colour', () => {
    const { container } = render(
      <>
        <LifeMark markId="w" life="working" still />
        <LifeMark markId="d" life="done" />
        <LifeMark markId="f" life="failed" />
      </>,
    );
    const working = container.querySelector('[data-life="working"]')!.className;
    const done = container.querySelector('[data-life="done"]')!.className;
    const failed = container.querySelector('[data-life="failed"]')!.className;
    // Working is a solid dot; done is a hollow ring; failed is a square.
    expect(working).toContain('bg-ink-soft');
    expect(done).toContain('bg-transparent');
    expect(done).toContain('border-ink-soft');
    expect(failed).toContain('rounded-[1.5px]!');
    // Stillness rides the attribute alone; no utility override.
    expect(working).not.toContain('animate-none');
  });

  it('settles done only when the state changes, not on first mount or remount', () => {
    const first = render(<LifeMark markId="s" life="done" />);
    // Mounting straight into done (a reload, a regroup) does not replay the settle.
    expect(first.container.querySelector('[data-life="done"]')?.hasAttribute('data-life-changed')).toBe(false);
    act(() => { first.root.unmount(); });

    const live = render(<LifeMark markId="t" life="working" />);
    act(() => { live.root.render(<LifeMark markId="t" life="done" />); });
    expect(live.container.querySelector('[data-life="done"]')?.hasAttribute('data-life-changed')).toBe(true);
    act(() => { live.root.unmount(); });

    // Remounting the same mark in the same state is quiet again.
    const again = render(<LifeMark markId="t" life="done" />);
    expect(again.container.querySelector('[data-life="done"]')?.hasAttribute('data-life-changed')).toBe(false);
  });
});

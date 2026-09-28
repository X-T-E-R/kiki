// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Icon, OutcomeMark, type OutcomeState } from './icons';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(node); });
  return container;
}

const LABELS = { running: 'Running', failed: 'Failed', stopped: 'Stopped', done: 'Done' };

describe('icon family', () => {
  it('draws every icon to the shared spec: 16px viewBox, 1.35 stroke, decorative', async () => {
    const container = await render(<Icon name="read" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg?.getAttribute('stroke-width')).toBe('1.35');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('data-icon')).toBe('read');
    expect(svg?.getAttribute('class')).toContain('h-3.5 w-3.5');
  });

  it('maps the three family sizes and lets an explicit box override them', async () => {
    const small = await render(<Icon name="chevron" size={12} />);
    expect(small.querySelector('svg')?.getAttribute('class')).toContain('h-3 w-3');
    const nav = await render(<Icon name="menu" size={16} />);
    expect(nav.querySelector('svg')?.getAttribute('class')).toContain('h-4 w-4');
    const custom = await render(<Icon name="menu" size={16} className="h-5 w-5" />);
    expect(custom.querySelector('svg')?.getAttribute('class')).not.toContain('h-4');
  });
});

describe('OutcomeMark', () => {
  it('keeps success visually silent but still announced', async () => {
    const container = await render(<OutcomeMark state="done" labels={LABELS} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.sr-only')?.textContent).toBe('Done');
  });

  it.each<[OutcomeState, string]>([
    ['running', 'Running'],
    ['failed', 'Failed'],
    ['stopped', 'Stopped'],
  ])('marks %s with a labelled drawn mark', async (state, label) => {
    const container = await render(<OutcomeMark state={state} labels={LABELS} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });
});

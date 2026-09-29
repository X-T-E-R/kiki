// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  transcriptDetailKey,
  type Block,
  type TranscriptDetailStatus,
} from '@kiki/session-core/session';
import type { MediaRef } from '@kiki/session-core/composer/media';

import { I18nProvider } from '../i18n';
import { MediaPartList } from './mediaPreview';
import { ShellMessage } from './Transcript';
import { TranscriptDetailProvider } from './transcriptDetail';

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount(); });
  document.body.innerHTML = '';
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    flushSync(() => { root.render(<MemoryRouter><I18nProvider>{node}</I18nProvider></MemoryRouter>); });
  });
  return container;
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
}

const truncatedShell: Extract<Block, { kind: 'shell' }> = {
  kind: 'shell', id: 'shell-task', commandId: 'task-1', command: 'pnpm build',
  output: '…last line', outputDetail: { agentId: 'main', taskId: 'task-1' }, done: true, isError: undefined,
};

/** Detail provider backed by a controllable loader; mirrors the controller's load states. */
function Harness({ load, children }: {
  load: (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => Promise<boolean>;
  children: ReactNode;
}) {
  const [loads, setLoads] = useState<Record<string, TranscriptDetailStatus>>({});
  return (
    <TranscriptDetailProvider load={() => load(setLoads)} loads={loads}>
      {children}
    </TranscriptDetailProvider>
  );
}

function renderShell(block: Extract<Block, { kind: 'shell' }>, load: Parameters<typeof Harness>[0]['load']) {
  return render(<Harness load={load}><ShellMessage block={block} /></Harness>);
}

describe('on-demand transcript detail', () => {
  it('offers the full output for a truncated shell tail and shows loading, error and retry', async () => {
    const key = transcriptDetailKey('task', 'task-1');
    const load = vi.fn()
      .mockImplementationOnce(async (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => {
        setLoads({ [key]: { status: 'error', message: 'offline' } });
        return false;
      })
      .mockImplementationOnce(async (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => {
        setLoads({ [key]: { status: 'loading' } });
        return true;
      });
    const container = await renderShell(truncatedShell, load);
    await click(container.querySelector('[data-shell] button'));

    const row = () => container.querySelector('[data-shell-output-detail]');
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('idle');
    expect(row()?.textContent).toContain('Showing the last lines only.');
    const action = () => container.querySelector<HTMLButtonElement>('[data-shell-output-detail-action]');
    expect(action()?.textContent).toBe('Show full output');

    await click(action());
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('error');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the full output.');
    expect(action()?.textContent).toBe('Try again');

    await click(action());
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('loading');
    expect(action()?.disabled).toBe(true);
    expect(action()?.getAttribute('aria-busy')).toBe('true');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows no affordance when the output is already complete or no reader is available', async () => {
    const complete = await renderShell({ ...truncatedShell, outputDetail: undefined }, vi.fn());
    await click(complete.querySelector('[data-shell] button'));
    expect(complete.querySelector('[data-shell-output-detail]')).toBeNull();

    const readOnly = await render(<ShellMessage block={truncatedShell} />);
    await click(readOnly.querySelector('[data-shell] button'));
    expect(readOnly.querySelector('[data-shell-output-detail]')).toBeNull();
    expect(readOnly.querySelector('pre')?.textContent).toBe('…last line');
  });

  it('defers a windowed attachment until the reader asks for it', async () => {
    const item: MediaRef = { kind: 'image', name: 'screenshot.png', size: 912_000, mime: 'image/png', detail: { agentId: 'main', attachmentId: 'att-1' } };
    const load = vi.fn(async () => true);
    const container = await render(
      <Harness load={load}><MediaPartList media={[item]} /></Harness>,
    );
    const chip = container.querySelector<HTMLButtonElement>('[data-media-deferred]');
    expect(chip?.getAttribute('data-media-deferred')).toBe('idle');
    expect(chip?.getAttribute('aria-label')).toBe('Load screenshot.png');
    expect(container.querySelector('img')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await click(chip);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

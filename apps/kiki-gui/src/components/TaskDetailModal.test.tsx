// @vitest-environment jsdom

/**
 * Background task detail modal — layout contract for long commands.
 *
 * The defect this file locks down: a task whose command is a long multi-line
 * script pushed the modal past its max height, the output pane collapsed to a
 * sliver, and nothing in the panel scrolled, so the tail of both the command
 * and the output was unreachable.
 *
 * jsdom has no layout engine, so these assertions read the declared geometry
 * contract (which element owns the scroll, which parts may shrink) and the
 * measured overflow the component computes for itself. Real wheel/keyboard
 * scrolling at real viewports is proved by the browser probe
 * (`scripts/task-detail-dialog-proof.mjs`), not by these assertions.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { TaskDetailModal } from './TaskDetailModal';

const getTask = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { getTask } }),
}));

const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

/**
 * jsdom ships no ResizeObserver, and the collapse measurement depends on one.
 * This stand-in lets a test resize an element and fire the observer the way a
 * real layout change does.
 */
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  constructor(private readonly callback: () => void) { resizeCallbacks.add(callback); }
  observe() { /* measurement is driven explicitly by `resize()` in tests */ }
  disconnect() { resizeCallbacks.delete(this.callback); }
}
function resize() { for (const callback of [...resizeCallbacks]) callback(); }

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => { getTask.mockReset(); });

afterEach(async () => {
  // Dialog renders through a body portal, so unmounting the container is not
  // enough — a leftover dialog would answer the next test's `body.querySelector`.
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const node of document.body.querySelectorAll('[role="dialog"]')) node.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

/** A realistic pasted installer script: dozens of lines, ~2.6 KB. */
const LONG_SCRIPT = [
  'bash -lc \'set -euo pipefail',
  '$ErrorActionPreference="Stop"',
  '$ProgressPreference="SilentlyContinue"',
  '$base="E:/Programs/AI/EasyAgent/systems/kiki"',
  'if(-not(Test-Path $base)){throw "workspace missing"}',
  '$extract=Join-Path $base ".tmp/extract"',
  'if(@(Get-ChildItem $extract -Force).Count -ne 0){throw "extract folder not empty; preserve contents"}',
  'New-Item -ItemType Directory -Force $extract | Out-Null',
  '$log=Join-Path $base "install.log"',
  'Write-Output "installing display driver; no clean install, no automatic reboot"',
  '$p=Start-Process Setup -ArgumentList @("-s","-n","/log:" + $log,"/loglevel:6") -Wait -PassThru',
  '$code=$p.ExitCode',
  'if($code -ne 0){throw "installer failed: $code"}',
  'Write-Output "NVIDIA_INSTALL_EXIT=$code"',
  '\'',
].join('\n');

/** One unbreakable ~4 KB token: the case where `overflow-x` is the only guard. */
const LONG_SINGLE_LINE = `powershell -NoProfile -EncodedCommand ${'Q0dFRAFBU1QTEVTVEVOVA=='.repeat(240)}`;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    session_id: 'sess-1',
    kind: 'bash',
    description: `task ${overrides.id}`,
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function flushMicrotasks(turns = 5) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderModal(task: Task, onCancelTask = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <TaskDetailModal
            sessionId="sess-1"
            task={task}
            onClose={() => {}}
            onCancelTask={onCancelTask}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flushMicrotasks();
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return { dialog: dialog!, container, onCancelTask };
}

/** jsdom has no layout: give an element a measurable box when a test needs one. */
function setBox(element: Element, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('TaskDetailModal long-command layout', () => {
  it('keeps a long command from taking the first screen and keeps the full text reachable', async () => {
    const task = makeTask({ id: 't1', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue({ ...task, output_preview: 'line one\nline two' });
    const { dialog } = await renderModal(task);

    // The command is present verbatim, never truncated or dropped.
    const command = dialog.querySelector<HTMLElement>('[data-task-detail-command]')!;
    expect(command.textContent).toBe(LONG_SCRIPT);

    // It starts collapsed: a long script must not own the first screen.
    expect(command.className).toMatch(/max-h-/);
    expect(command.className).toMatch(/overflow-hidden/);

    // A command that overflows its own box reports it, so the toggle appears.
    setBox(command, { scrollHeight: 640, clientHeight: 96 });
    await act(async () => { resize(); });
    await flushMicrotasks(2);
    const toggle = dialog.querySelector<HTMLButtonElement>('[data-task-detail-command-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    // Expanding keeps the same full text.
    await act(async () => { toggle.click(); });
    await flushMicrotasks(2);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const expanded = dialog.querySelector<HTMLElement>('[data-task-detail-command]')!;
    expect(expanded.textContent).toBe(LONG_SCRIPT);
    expect(expanded.className).not.toMatch(/max-h-/);
  });

  it('survives an unbreakable single-line command without horizontal overflow', async () => {
    const task = makeTask({ id: 't2', command: LONG_SINGLE_LINE });
    getTask.mockResolvedValue(task);
    const { dialog } = await renderModal(task);

    const command = dialog.querySelector<HTMLElement>('[data-task-detail-command]')!;
    expect(command.textContent).toBe(LONG_SINGLE_LINE);
    // `break-all` + `whitespace-pre-wrap` is what keeps 4 KB of base64 on screen.
    expect(command.className).toMatch(/whitespace-pre-wrap/);
    expect(command.className).toMatch(/break-all/);
  });

  it('gives the body one scroll container while header, footer and output chrome stay put', async () => {
    const task = makeTask({ id: 't3', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue({ ...task, output_preview: 'x' });
    const { dialog } = await renderModal(task);

    // Two scroll regions, and only two: the panel body, plus the output pane's
    // own tail. Nothing else (not the command, not the chrome) traps a wheel.
    const scrollers = [...dialog.querySelectorAll<HTMLElement>('*')].filter((element) => {
      const style = element.className;
      return typeof style === 'string' && /(^|\s|\[)overflow-(y-)?(auto|scroll)(\s|$)/.test(style);
    });
    expect(scrollers.map((element) => Object.hasOwn(element.dataset, 'taskDetailScroll') ? 'body' : 'output'))
      .toEqual(['body', 'output']);
    expect(scrollers[0]).toBe(dialog.querySelector('[data-task-detail-scroll]'));
    expect(scrollers[1]).toBe(dialog.querySelector('[data-task-detail-output]'));

    // Identity and the exit actions are outside that region, so they never scroll away.
    expect(dialog.querySelector('[data-task-detail-header]')).not.toBeNull();
    expect(dialog.querySelector('[data-task-detail-footer]')).not.toBeNull();
    expect(dialog.querySelector('[data-task-detail-scroll]')!.contains(dialog.querySelector('[data-task-detail-header]'))).toBe(false);
    expect(dialog.querySelector('[data-task-detail-scroll]')!.contains(dialog.querySelector('[data-task-detail-footer]'))).toBe(false);

    // The panel is a capped flex column — the property that makes the above work.
    expect(dialog.className).toMatch(/flex-col/);
    expect(dialog.className).toMatch(/max-h-/);
    expect(dialog.className).toMatch(/overflow-hidden/);
  });

  it('caps the output pane so a long command cannot squeeze it out of the panel', async () => {
    const task = makeTask({ id: 't4', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue({ ...task, output_preview: Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') });
    const { dialog } = await renderModal(task);

    const output = dialog.querySelector<HTMLElement>('[data-task-detail-output]')!;
    // A flex child needs min-h-0 to shrink below its content, a floor so a
    // short run stays readable, and a ceiling so a long one cannot push the
    // command out of reach — all three are load-bearing here.
    expect(output.className).toMatch(/min-h-/);
    expect(output.className).toMatch(/max-h-/);
    expect(output.className).toMatch(/flex-1/);
  });

  it('preserves the output auto-follow and user-scroll pause behaviour', async () => {
    const task = makeTask({ id: 't5', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue({ ...task, output_preview: 'line one\nline two' });
    const { dialog } = await renderModal(task);

    const toggle = dialog.querySelector<HTMLButtonElement>('[data-task-detail-follow]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toContain('Pause auto-scroll');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('Resume auto-scroll');

    // Scrolling up inside the output pauses follow; returning to the tail resumes it.
    const output = dialog.querySelector<HTMLElement>('[data-task-detail-output]')!;
    setBox(output, { scrollHeight: 1000, clientHeight: 200 });
    await act(async () => {
      Object.defineProperty(output, 'scrollTop', { value: 100, writable: true, configurable: true });
      output.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('Resume auto-scroll');

    await act(async () => {
      Object.defineProperty(output, 'scrollTop', { value: 800, writable: true, configurable: true });
      output.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toContain('Pause auto-scroll');
  });

  it('copies the full command verbatim, collapsed or expanded', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { language: 'en-US', clipboard: { writeText } });
    const task = makeTask({ id: 't6', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue(task);
    const { dialog } = await renderModal(task);

    const copy = dialog.querySelector<HTMLButtonElement>('[data-task-detail-copy-command]')!;
    expect(copy.getAttribute('aria-label')).toBe('Copy command');
    await act(async () => { copy.click(); });
    await flushMicrotasks(2);
    expect(writeText).toHaveBeenCalledWith(LONG_SCRIPT);

    const toggle = dialog.querySelector<HTMLButtonElement>('[data-task-detail-command-toggle]');
    if (toggle !== null) {
      await act(async () => { toggle.click(); });
      await flushMicrotasks(2);
      await act(async () => {
        dialog.querySelector<HTMLButtonElement>('[data-task-detail-copy-command]')!.click();
      });
      await flushMicrotasks(2);
      expect(writeText).toHaveBeenLastCalledWith(LONG_SCRIPT);
    }
  });

  it('stops a running task and closes through the shared handlers', async () => {
    const task = makeTask({ id: 't7', status: 'running', command: LONG_SCRIPT });
    getTask.mockResolvedValue(task);
    const onCancelTask = vi.fn();
    const { dialog } = await renderModal(task, onCancelTask);

    const stop = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Stop')!;
    await act(async () => { stop.click(); });
    expect(onCancelTask).toHaveBeenCalledWith('t7', undefined);
  });

  it('leaves a short command uncluttered: no toggle chrome unless it overflows', async () => {
    const task = makeTask({ id: 't8', command: 'pnpm test' });
    getTask.mockResolvedValue({ ...task, output_preview: 'all green' });
    const { dialog } = await renderModal(task);

    const command = dialog.querySelector<HTMLElement>('[data-task-detail-command]')!;
    expect(command.textContent).toBe('pnpm test');
    // jsdom reports no overflow, so no collapse affordance is rendered at all.
    expect(dialog.querySelector('[data-task-detail-command-toggle]')).toBeNull();
  });
});

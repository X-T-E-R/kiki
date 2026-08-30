// @vitest-environment jsdom

/**
 * ApprovalCard — external permission (ACP harness) slice.
 *
 * Covers the design-§9 contract: every option the agent offered is rendered
 * (open kind set, not a fixed three-button mapping), clicking one sends the
 * exact option id as `selectedOptionId`, cancel stays available, and a
 * payload that claims `external_permission` but fails validation fails closed
 * (cancel only, no approve path).
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { ApprovalBlock } from '../state/transcript';
import { ApprovalCard, externalPermissionFromDisplay } from './Interactions';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterAll(() => {
  for (const root of roots) root.unmount();
  for (const container of containers) container.remove();
});

async function renderCard(
  block: ApprovalBlock,
  onResolve: (
    decision: 'approved' | 'rejected' | 'cancelled',
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>,
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  const node: ReactNode = <ApprovalCard block={block} onResolve={onResolve} />;
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
  return container;
}

function approvalBlock(display: unknown): ApprovalBlock {
  return {
    kind: 'approval',
    id: 'approval-ext-1',
    request: {
      approval_id: 'approval-ext-1',
      session_id: 'session_test',
      tool_call_id: 'call-ext-1',
      tool_name: 'grok__bash',
      action: 'Run shell command',
      tool_input_display: display,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
}

const EXTERNAL_DISPLAY = {
  kind: 'external_permission',
  summary: 'Grok wants to run: pnpm test',
  options: [
    { id: 'opt-once', label: 'Allow once', kind: 'allow_once' },
    {
      id: 'opt-always',
      label: 'Always allow pnpm',
      kind: 'allow_always',
      changes: [{ type: 'command_rule', command: 'pnpm test' }],
    },
    { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
    // Open set: kinds beyond the common four must still render and round-trip.
    { id: 'opt-plan', label: 'Approve plan review', kind: 'plan_review_accept' },
  ],
};

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function optionButtons(container: HTMLDivElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

describe('externalPermissionFromDisplay', () => {
  it('accepts a well-formed payload including unknown option kinds', () => {
    const parsed = externalPermissionFromDisplay(EXTERNAL_DISPLAY);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed?.ok !== true) throw new Error('expected ok');
    expect(parsed.display.options.map((option) => option.id)).toEqual([
      'opt-once',
      'opt-always',
      'opt-reject',
      'opt-plan',
    ]);
  });

  it('returns undefined for other display kinds', () => {
    expect(externalPermissionFromDisplay({ kind: 'command', command: 'ls' })).toBeUndefined();
    expect(externalPermissionFromDisplay(undefined)).toBeUndefined();
    expect(externalPermissionFromDisplay('external_permission')).toBeUndefined();
  });

  it('fails closed on malformed payloads', () => {
    expect(externalPermissionFromDisplay({ kind: 'external_permission', summary: '' , options: [] })).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({ kind: 'external_permission', summary: 'x', options: [] }),
    ).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({
        kind: 'external_permission',
        summary: 'x',
        options: [{ id: 'a', label: 'A' }],
      }),
    ).toEqual({ ok: false });
    expect(
      externalPermissionFromDisplay({
        kind: 'external_permission',
        summary: 'x',
        options: [{ id: 'a', label: 'A', kind: 'allow_once', changes: 'nope' }],
      }),
    ).toEqual({ ok: false });
  });
});

describe('ApprovalCard external permission', () => {
  it('renders every agent-supplied option with kind chips and a changes disclosure', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(approvalBlock(EXTERNAL_DISPLAY), onResolve);

    expect(container.textContent).toContain('External agent permission');
    expect(container.textContent).toContain('Grok wants to run: pnpm test');
    const options = optionButtons(container);
    expect(options.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Allow once'),
      expect.stringContaining('Always allow pnpm'),
      expect.stringContaining('Reject'),
      expect.stringContaining('Approve plan review'),
    ]);
    // The unknown kind shows the raw kind string, not an invented label.
    expect(container.textContent).toContain('plan_review_accept');
    expect(container.textContent).toContain('1 granted change');
    // No native approve/reject/remember controls on the external card.
    expect(container.textContent).not.toContain('Remember for this session');
  });

  it('submits the exact option id with the mapped decision', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    const options = optionButtons(container);
    await act(async () => {
      flushSync(() => { click(options[1]!); });
    });
    expect(calls).toEqual([['approved', undefined, 'opt-always']]);
  });

  it('maps reject-ish kinds to a rejected decision with the exact id', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    await act(async () => {
      flushSync(() => { click(optionButtons(container)[2]!); });
    });
    expect(calls).toEqual([['rejected', undefined, 'opt-reject']]);
  });

  it('keeps cancel available and sends no option id', async () => {
    const calls: unknown[][] = [];
    const container = await renderCard(
      approvalBlock(EXTERNAL_DISPLAY),
      (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    );

    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    await act(async () => {
      flushSync(() => { click(cancel!); });
    });
    expect(calls).toEqual([['cancelled', undefined, undefined]]);
  });

  it('expands the changes disclosure to show what an option grants', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(approvalBlock(EXTERNAL_DISPLAY), onResolve);

    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('granted change') === true,
    );
    expect(toggle).toBeDefined();
    expect(container.textContent).not.toContain('command_rule');
    await act(async () => {
      flushSync(() => { click(toggle!); });
    });
    expect(container.textContent).toContain('command_rule');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('fails closed on an unrecognizable payload: cancel only, no options', async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const container = await renderCard(
      approvalBlock({ kind: 'external_permission', summary: 'broken', options: 'nope' }),
      onResolve,
    );

    expect(optionButtons(container)).toEqual([]);
    expect(container.textContent).toContain('could not be recognized');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel']);

    await act(async () => {
      flushSync(() => { click(buttons[0]!); });
    });
    expect(onResolve).toHaveBeenCalledWith('cancelled', undefined, undefined);
  });
});

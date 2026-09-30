// @vitest-environment jsdom

/**
 * ApprovalCard — plan review. Native ExitPlanMode and an external engine's
 * `exit_plan_mode` both arrive as a `plan_review` approval: the plan renders
 * as Markdown (not the raw-JSON fallback), approve carries the chosen
 * alternative, and Revise / Reject-and-exit carry `selected_label` + note.
 */

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { ApprovalCard, planReviewFromDisplay, type PlanReviewResponse } from './Interactions';

vi.mock('../state/connection', () => ({ useOptionalConnection: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
});

const PLAN = '## Plan\n\n1. Reject limits below 1.\n2. Return 400.';

function block(display: unknown): ApprovalBlock {
  return {
    kind: 'approval',
    id: 'approval-plan',
    request: {
      approval_id: 'grok-plan:1', session_id: 's', tool_call_id: 'call-plan', tool_name: 'Exit plan mode',
      action: 'Review external plan', tool_input_display: display,
      created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
}

type Resolve = (decision: 'approved' | 'rejected' | 'cancelled', scope?: 'session', optionId?: string, review?: PlanReviewResponse) => Promise<void>;

async function render(display: unknown, onResolve: Resolve): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    flushSync(() => {
      root!.render(<MemoryRouter><I18nProvider><ApprovalCard block={block(display)} onResolve={onResolve} /></I18nProvider></MemoryRouter>);
    });
  });
  return container;
}

function click(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function type(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('planReviewFromDisplay', () => {
  it('reads plan, path and options, and ignores other kinds', () => {
    expect(planReviewFromDisplay({ kind: 'plan_review', plan: PLAN, path: 'plan.md' })).toEqual({ plan: PLAN, path: 'plan.md', options: undefined });
    expect(planReviewFromDisplay({ kind: 'plan_review', plan: PLAN, options: [{ label: 'A', description: 'a' }, { label: 7 }] })?.options)
      .toEqual([{ label: 'A', description: 'a' }]);
    expect(planReviewFromDisplay({ kind: 'command', command: 'ls' })).toBeUndefined();
    expect(planReviewFromDisplay({ kind: 'plan_review' })).toBeUndefined();
  });
});

describe('plan review card', () => {
  it('renders the plan as Markdown instead of the JSON fallback', async () => {
    const view = await render({ kind: 'plan_review', plan: PLAN }, vi.fn(() => Promise.resolve()));
    expect(view.querySelector('[data-plan-review]')).not.toBeNull();
    expect(view.querySelector('[data-plan-body] h2')?.textContent).toBe('Plan');
    expect(view.textContent).not.toContain('"kind"');
  });

  it('approves with the chosen alternative', async () => {
    const onResolve = vi.fn<Resolve>(() => Promise.resolve());
    const view = await render({ kind: 'plan_review', plan: PLAN, options: [
      { label: 'Patch parser', description: 'Smallest change' }, { label: 'New schema', description: 'Validate at the edge' },
    ] }, onResolve);
    await act(async () => { click(view.querySelector('[data-plan-option="New schema"] input')); });
    await act(async () => { click(view.querySelector('[data-plan-approve]')); });
    expect(onResolve).toHaveBeenCalledWith('approved', undefined, undefined, { selectedLabel: 'New schema' });
  });

  it('needs a note to ask for changes and sends it with Revise', async () => {
    const onResolve = vi.fn<Resolve>(() => Promise.resolve());
    const view = await render({ kind: 'plan_review', plan: PLAN }, onResolve);
    const revise = view.querySelector<HTMLButtonElement>('[data-plan-revise]')!;
    expect(revise.disabled).toBe(true);
    await act(async () => { type(view.querySelector<HTMLTextAreaElement>('[data-plan-note]')!, '  Cover negative values.  '); });
    expect(revise.disabled).toBe(false);
    await act(async () => { click(revise); });
    expect(onResolve).toHaveBeenCalledWith('rejected', undefined, undefined, { selectedLabel: 'Revise', feedback: 'Cover negative values.' });
    expect(view.querySelector('[data-plan-answered="revise"]')).not.toBeNull();
  });

  it('rejects and exits plan mode without a note', async () => {
    const onResolve = vi.fn<Resolve>(() => Promise.resolve());
    const view = await render({ kind: 'plan_review', plan: PLAN }, onResolve);
    await act(async () => { click(view.querySelector('[data-plan-exit]')); });
    expect(onResolve).toHaveBeenCalledWith('rejected', undefined, undefined, { selectedLabel: 'Reject and Exit' });
  });

  it('keeps the buttons and says so when the decision fails to send', async () => {
    const view = await render({ kind: 'plan_review', plan: PLAN }, vi.fn(() => Promise.reject(new Error('expired'))));
    await act(async () => { click(view.querySelector('[data-plan-approve]')); });
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.querySelector('[data-plan-approve]')).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalBlock, Block, DisplayNode, QuestionBlock } from '@kiki/session-core/session';
import {
  groupHistoryRuns,
  HistoryLine,
  HistoryRunRow,
  isMarkerNotice,
} from './ActivityHistory';
import { ResyncStatusBanner } from './agent-workspace';
import { I18nProvider } from '../i18n';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

const resolvedApproval: ApprovalBlock = {
  kind: 'approval',
  id: 'approval-done',
  request: {
    approval_id: 'a1',
    session_id: 'session-fixture',
    tool_call_id: 'call-1',
    tool_name: 'Bash',
    action: 'Running: pnpm test',
    tool_input_display: undefined,
    created_at: '2026-09-06T00:00:00Z',
    expires_at: '2026-09-07T00:00:00Z',
  },
  resolution: { decision: 'approved', resolvedAt: '2026-09-06T00:10:00Z' },
};

const answeredQuestion: QuestionBlock = {
  kind: 'question',
  id: 'question-done',
  request: {
    question_id: 'q1',
    session_id: 'session-fixture',
    created_at: '2026-09-06T00:00:00Z',
    questions: [
      {
        id: 'qi-1',
        question: 'Go one level deeper?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
  },
  outcome: { kind: 'answered', at: '2026-09-06T00:05:00Z' },
};

const markerNotice: Block = {
  kind: 'notice',
  id: 'agent-marker-goal',
  text: 'goal set',
  tone: 'neutral',
};

const compactable = (node: DisplayNode): boolean =>
  (node.kind === 'approval' && node.resolution !== undefined) ||
  (node.kind === 'question' && node.outcome !== undefined) ||
  (node.kind === 'notice' && isMarkerNotice(node));

describe('groupHistoryRuns', () => {
  it('folds runs of consecutive compact entries and keeps singles individual', () => {
    const second: Block = { kind: 'notice', id: 'agent-marker-plan', text: 'plan', tone: 'neutral' };
    // A non-compact entry (here a danger notice; user/assistant blocks behave
    // the same) breaks the run.
    const breaker: Block = { kind: 'notice', id: 'error', text: 'A real error', tone: 'danger' };
    const nodes = [markerNotice, second, resolvedApproval, breaker, answeredQuestion] as DisplayNode[];
    const grouped = groupHistoryRuns(nodes, compactable);
    expect(grouped.map((node) => node.kind)).toEqual(['history-run', 'notice', 'question']);
    const run = grouped[0];
    if (run?.kind !== 'history-run') throw new Error('expected a history run');
    expect(run.id).toBe('history-run-agent-marker-goal');
    expect(run.nodes.map((node) => node.id)).toEqual([
      'agent-marker-goal',
      'agent-marker-plan',
      'approval-done',
    ]);
    // The breaker splits the pile: the trailing answered question stays a
    // single line instead of joining across the boundary.
    expect(grouped[2]).toBe(answeredQuestion);
  });

  it('never folds entries the predicate rejects (failures, pending cards)', () => {
    const pending: QuestionBlock = { ...answeredQuestion, id: 'question-pending', outcome: undefined };
    const nodes = [markerNotice, pending, resolvedApproval] as DisplayNode[];
    const grouped = groupHistoryRuns(nodes, compactable);
    expect(grouped.map((node) => node.kind)).toEqual(['notice', 'question', 'approval']);
  });
});

describe('HistoryLine', () => {
  it('renders a resolved approval as one compact line with origin and decision', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <HistoryLine node={resolvedApproval} originName="Writer" />
      </I18nProvider>,
    );
    expect(html).toContain('data-history-line');
    expect(html).toContain('Writer');
    expect(html).toContain('Bash');
    expect(html).toContain('Running: pnpm test');
    expect(html).toContain('Approved');
  });

  it('renders an answered question line and stays empty while pending', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <HistoryLine node={answeredQuestion} />
      </I18nProvider>,
    );
    expect(html).toContain('Go one level deeper?');
    expect(html).toContain('Question answered');
    const pending = renderToStaticMarkup(
      <I18nProvider>
        <HistoryLine node={{ ...answeredQuestion, outcome: undefined }} />
      </I18nProvider>,
    );
    expect(pending).toBe('');
  });
});

it('HistoryRunRow folds members behind a summary and expands on click', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const run = groupHistoryRuns([markerNotice, resolvedApproval] as DisplayNode[], compactable)[0];
  if (run?.kind !== 'history-run') throw new Error('expected a history run');
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider>
        <HistoryRunRow run={run} renderMember={(node) => <p>{node.id}</p>} />
      </I18nProvider>,
    ),
  );
  expect(container.querySelector('[data-history-run-members]')).toBeNull();
  const toggle = container.querySelector('button')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-history-run-members]')?.textContent).toContain('approval-done');
  await act(async () => root.unmount());
});

it('shows the actual resync error and runs manual retry without a false retrying indicator', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'zh');
  const retry = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><ResyncStatusBanner resyncing={false} resyncFailed error={{ message: 'Saved transcript unavailable', code: 50301, requestId: 'request-fixture', retryable: false }} onRetry={retry} /></I18nProvider>));
  expect(container.textContent).toContain('Saved transcript unavailable');
  expect(container.textContent).toContain('request-fixture');
  expect(container.textContent).not.toContain('正在重试');
  expect(container.querySelector('.status-dot-busy')).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

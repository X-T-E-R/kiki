// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalBlock, Block, NoticeBlock, QuestionBlock } from '@kiki/session-core/session';
import { HistoryLine, isMarkerNotice, revealSubagentCard } from './ActivityHistory';
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

describe('settled history stays inline', () => {
  it('marks only transcript-owned neutral markers, so notices are not mistaken for events', () => {
    expect(isMarkerNotice(markerNotice as NoticeBlock)).toBe(true);
    const danger: Block = { kind: 'notice', id: 'error', text: 'A real error', tone: 'danger' };
    expect(isMarkerNotice(danger as NoticeBlock)).toBe(false);
  });

  it('reveals a mounted subagent card without needing a fold to be expanded first', () => {
    const host = document.createElement('div');
    const card = document.createElement('div');
    card.setAttribute('data-subagent-id', 'agent-7');
    card.scrollIntoView = vi.fn();
    host.append(card);
    document.body.append(host);
    try {
      expect(revealSubagentCard('agent-7')).toBe(true);
      expect(card.scrollIntoView).toHaveBeenCalled();
      // Not mounted (outside the virtual window) reports false so the caller
      // keeps retrying; it never silently claims success.
      expect(revealSubagentCard('agent-missing')).toBe(false);
    } finally {
      host.remove();
    }
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

it('renders a settled decision as a plain line with no fold to open', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider>
        <HistoryLine node={resolvedApproval} />
      </I18nProvider>,
    ),
  );
  // No disclosure control and no counter: the fact is already on screen.
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('[aria-expanded]')).toBeNull();
  expect(container.textContent).toContain('Running: pnpm test');
  expect(container.textContent).not.toMatch(/completed actions/);
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

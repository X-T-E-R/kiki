// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Block, SessionViewState, TurnTailInfo, UserBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../../i18n';
import { MobileTranscript } from '../../mobile/chat/MobileTranscript';
import {
  buildDiagnosticClipboardText,
  classifyDiagnosticCategory,
  decodeFullDiagnostic,
} from '../agent-panel/failureText';
import { ModelSwitchActionsContext } from '../model-switch/ModelSwitchNotice';
import { SubagentEndedRow } from './FoldRows';
import { ModelDisplayProvider } from './ModelDisplayContext';
import { TimelineErrorCallout } from './TimelineErrorCallout';
import { TurnFootnote } from './TurnFootnote';
import { canFaithfullyRetryUserBlock, TurnTailSurface } from './TurnTailSurface';

const roots: Root[] = [];

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    flushSync(() => {
      root.render(<I18nProvider>{node}</I18nProvider>);
    });
  });
  return container;
}

beforeEach(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    act(() => {
      flushSync(() => {
        root.unmount();
      });
    });
  }
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('0.6.1 failureText & TimelineErrorCallout (Release Gate 2)', () => {
  it('decodes gateway capacity error, double-encoded JSON, validation arrays, and never misclassifies Request ID digits', () => {
    const gatewayRaw = 'Anthropic error: gateway_stream_terminal_error: No capacity available for model gemini-4-carbon-20260401';
    const decoded = decodeFullDiagnostic(gatewayRaw);
    expect(decoded.category).toBe('capacity');
    expect(decoded.decodedMessage).toContain('No capacity available for model gemini-4-carbon-20260401');

    const reqIdOnly = 'Unknown failure (request_id: req_401_403_429_503_abc)';
    expect(classifyDiagnosticCategory({ message: reqIdOnly })).toBe('unknown');

    const doubleEncoded = JSON.stringify(JSON.stringify({
      error: {
        code: 'validation_error',
        request_id: 'req_9876543210_verylongunbrokenidentifier',
        details: [
          { path: 'messages[0]', message: 'First issue detail' },
          { path: 'tools[2]', message: 'Second issue detail' },
        ],
      },
    }));
    const parsedDouble = decodeFullDiagnostic(doubleEncoded);
    expect(parsedDouble.decodedMessage).toContain('First issue detail');
    expect(parsedDouble.decodedMessage).toContain('Second issue detail');
    expect(parsedDouble.requestId).toBe('req_9876543210_verylongunbrokenidentifier');
    expect(parsedDouble.hasDistinctRaw).toBe(true);
  });

  it('copies the complete diagnostic identically when Details are closed vs open and when superseded', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async (text: string) => {
          writes.push(text);
        }),
      },
    });

    const rawMessage = 'Anthropic error: gateway_stream_terminal_error: No capacity available for model gemini-4-carbon';
    const rawDetails = JSON.stringify({
      error: {
        type: 'gateway_stream_terminal_error',
        message: 'No capacity available for model gemini-4-carbon',
        request_id: 'req_cap_001',
        status: 503,
      },
    });
    const expectedClipboard = buildDiagnosticClipboardText(decodeFullDiagnostic(rawMessage, rawDetails));

    const onSwitch = vi.fn();
    const container = mount(
      <TimelineErrorCallout
        incidentId="inc-cap-1"
        message={rawMessage}
        errorDetails={rawDetails}
        createdAt="2026-11-25T00:00:00Z"
        actions={[{ id: 'switch', label: '切换模型', onClick: onSwitch, primary: true }]}
      />,
    );

    expect(container.querySelector('[data-error-title]')?.textContent).toBe('模型容量暂时不足');
    const msgEl = container.querySelector('[data-error-message]')!;
    expect(msgEl.textContent).toContain('No capacity available for model gemini-4-carbon');
    expect(msgEl.className).not.toContain('truncate');
    expect(msgEl.className).not.toContain('line-clamp');

    const copyBtn = container.querySelector<HTMLButtonElement>('[data-copy-state]')!;
    expect(copyBtn.textContent).toContain('复制');
    await act(async () => {
      copyBtn.click();
    });
    expect(writes[0]).toBe(expectedClipboard);
    expect(writes[0]).toContain('req_cap_001');

    const rawToggle = container.querySelector<HTMLButtonElement>('[data-error-raw-toggle]')!;
    expect(rawToggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      rawToggle.click();
    });
    expect(container.querySelector('[data-error-raw-details]')?.textContent).toContain('req_cap_001');
    await act(async () => {
      copyBtn.click();
    });
    expect(writes[1]).toBe(writes[0]);

    const supContainer = mount(
      <TimelineErrorCallout
        incidentId="inc-cap-sup"
        message={rawMessage}
        errorDetails={rawDetails}
        superseded
        actions={[{ id: 'switch', label: '切换模型', onClick: onSwitch, primary: true }]}
      />,
    );
    expect(supContainer.querySelector('[data-error-superseded="true"]')).not.toBeNull();
    expect(supContainer.querySelector('[data-error-action="switch"]')).toBeNull();
    const supCopy = supContainer.querySelector<HTMLButtonElement>('[data-copy-state]')!;
    await act(async () => {
      supCopy.click();
    });
    expect(writes[2]).toBe(expectedClipboard);
    const expandBtn = supContainer.querySelector<HTMLButtonElement>('[data-error-expand]')!;
    await act(async () => {
      expandBtn.click();
    });
    expect(supContainer.querySelector('[data-error-message]')?.textContent).toContain('No capacity available');
  });

  it('handles clipboard denial without falsely showing copied state', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('Permission denied');
        }),
      },
    });
    const container = mount(
      <TimelineErrorCallout incidentId="inc-deny" message="Connection reset by peer" />,
    );
    const copyBtn = container.querySelector<HTMLButtonElement>('[data-copy-state]')!;
    await act(async () => {
      copyBtn.click();
    });
    expect(copyBtn.getAttribute('data-copy-state')).not.toBe('copied');
    expect(container.querySelector('[data-error-message]')?.className).toContain('select-text');
  });
});

describe('0.6.1 TurnFootnote & TurnTailSurface (Release Gate 3)', () => {
  it('renders all 4 timing facts without flanking horizontal rules', () => {
    const tail: TurnTailInfo = {
      turnId: 't1',
      state: 'completed',
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 136_000,
      ttftMs: 29_000,
      usage: undefined,
      tokensPerSecond: 10.2,
    };
    const container = mount(<TurnFootnote tail={tail} />);
    const text = container.querySelector('[data-turn-footnote]')?.textContent ?? '';
    expect(text).toContain('用时 2分16秒');
    expect(text).toContain('首 token 29 秒');
    expect(text).toContain('10 token/秒');
    expect(container.querySelector('[data-timeline-divider]')).toBeNull();
  });

  it('shows ONE recovery callout for completed + 6 recoverable tasks, and footnote ONLY for stale zero counts', () => {
    const tail: TurnTailInfo = {
      turnId: 't1',
      state: 'completed',
      endedAt: '2026-11-25T00:00:00Z',
      durationMs: 136_000,
      ttftMs: 29_000,
      usage: undefined,
      tokensPerSecond: 10,
    };
    const onRecover = vi.fn();
    const withRealLoss = mount(
      <TurnTailSurface
        agentId="main"
        tail={tail}
        footnoteAttachedInline
        interruptedWork={{
          interrupted_at: '2026-11-25T00:00:00Z',
          lost_tasks: 6,
          targets: [{ agent_id: 'w1', kind: 'subagent', reason: 'lost_task', label: 'worker', lost_tasks: 6 }],
        }}
        onRecoverInterruption={onRecover}
      />,
    );
    expect(withRealLoss.querySelectorAll('[data-timeline-error-callout]')).toHaveLength(1);
    expect(withRealLoss.querySelector('[data-timeline-divider]')).toBeNull();
    expect(withRealLoss.querySelector('[data-interruption-recover]')?.textContent).toBe('继续执行');

    const withStaleEmpty = mount(
      <TurnTailSurface
        agentId="main"
        tail={tail}
        footnoteAttachedInline
        interruptedWork={{
          interrupted_at: '2026-11-25T00:00:00Z',
          lost_tasks: 0,
          interrupted_branches: 0,
        }}
        onRecoverInterruption={onRecover}
      />,
    );
    expect(withStaleEmpty.querySelector('[data-timeline-error-callout]')).toBeNull();
    expect(withStaleEmpty.textContent).toBe('');
  });
});

describe('0.6.1 MobileTranscript parity (Reply & Message modes)', () => {
  it('renders epoch dividers, TimelineErrorCallout, TurnFootnote, and injection variant headings on mobile', () => {
    const blocks: Block[] = [
      { kind: 'user', id: 'u1', text: 'check', turnId: 't1', createdAt: '2026-11-25T00:00:00Z' },
      { kind: 'system-reminder', id: 'r1', text: 'Follow strict review.', variant: 'model_steering', turnId: 't1', createdAt: '2026-11-25T00:00:01Z' },
      { kind: 'system-reminder', id: 'r2', text: 'Host runtime snapshot rev 1340.', variant: 'runtime_snapshot', turnId: 't1', createdAt: '2026-11-25T00:00:02Z' },
      { kind: 'notice', id: 'n-clear', text: 'cleared', tone: 'neutral', markerKind: 'context.clear', i18n: { key: 'transcript.marker.contextClear' }, createdAt: '2026-11-25T00:00:03Z' },
      { kind: 'notice', id: 'n-int', text: 'compaction', tone: 'neutral', markerKind: 'compaction', compactionPhase: 'interrupted', i18n: { key: 'transcript.marker.compactionInterrupted' }, createdAt: '2026-11-25T00:00:04Z' },
      { kind: 'assistant', id: 'a1', text: 'Done.', streaming: false, turnId: 't1', createdAt: '2026-11-25T00:00:05Z' },
    ];
    const turnTail: TurnTailInfo = {
      turnId: 't1',
      state: 'completed',
      endedAt: '2026-11-25T00:00:05Z',
      durationMs: 136_000,
      ttftMs: 29_000,
      usage: undefined,
      tokensPerSecond: 10,
    };
    const mobileState = {
      sessionId: 'mobile-test',
      loaded: true,
      transcriptReady: true,
      busy: false,
      blocks,
      turnTail,
      turnTerminals: { t1: turnTail },
    } as unknown as SessionViewState;

    const replyContainer = mount(
      <MobileTranscript
        blocks={blocks}
        state={mobileState}
        loaded
        hasMoreHistory={false}
        loadingOlder={false}
        busy={false}
        messageMode={false}
        onLoadOlder={async () => false}
        onOpenHood={() => undefined}
        onResolveApproval={async () => undefined}
        onAnswerQuestion={async () => undefined}
        onDismissQuestion={async () => undefined}
        onOpenWorkbench={() => undefined}
      />,
    );
    expect(replyContainer.querySelector('[data-timeline-divider][data-notice-key="transcript.marker.contextClear"]')).not.toBeNull();
    const intCallout = replyContainer.querySelector('[data-timeline-error-callout][data-notice-key="transcript.marker.compactionInterrupted"]');
    expect(intCallout).not.toBeNull();
    expect(intCallout?.querySelector('[data-copy-state]')).not.toBeNull();
    expect(replyContainer.querySelector('[data-turn-footnote]')?.textContent).toContain('用时 2分16秒');

    const msgContainer = mount(
      <MobileTranscript
        blocks={blocks}
        state={mobileState}
        loaded
        hasMoreHistory={false}
        loadingOlder={false}
        busy={false}
        messageMode
        onLoadOlder={async () => false}
        onOpenHood={() => undefined}
        onResolveApproval={async () => undefined}
        onAnswerQuestion={async () => undefined}
        onDismissQuestion={async () => undefined}
        onOpenWorkbench={() => undefined}
      />,
    );
    expect(msgContainer.querySelector('[data-timeline-divider][data-notice-key="transcript.marker.contextClear"]')).not.toBeNull();
    expect(msgContainer.querySelector('[data-timeline-error-callout][data-notice-key="transcript.marker.compactionInterrupted"]')).not.toBeNull();
    expect(msgContainer.querySelector('[data-turn-footnote]')?.textContent).toContain('10 token/秒');
  });

  it('F1: refuses attachment-stripping retry without userMessageId and falls back to draft restore', () => {
    const withMediaNoId: UserBlock = {
      kind: 'user',
      id: 'u-media',
      text: 'Inspect attached screenshot',
      createdAt: '2026-11-25T07:00:00.000Z',
      media: [{ kind: 'image', url: 'blob:1' } as NonNullable<UserBlock['media']>[number]],
    };
    expect(canFaithfullyRetryUserBlock(withMediaNoId, true)).toBe(false);
    expect(canFaithfullyRetryUserBlock({ ...withMediaNoId, userMessageId: 'msg-1' }, true)).toBe(true);
    expect(canFaithfullyRetryUserBlock({ ...withMediaNoId, userMessageId: 'msg-1' }, false)).toBe(false);

    const onRetryFailed = vi.fn();
    const onRestoreDraft = vi.fn();
    const container = mount(
      <TurnTailSurface
        agentId="main"
        tail={{
          turnId: 't-fail-media',
          state: 'failed',
          error: '503 service unavailable',
          endedAt: '2026-11-25T07:01:00.000Z',
          durationMs: undefined,
          ttftMs: undefined,
          usage: undefined,
          tokensPerSecond: undefined,
        }}
        failedTurnUserBlock={withMediaNoId}
        hasOriginalRetry
        hasDraftRestore
        onRetryFailed={onRetryFailed}
        onRestoreDraft={onRestoreDraft}
      />,
    );
    expect(container.querySelector('[data-turn-tail-retry-now]')).toBeNull();
    const restoreBtn = container.querySelector<HTMLButtonElement>('[data-turn-tail-retry]');
    expect(restoreBtn).not.toBeNull();
    act(() => {
      restoreBtn?.click();
    });
    expect(onRestoreDraft).toHaveBeenCalledTimes(1);
    expect(onRetryFailed).not.toHaveBeenCalled();
  });

  it('F2+F3+F4+F6: MobileTranscript preserves native executor catalog labels, switch actions, auth provider-settings action, and named #13 routine details', () => {
    const onRetrySwitch = vi.fn();
    const onKeepOriginal = vi.fn();
    const onOpenProviderSettings = vi.fn();
    const catalog = [
      {
        id: 'axon-message/gemini-4-carbon',
        remote_id: 'gemini-4-carbon',
        provider_id: 'axon-message',
        display_name: 'Gemini 4 Carbon',
        provider_display_name: 'Axon',
      },
      {
        id: 'axon/gpt-6-luna',
        remote_id: 'gpt-6-luna',
        provider_id: 'axon',
        display_name: 'GPT-6 Luna',
        provider_display_name: 'Axon',
      },
    ];
    const blocks: Block[] = [
      {
        kind: 'notice',
        id: 'n-sw-fail',
        text: 'Model switch failed',
        tone: 'danger',
        createdAt: '2026-11-25T07:00:00.000Z',
        modelSwitch: {
          operationId: 'sw-op-1',
          state: 'failed',
          mode: 'compact',
          from: 'axon/gpt-6-luna',
          to: 'axon-message/gemini-4-carbon',
          error: { code: 'compact_failed', message: 'Compaction failed before switch' },
        },
      },
      {
        kind: 'system',
        id: 'sys-hook',
        variant: 'hook_result',
        hookEvent: 'pre_tool_use',
        text: 'Hook verified workspace rules',
        createdAt: '2026-11-25T07:00:10.000Z',
        turnId: 't1',
      },
      {
        kind: 'system',
        id: 'sys-cron',
        variant: 'cron_job',
        source: 'nightly-audit',
        text: 'Cron job payload body',
        createdAt: '2026-11-25T07:00:11.000Z',
        turnId: 't1',
      },
      {
        kind: 'skill',
        id: 'sk-1',
        source: 'skill',
        name: 'web-craft',
        args: undefined,
        text: 'Loaded web-craft instructions',
        createdAt: '2026-11-25T07:00:12.000Z',
        turnId: 't1',
      },
    ];
    const state: SessionViewState = {
      sessionId: 's-mob-full',
      loaded: true,
      transcriptReady: true,
      busy: false,
      hasMoreHistory: false,
      blocks,
      tasks: [],
      todos: [],
      session: {
        id: 's-mob-full',
        executor_id: 'native',
      } as SessionViewState['session'],
      turnTail: {
        turnId: 't1',
        state: 'failed',
        error: 'HTTP 401 invalid API key',
        endedAt: '2026-11-25T07:01:00.000Z',
      },
    } as unknown as SessionViewState;

    const container = mount(
      <ModelSwitchActionsContext.Provider value={{ retry: onRetrySwitch, keepOriginal: onKeepOriginal }}>
        <MobileTranscript
          blocks={blocks}
          state={state}
          loaded
          hasMoreHistory={false}
          loadingOlder={false}
          busy={false}
          messageMode={false}
          modelCatalog={catalog}
          modelCatalogScope="local"
          onLoadOlder={async () => false}
          onOpenHood={() => undefined}
          onResolveApproval={async () => undefined}
          onAnswerQuestion={async () => undefined}
          onDismissQuestion={async () => undefined}
          onOpenWorkbench={() => undefined}
          onOpenProviderSettings={onOpenProviderSettings}
        />
      </ModelSwitchActionsContext.Provider>,
    );

    expect(container.textContent).toContain('GPT-6 Luna');
    expect(container.textContent).not.toContain('模型名称未知');
    const rawToggle = container.querySelector<HTMLButtonElement>('[data-model-switch-notice="failed"] [data-error-raw-toggle]');
    expect(rawToggle).not.toBeNull();
    act(() => { rawToggle?.click(); });
    expect(container.textContent).toContain('axon-message/gemini-4-carbon');

    const retrySwitchBtn = container.querySelector<HTMLButtonElement>('[data-model-switch-notice="failed"] [data-error-action="retry"]');
    expect(retrySwitchBtn).not.toBeNull();
    act(() => { retrySwitchBtn?.click(); });
    expect(onRetrySwitch).toHaveBeenCalledWith('sw-op-1');

    const providerBtn = container.querySelector<HTMLButtonElement>('[data-turn-tail-provider-settings]');
    expect(providerBtn).not.toBeNull();
    act(() => { providerBtn?.click(); });
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);

    const detailsToggle = container.querySelector<HTMLButtonElement>('[data-mobile-step-injections-toggle]');
    expect(detailsToggle).not.toBeNull();
    act(() => { detailsToggle?.click(); });
    const items = [...container.querySelectorAll('[data-mobile-injection-item]')];
    expect(items.length).toBe(3);
    expect(items.map((el) => el.getAttribute('data-mobile-detail-kind'))).toEqual([
      'system:hook_result',
      'system:cron_job',
      'skill:web-craft',
    ]);
    expect(items[0]?.textContent).toContain('pre_tool_use');
    expect(items[1]?.textContent).toContain('nightly-audit');
    expect(items[2]?.textContent).toContain('web-craft');
  });

  it('F5: SubagentEndedRow exposes keyboard/touch expandable exact qualified model ID with Copy', () => {
    const container = mount(
      <ModelDisplayProvider catalog={[]}>
        <SubagentEndedRow
          ending={{
            kind: 'subagent-ended',
            id: 'end-1',
            turnId: 't1',
            agentId: 'agent-child-1',
            outcome: 'completed',
            taskId: 'task-1',
            note: {
              kind: 'system',
              id: 'n-end-1',
              variant: 'task',
              text: '',
              createdAt: '2026-11-25T07:00:00.000Z',
            },
            dispatchOnPage: false,
          }}
          name="audit_worker"
          model="Gemini 4 Neon"
          modelRawId="axon-message/gemini-4-neon"
          summary={undefined}
          elapsed="12s"
          renderReceipt={(text) => <span>{text}</span>}
        />
      </ModelDisplayProvider>,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-subagent-ended="agent-child-1"] button');
    expect(toggle).not.toBeNull();
    act(() => { toggle?.click(); });
    expect(container.querySelector('[data-subagent-model-raw]')?.textContent).toBe('axon-message/gemini-4-neon');
    expect(container.querySelector('[data-subagent-model-details] [data-copy-state]')).not.toBeNull();
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';

import {
  assistantMessageIdFromBlock,
  buildAgentForest,
  createViewState,
  projectAgentTranscriptView,
  sessionAgentForestFromAgentSnapshots,
  type SubagentBlock,
} from '@kiki/session-core/session';
import {
  capabilityMatrixSnapshot,
  CHILD_AGENT_ID,
  USER_MESSAGE_ID,
} from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import { I18nProvider } from '../i18n';
import {
  AgentBreadcrumb,
  AgentRelations,
  RELATED_AGENT_PREVIEW_LIMIT,
  relatedAgentNodes,
} from './AgentBreadcrumb';
import { AgentTreeView } from './AgentTreeView';
import { Transcript } from './Transcript';
import { ContextMeter } from './ContextMeter';
import { RightRail } from './RightRail';

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: ({ state }: { state: { todos: readonly { title: string }[] } }) =>
    <div data-panel-props>{state.todos.map((todo) => todo.title).join('\n')}</div>,
}));
import { PendingBadge } from './PendingBadge';
import { QueueStrip } from './QueueStrip';
import { toolErrorFullText, toolErrorSummary } from './ToolCard';
import { projectUserText } from './Transcript';
import {
  NOT_FOUND_FALLBACK_MS,
  activateSkillWithConditionalClear,
  agentDetailPath,
  agentOlderErrorText,
  agentTranscriptPoll,
  beginAgentOlderFetch,
  finishAgentOlderFetch,
  INITIAL_AGENT_OLDER_FETCH_GATE,
  isApprovalShortcutAmbiguous,
  resetAgentOlderFetchGate,
  settleAgentOlderFetch,
  isTerminalEscapeTarget,
  resolveAllApprovals,
  resolveApprovalShortcutTarget,
  resolveControlledFlag,
  resolveControlledValue,
  resolvePlanGate,
  resolveProfileSwitchSubmission,
  sessionHasStartedConversation,
  parseSessionCreateHandoff,
  replaceQueuedPrompt,
  resolveSessionCreateSubmission,
  resolveSessionSeatPhase,
  sessionAgentProfileWorkspaceId,
  SessionRouteView,
  shouldClearModeOverride,
  shouldClearPendingProfileOnSendError,
  shouldCloseSessionChromeOnEscape,
  shouldHandleApprovalShortcut,
  isTerminalShortcut,
} from './SessionView';
import { API_CODES, ApiError } from '../lib/client';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

describe('terminal shortcut', () => {
  it('recognises Ctrl+` and nothing near it', () => {
    const base = { key: '`', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(isTerminalShortcut(base)).toBe(true);
    expect(isTerminalShortcut({ ...base, shiftKey: true })).toBe(false);
    expect(isTerminalShortcut({ ...base, altKey: true })).toBe(false);
    expect(isTerminalShortcut({ ...base, metaKey: true })).toBe(false);
    expect(isTerminalShortcut({ ...base, ctrlKey: false })).toBe(false);
    expect(isTerminalShortcut({ ...base, key: '~' })).toBe(false);
  });
});

describe('QueueStrip', () => {
  const noop = () => {};
  // Copy assertions are English: pin the locale source (Node's built-in
  // navigator reports the OS language) for this describe only.
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders one row per queued prompt with drain-order numbers and actions', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[
            { promptId: 'p1', text: 'first parked prompt' },
            { promptId: 'p2', text: 'second parked prompt' },
          ]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-queue-strip');
    expect(html).toContain('2 prompts queued');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('first parked prompt');
    expect(html).toContain('second parked prompt');
    expect(html).toContain('Send now');
    expect(html).toContain('Remove');
    expect(html).toContain('Clear all');
  });

  it('disables Send now while the session is resyncing', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'parked' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
          sendNowDisabled
        />
      </I18nProvider>,
    );
    expect(html).toContain('aria-label="Send now"');
    expect(html).toMatch(/disabled="" title="Sending is paused until the session is in sync."/);
    expect(html).toContain('Sending is paused until the session is in sync.');
    expect(html).toContain('aria-label="Remove"');
    expect(html).not.toMatch(/disabled="" title="Take this prompt out of the queue"/);
  });

  it('renders nothing for an empty queue', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip items={[]} onSendNow={noop} onRemove={noop} onClearAll={noop} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });

  it('collapses a multi-prompt list behind an aria-wired count header', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[
            { promptId: 'p1', text: 'first parked prompt' },
            { promptId: 'p2', text: 'second parked prompt' },
          ]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+" aria-label="Show or hide the queued prompts"/);
    // The list stays in the tree (so reconcile keeps row identity) but hidden.
    expect(html).toMatch(/<ol id="[^"]+" hidden=""/);
  });

  it('shows a single queued prompt without a collapse toggle', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'only parked prompt' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('aria-label="Show or hide the queued prompts"');
    expect(html).not.toContain('hidden=""');
    expect(html).toContain('only parked prompt');
  });

  it('hides the Edit affordance until the parent wires onEdit', () => {
    const withoutHandler = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'parked' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(withoutHandler).not.toContain('aria-label="Edit queued prompt"');
    const withHandler = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'parked' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
          onEdit={noop}
        />
      </I18nProvider>,
    );
    expect(withHandler).toContain('aria-label="Edit queued prompt"');
  });
});

describe('queued prompt editing', () => {
  it('uses the atomic replace action with the same prompt identity', async () => {
    const replace = vi.fn(async () => undefined);
    await replaceQueuedPrompt('p1', 'replacement', replace);
    expect(replace).toHaveBeenCalledExactlyOnceWith('p1', 'replacement');
  });

  it('surfaces replace failure without falling back to abort or resend', async () => {
    const replace = vi.fn(async () => { throw new Error('replace failed'); });
    await expect(replaceQueuedPrompt('p1', 'replacement', replace)).rejects.toThrow(
      'replace failed',
    );
    expect(replace).toHaveBeenCalledOnce();
  });
});

describe('toolErrorSummary', () => {
  const baseBlock = {
    kind: 'tool' as const,
    id: 'b1',
    toolCallId: 'tc1',
    name: 'Bash',
    argsText: '',
    args: undefined,
    display: undefined,
    description: undefined,
    status: 'error' as const,
    output: undefined,
    isError: true,
    startedAt: 0,
    durationMs: undefined,
    progressText: undefined,
  };

  it('surfaces the first line of a string error output', () => {
    expect(
      toolErrorSummary({ ...baseBlock, output: 'boom: permission denied\nstack line two' }),
    ).toBe('boom: permission denied');
  });

  it('reads { message } outputs and rejects blank or missing text', () => {
    expect(toolErrorSummary({ ...baseBlock, output: { message: 'disk full' } })).toBe('disk full');
    expect(toolErrorSummary({ ...baseBlock, output: { message: '   \n  ' } })).toBeUndefined();
    expect(toolErrorSummary({ ...baseBlock, output: 42 })).toBeUndefined();
  });

  it('returns undefined for non-error statuses', () => {
    expect(toolErrorSummary({ ...baseBlock, status: 'done', output: 'fine' })).toBeUndefined();
  });
});

describe('toolErrorFullText', () => {
  const baseBlock = {
    kind: 'tool' as const,
    id: 'b1',
    toolCallId: 'tc1',
    name: 'Bash',
    argsText: '',
    args: undefined,
    display: undefined,
    description: undefined,
    status: 'error' as const,
    output: undefined,
    isError: true,
    startedAt: 0,
    durationMs: undefined,
    progressText: undefined,
  };

  it('keeps multi-line string output untruncated for tooltips', () => {
    expect(
      toolErrorFullText({ ...baseBlock, output: 'boom: permission denied\nstack line two' }),
    ).toBe('boom: permission denied\nstack line two');
  });

  it('reads the full { message } text and rejects blank or missing text', () => {
    expect(toolErrorFullText({ ...baseBlock, output: { message: 'disk full\ntrace' } })).toBe('disk full\ntrace');
    expect(toolErrorFullText({ ...baseBlock, output: { message: '   \n  ' } })).toBeUndefined();
    expect(toolErrorFullText({ ...baseBlock, output: 42 })).toBeUndefined();
    expect(toolErrorFullText({ ...baseBlock, status: 'done', output: 'fine' })).toBeUndefined();
  });
});

describe('projectUserText', () => {
  const render = (text: string) => renderToStaticMarkup(<I18nProvider>{projectUserText(text)}</I18nProvider>);

  it('chips @subagent and /skill tokens while keeping the verbatim text', () => {
    const html = render('ask @reviewer to run /lint please');
    expect(html).toContain('data-ref-chip="subagent"');
    expect(html).toContain('data-ref-chip="skill"');
    expect(html).toContain('@reviewer');
    expect(html).toContain('/lint');
    expect(html).toContain('ask ');
    expect(html).toContain(' to run ');
    expect(html).toContain(' please');
  });

  it('leaves emails, mid-word slashes, and plain prose untouched', () => {
    expect(render('mail a@b.com or path src/index.ts')).not.toContain('data-ref-chip');
    expect(render('no tokens here')).toBe('no tokens here');
  });
});

describe('SessionView route ownership', () => {
  it('changes the child owner key synchronously on session A to B navigation', () => {
    const props = { onToggleSidebar: () => {}, sessions: [] };
    const sessionA = SessionRouteView({ ...props, sessionId: 'session-a' });
    const sessionB = SessionRouteView({ ...props, sessionId: 'session-b' });

    expect(sessionA.key).toBe('session-a');
    expect(sessionB.key).toBe('session-b');
    expect(sessionB.key).not.toBe(sessionA.key);
  });
});

describe('SessionView agent profile scope', () => {
  it('derives the composer catalog scope from the current session workspace', () => {
    expect(sessionAgentProfileWorkspaceId({ workspace_id: 'wd_session' } as Session)).toBe(
      'wd_session',
    );
    expect(sessionAgentProfileWorkspaceId(undefined)).toBeUndefined();
  });
});

describe('conversation shell phase (session side)', () => {
  it('settles a cold open and flips to active once the transcript loads', () => {
    expect(resolveSessionSeatPhase({ loaded: false, hasInitialPrompt: false })).toBe('settling');
    expect(resolveSessionSeatPhase({ loaded: true, hasInitialPrompt: false })).toBe('active');
  });

  it('docks straight into active when the /new hand-off carries a first prompt', () => {
    // The session is known blank-about-to-run: no hidden-seat settle beat.
    expect(resolveSessionSeatPhase({ loaded: false, hasInitialPrompt: true })).toBe('active');
    expect(resolveSessionSeatPhase({ loaded: true, hasInitialPrompt: true })).toBe('active');
  });
});

describe('parseSessionCreateHandoff', () => {
  it('reads a skill activation from the /new navigation state', () => {
    const attachments = [{ kind: 'file' as const, path: 'note.md', name: 'note.md', isDir: false }];
    expect(
      parseSessionCreateHandoff({
        initialSkill: { name: 'review', args: '--fix', attachments },
        permissionMode: 'auto',
      }),
    ).toEqual({
      initialPrompt: undefined,
      initialAttachments: undefined,
      initialSkill: { name: 'review', args: '--fix', attachments },
      model: undefined,
      thinking: undefined,
      permissionMode: 'auto',
      planMode: undefined,
      swarmMode: undefined,
      goalObjective: undefined,
    });
  });

  it('ignores a malformed skill payload and empty location state', () => {
    expect(parseSessionCreateHandoff({ initialSkill: { name: 'review' } }).initialSkill).toBeUndefined();
    expect(parseSessionCreateHandoff(null)).toEqual({});
  });

  it('keeps a first-prompt handoff without inventing a skill', () => {
    const parsed = parseSessionCreateHandoff({
      initialPrompt: 'hello',
      initialAttachments: [],
    });
    expect(parsed.initialPrompt).toBe('hello');
    expect(parsed.initialAttachments).toEqual([]);
    expect(parsed.initialSkill).toBeUndefined();
  });

  it('resolves a skill as the single post-snapshot action with its attachments', () => {
    const attachments = [{ kind: 'file' as const, path: 'note.md', name: 'note.md', isDir: false }];
    expect(
      resolveSessionCreateSubmission({
        initialPrompt: 'must not also send',
        initialAttachments: [],
        initialSkill: { name: 'review', args: '--fix', attachments },
        goalObjective: 'ship safely',
      }),
    ).toEqual({
      kind: 'skill',
      name: 'review',
      args: '--fix',
      attachments,
      goalObjective: 'ship safely',
    });
  });

  it('resolves the legacy first prompt and defaults its attachments', () => {
    expect(resolveSessionCreateSubmission({ initialPrompt: 'hello' })).toEqual({
      kind: 'prompt',
      text: 'hello',
      attachments: [],
    });
    expect(resolveSessionCreateSubmission({})).toBeUndefined();
  });
});

describe('activateSkillWithConditionalClear', () => {
  it('applies the handoff goal before activating the skill', async () => {
    const order: string[] = [];
    const attachments: readonly [] = [];
    await activateSkillWithConditionalClear({
      prepare: async () => { order.push('goal'); },
      activate: async () => { order.push('skill'); },
      submitted: { draft: '/review', attachments },
      current: () => ({ draft: '/review', attachments }),
      clear: () => { order.push('clear'); },
    });
    expect(order).toEqual(['goal', 'skill', 'clear']);
  });

  it('preserves edits made while a delayed skill activation is pending', async () => {
    const submittedAttachments: readonly [] = [];
    let current = { draft: '/review --fix', attachments: submittedAttachments };
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => { resolveActivation = resolve; });
    const clear = vi.fn();
    const pending = activateSkillWithConditionalClear({
      activate: () => activation,
      submitted: current,
      current: () => current,
      clear,
    });

    current = { draft: 'follow-up typed while busy', attachments: submittedAttachments };
    resolveActivation();
    await pending;

    expect(clear).not.toHaveBeenCalled();
    expect(current.draft).toBe('follow-up typed while busy');
  });
});

describe('store-controlled mode pills', () => {
  it('prefers the local optimistic echo, then the store value, then the default', () => {
    expect(resolveControlledValue('yolo', 'manual', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, 'yolo', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, undefined, 'auto')).toBe('auto');
  });

  it('keeps the configured default until the snapshot lands for flag pills', () => {
    // Before load the store holds zero-value defaults — the client default wins.
    expect(resolveControlledFlag(undefined, false, false, true)).toBe(true);
    // After load the server-reported value is authoritative.
    expect(resolveControlledFlag(undefined, false, true, true)).toBe(false);
    // A local click always wins over both.
    expect(resolveControlledFlag(true, false, true, false)).toBe(true);
  });

  it('retires the optimistic echo only when the store reports the same value', () => {
    expect(shouldClearModeOverride('auto', 'auto')).toBe(true);
    expect(shouldClearModeOverride('auto', 'manual')).toBe(false);
    expect(shouldClearModeOverride('auto', undefined)).toBe(false);
    expect(shouldClearModeOverride(undefined, 'auto')).toBe(false);
  });

  it('resolves the plan gate as session pick, then global default, then free', () => {
    expect(resolvePlanGate('gated', 'free')).toBe('gated');
    expect(resolvePlanGate('free', 'gated')).toBe('free');
    expect(resolvePlanGate(undefined, 'gated')).toBe('gated');
    expect(resolvePlanGate(undefined, undefined)).toBe('free');
  });
});

describe('resolveProfileSwitchSubmission', () => {
  it('passes model/thinking through untouched when no switch is pending', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        model: 'provider/model',
        thinking: 'high',
      }),
    ).toEqual({ model: 'provider/model', thinking: 'high' });
  });

  it('treats a pending pick equal to the live binding as no switch', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'agent',
        boundProfile: 'agent',
        modelTouched: false,
        model: 'provider/model',
        thinking: undefined,
      }),
    ).toEqual({ model: 'provider/model', thinking: undefined });
  });

  it('withholds model/thinking on a switch so the new profile pins apply', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'reviewer',
        boundProfile: 'agent',
        modelTouched: false,
        model: 'provider/model',
        thinking: 'high',
      }),
    ).toEqual({ profile: 'reviewer', model: undefined, thinking: undefined });
  });

  it('lets explicit post-confirm model/effort picks override the new pins', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'reviewer',
        boundProfile: 'agent',
        modelTouched: true,
        model: 'provider/other',
        thinking: 'low',
      }),
    ).toEqual({ profile: 'reviewer', model: 'provider/other', thinking: 'low' });
  });
});

describe('shouldClearPendingProfileOnSendError', () => {
  it('keeps the pending pick (and draft) on network failure and timeout', () => {
    expect(
      shouldClearPendingProfileOnSendError(new ApiError({ code: -1, msg: 'network down', data: null })),
    ).toBe(false);
    expect(
      shouldClearPendingProfileOnSendError(
        new ApiError({ code: API_CODES.TIMEOUT, msg: 'timed out', data: null }),
      ),
    ).toBe(false);
    expect(shouldClearPendingProfileOnSendError(new Error('boom'))).toBe(false);
  });

  it('clears the pick only on a definitive server-side business rejection', () => {
    expect(
      shouldClearPendingProfileOnSendError(new ApiError({ code: 40001, msg: 'route locked', data: null })),
    ).toBe(true);
  });
});

describe('sessionHasStartedConversation', () => {
  it('treats a loaded transcript with no user messages as empty', () => {
    expect(sessionHasStartedConversation([])).toBe(false);
    expect(sessionHasStartedConversation([
      { kind: 'notice', id: 'notice-1', text: 'ready', tone: 'neutral' },
    ])).toBe(false);
  });

  it('treats any user message as a started conversation', () => {
    expect(sessionHasStartedConversation([
      { kind: 'user', id: 'user-1', text: 'hello', createdAt: '2026-08-23T00:00:00.000Z' },
    ])).toBe(true);
  });
});

describe('resolveApprovalShortcutTarget', () => {
  const card = (
    id: string,
    flags: Partial<{ pending: boolean; visible: boolean; focused: boolean }> = {},
  ) => ({
    id,
    pending: flags.pending ?? true,
    visible: flags.visible ?? true,
    focused: flags.focused ?? false,
  });

  it('uses the focused pending card even when others are visible', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: true }),
        card('a2', { visible: true, focused: true }),
      ]),
    ).toBe('a2');
  });

  it('uses the only visible pending card when nothing is focused', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: false }),
        card('a2', { visible: true }),
      ]),
    ).toBe('a2');
  });

  it('returns undefined when several pending cards are visible and none is focused', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBeUndefined();
  });

  it('does not hit a focused resolved card', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { pending: false, focused: true, visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBeUndefined();
  });
});

describe('isApprovalShortcutAmbiguous', () => {
  const card = (
    id: string,
    flags: Partial<{ pending: boolean; visible: boolean; focused: boolean }> = {},
  ) => ({
    id,
    pending: flags.pending ?? true,
    visible: flags.visible ?? true,
    focused: flags.focused ?? false,
  });

  it('flags several visible pending cards with nothing focused', () => {
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBe(true);
  });

  it('is not ambiguous once a pending card has focus', () => {
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: true, focused: true }),
      ]),
    ).toBe(false);
  });

  it('is not ambiguous for a single visible card or off-screen extras', () => {
    expect(isApprovalShortcutAmbiguous([card('a1')])).toBe(false);
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: false }),
      ]),
    ).toBe(false);
    expect(isApprovalShortcutAmbiguous([])).toBe(false);
  });
});

describe('shouldHandleApprovalShortcut', () => {
  it('gates y/n while an overlay is open', () => {
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: true, inEditable: false })).toBe(false);
    expect(shouldHandleApprovalShortcut({ key: 'n', overlayOpen: true, inEditable: false })).toBe(false);
  });

  it('allows y/n only when no overlay owns the keyboard', () => {
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: false, inEditable: false })).toBe(true);
    expect(shouldHandleApprovalShortcut({ key: 'n', overlayOpen: false, inEditable: false })).toBe(true);
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: false, inEditable: true })).toBe(false);
    expect(shouldHandleApprovalShortcut({ key: 'Escape', overlayOpen: false, inEditable: false })).toBe(false);
  });
});

describe('isTerminalEscapeTarget', () => {
  it('ignores missing or non-element targets', () => {
    expect(isTerminalEscapeTarget(null)).toBe(false);
  });
});

describe('shouldCloseSessionChromeOnEscape', () => {
  it('closes rail/terminal only when no overlay or PTY owns Escape', () => {
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(true);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: true,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: true,
      terminalFocused: false,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: true,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'y',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(false);
  });
});

describe('agent transcript poll', () => {
  it('does not poll REST transcript pages in the live GUI path', () => {
    expect(agentTranscriptPoll({ selectedAgentId: undefined })).toEqual({
      pageSize: 20,
      refetchInterval: false,
    });
    expect(agentTranscriptPoll({ selectedAgentId: 'agent-1' })).toEqual({
      pageSize: 20,
      refetchInterval: false,
    });
  });
});

describe('agent older fetch', () => {
  it('records a real error and refuses to re-enter while in flight', () => {
    expect(agentOlderErrorText(new Error('history down'))).toBe('history down');
    const started = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-1',
      hasMore: true,
      gate: INITIAL_AGENT_OLDER_FETCH_GATE,
    });
    expect(started?.request).toEqual({
      generation: 0,
      sessionId: 'sess-1',
      agentId: 'agent-1',
    });
    expect(started?.gate).toEqual({ generation: 0, inFlight: true });
    expect(
      beginAgentOlderFetch({
        selectedAgentId: 'agent-1',
        sessionId: 'sess-1',
        oldestTurnId: 'turn-1',
        hasMore: true,
        gate: started!.gate,
      }),
    ).toBeUndefined();
    expect(
      beginAgentOlderFetch({
        selectedAgentId: undefined,
        sessionId: 'sess-1',
        oldestTurnId: 'turn-1',
        hasMore: true,
        gate: INITIAL_AGENT_OLDER_FETCH_GATE,
      }),
    ).toBeUndefined();
  });

  it('lets B fetch immediately and drops a stale A settle after a switch', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      return { promise, resolve, reject };
    };

    let gate = INITIAL_AGENT_OLDER_FETCH_GATE;
    let current = { sessionId: 'sess-1', selectedAgentId: 'agent-1' as string | undefined };
    const writes: string[] = [];

    const startA = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-a',
      hasMore: true,
      gate,
    });
    expect(startA).toBeDefined();
    gate = startA!.gate;
    const heldA = deferred<string>();
    const settleA = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startA!.request,
      current: () => current,
      work: () => heldA.promise,
      onSuccess: (value) => { writes.push(`A:${value}`); },
      onError: (error) => { writes.push(`A-error:${agentOlderErrorText(error)}`); },
    });

    current = { sessionId: 'sess-1', selectedAgentId: 'agent-2' };
    gate = resetAgentOlderFetchGate(gate);
    expect(gate).toEqual({ generation: 1, inFlight: false });

    const startB = beginAgentOlderFetch({
      selectedAgentId: 'agent-2',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-b',
      hasMore: true,
      gate,
    });
    expect(startB).toBeDefined();
    gate = startB!.gate;
    const heldB = deferred<string>();
    const settleB = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startB!.request,
      current: () => current,
      work: () => heldB.promise,
      onSuccess: (value) => { writes.push(`B:${value}`); },
      onError: (error) => { writes.push(`B-error:${agentOlderErrorText(error)}`); },
    });

    heldA.resolve('older-a');
    await expect(settleA).resolves.toEqual({ committed: false });
    expect(writes).toEqual([]);
    expect(gate).toEqual({ generation: 1, inFlight: true });

    heldB.resolve('older-b');
    await expect(settleB).resolves.toEqual({ committed: true, value: 'older-b' });
    expect(writes).toEqual(['B:older-b']);
    expect(gate).toEqual({ generation: 1, inFlight: false });
  });

  it('drops a stale A failure without clearing B in flight', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      return { promise, resolve, reject };
    };

    let gate = INITIAL_AGENT_OLDER_FETCH_GATE;
    let current = { sessionId: 'sess-1', selectedAgentId: 'agent-1' as string | undefined };
    const writes: string[] = [];
    const startA = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-a',
      hasMore: true,
      gate,
    })!;
    gate = startA.gate;
    const heldA = deferred<string>();
    const settleA = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startA.request,
      current: () => current,
      work: () => heldA.promise,
      onSuccess: (value) => { writes.push(`A:${value}`); },
      onError: (error) => { writes.push(`A-error:${agentOlderErrorText(error)}`); },
    });

    current = { sessionId: 'sess-1', selectedAgentId: 'agent-2' };
    gate = resetAgentOlderFetchGate(gate);
    const startB = beginAgentOlderFetch({
      selectedAgentId: 'agent-2',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-b',
      hasMore: true,
      gate,
    })!;
    gate = startB.gate;
    const heldB = deferred<string>();
    const settleB = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startB.request,
      current: () => current,
      work: () => heldB.promise,
      onSuccess: (value) => { writes.push(`B:${value}`); },
      onError: (error) => { writes.push(`B-error:${agentOlderErrorText(error)}`); },
    });

    heldA.reject(new Error('history down'));
    await expect(settleA).resolves.toEqual({ committed: false });
    expect(writes).toEqual([]);
    expect(finishAgentOlderFetch(gate, startA.request)).toEqual(gate);
    expect(gate).toEqual({ generation: 1, inFlight: true });

    heldB.resolve('older-b');
    await expect(settleB).resolves.toEqual({ committed: true, value: 'older-b' });
    expect(writes).toEqual(['B:older-b']);
  });
});

describe('resolveAllApprovals', () => {
  it('resolves every pending id and reports failures without rejecting', async () => {
    const calls: Array<[string, string]> = [];
    const controller = {
      resolveApproval: (id: string, decision: 'approved' | 'rejected') => {
        calls.push([id, decision]);
        return id === 'a2' ? Promise.reject(new Error('expired')) : Promise.resolve();
      },
    };
    const result = await resolveAllApprovals(controller, ['a1', 'a2', 'a3'], 'approved');
    expect(calls).toEqual([
      ['a1', 'approved'],
      ['a2', 'approved'],
      ['a3', 'approved'],
    ]);
    expect(result).toEqual({ total: 3, failed: 1 });
  });

  it('reports zero failures when every decision lands', async () => {
    const controller = { resolveApproval: () => Promise.resolve() };
    await expect(resolveAllApprovals(controller, ['a1'], 'rejected')).resolves.toEqual({
      total: 1,
      failed: 0,
    });
  });
});

describe('ContextMeter', () => {
  const noop = () => {};
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function renderMeter(used: number, limit: number): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ContextMeter used={used} limit={limit} onCompact={noop} />
      </I18nProvider>,
    );
  }

  it('shows the rounded percentage without a warning below 50%', () => {
    const html = renderMeter(40_000, 100_000);
    expect(html).toContain('40%');
    expect(html).not.toContain('details</span>');
    expect(html).not.toContain('amber-card');
  });

  it('turns amber and points to details at exactly 50%', () => {
    const html = renderMeter(50_000, 100_000);
    expect(html).toContain('50%');
    expect(html).toContain('details</span>');
    expect(html).toContain('amber-card');
  });

  it('clamps the display at 100% when usage overruns the limit', () => {
    const html = renderMeter(120_000, 100_000);
    expect(html).toContain('100%');
    expect(html).toContain('details</span>');
  });
});

describe('session-not-found fallback', () => {
  it('waits three seconds before falling back home', () => {
    expect(NOT_FOUND_FALLBACK_MS).toBe(3000);
  });
});

describe('PendingBadge', () => {
  function sessionFixture(id: string, pending: Session['pending_interaction']): Session {
    return {
      id,
      workspace_id: 'wd_test',
      title: `Session ${id}`,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
      busy: false,
      pending_interaction: pending,
      archived: false,
      metadata: { cwd: 'C:/fixture' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    };
  }

  function renderBadge(sessions: readonly Session[]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <PendingBadge sessions={sessions} />
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when no session waits on the user', () => {
    expect(renderBadge([sessionFixture('s1', 'none')])).toBe('');
    expect(renderBadge([])).toBe('');
  });

  it('counts every session with a pending approval or question', () => {
    const html = renderBadge([
      sessionFixture('s1', 'approval'),
      sessionFixture('s2', 'question'),
      sessionFixture('s3', 'none'),
    ]);
    expect(html).toContain('data-pending-badge');
    expect(html).toContain('2 sessions waiting on you');
  });
});

describe('agent tree chrome', () => {
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const forest = buildAgentForest(
    [],
    [
      { agentId: 'main', name: 'Main' },
      {
        agentId: 'agent-1',
        parentAgentId: 'main',
        name: 'Child',
        model: 'provider/child-model',
        thinkingEffort: 'high',
        status: 'running',
        toolCallCount: 2,
      },
      { agentId: 'agent-2', parentAgentId: 'agent-1', name: 'Grandchild', status: 'completed', toolCallCount: 1 },
    ],
  );

  it('renders a Session > Parent > Current breadcrumb without a second Session crumb', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentBreadcrumb
          crumbs={[forest.byId['main']!, forest.byId['agent-1']!, forest.byId['agent-2']!]}
          onOpenSession={() => {}}
          onOpenAgent={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-agent-breadcrumb');
    expect(html.match(/>Session</g)).toHaveLength(1);
    expect(html).toContain('Child');
    expect(html).toContain('Grandchild');
    expect(html).not.toContain('>Main<');
  });

  it('opens a grandchild from a parent detail route via the session-absolute path', () => {
    expect(agentDetailPath('sess-1', 'agent-2')).toBe('/s/sess-1/agent/agent-2');
    const opened: string[] = [];
    const grandchild: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-2',
      subagentId: 'agent-2',
      parentAgentId: 'agent-1',
      parentToolCallId: 'call-2',
      name: 'Grandchild',
      label: 'Grandchild',
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'completed',
      summary: undefined,
      error: undefined,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      toolCallCount: 0,
      transcript: [],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/s/sess-1/agent/agent-1']}>
        <I18nProvider>
          <Transcript
            state={{ ...createViewState('sess-1'), loaded: true, blocks: [grandchild] }}
            onLoadOlder={async () => false}
            onResolveApproval={async () => {}}
            onAnswerQuestion={async () => {}}
            onDismissQuestion={async () => {}}
            forest={forest}
            onOpenAgent={(agentId) => { opened.push(agentDetailPath('sess-1', agentId)); }}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-agent-open="agent-2"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('href="/s/sess-1/agent/agent-1/agent/agent-2"');
    expect(html).not.toContain('href="agent/agent-2"');
    expect(opened).toEqual([]);
  });

  it('renders a nested tree with depth and does not flatten grandchildren', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentTreeView forest={forest} selectedAgentId="agent-1" onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('data-agent-tree');
    expect(html).toContain('data-agent-id="agent-1"');
    expect(html).toContain('data-agent-depth="1"');
    expect(html).toContain('Child');
    expect(html).toContain('Grandchild');
    expect(html).toContain('provider/child-model');
    expect(html).toContain('effort high');
    expect(html).toContain('2 tools');
  });

  it('lists settled child names in the rail tree without requiring a click', () => {
    const settled = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main', status: 'completed' },
        { agentId: 'agent-research', parentAgentId: 'main', name: 'Researcher', status: 'completed' },
        { agentId: 'agent-review', parentAgentId: 'main', name: 'Reviewer', status: 'completed' },
      ],
    );
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentTreeView forest={settled} onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('Researcher');
    expect(html).toContain('Reviewer');
    expect(html).toContain('data-agent-id="agent-research"');
    expect(html).toContain('data-agent-id="agent-review"');
  });

  it('bounds sibling and child chips to the current parent while keeping a more entry', () => {
    const crowded = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Current' },
        ...Array.from({ length: 6 }, (_, index) => ({
          agentId: `agent-${index + 2}`,
          parentAgentId: 'main',
          name: `Peer ${index + 2}`,
        })),
        ...Array.from({ length: 6 }, (_, index) => ({
          agentId: `child-${index + 1}`,
          parentAgentId: 'agent-1',
          name: `Child ${index + 1}`,
        })),
      ],
    );
    const related = relatedAgentNodes(crowded, 'agent-1');
    expect(related.siblings).toHaveLength(6);
    expect(related.siblings.every((node) => node.parentAgentId === 'main')).toBe(true);
    expect(new Set(related.siblings.map((node) => node.agentId)).size).toBe(6);
    expect(RELATED_AGENT_PREVIEW_LIMIT).toBe(4);

    // Crowded relation sets start folded to a one-line summary.
    const collapsed = renderToStaticMarkup(
      <I18nProvider>
        <AgentRelations forest={crowded} currentAgentId="agent-1" onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(collapsed).toContain('data-agent-relations');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('Related agents');
    expect(collapsed).toContain('Siblings 6');
    expect(collapsed).toContain('Children 6');
    expect(collapsed).not.toContain('Peer 5');

    // Opened (defaultOpen override, as after a click), each group still
    // previews four pills with a "+N" entry of its own.
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentRelations forest={crowded} currentAgentId="agent-1" onOpen={() => {}} defaultOpen />
      </I18nProvider>,
    );
    expect(html).toContain('Peer 5');
    expect(html).not.toContain('Peer 6');
    expect(html).toContain('Show 2 more siblings');
    expect(html).toContain('Child 4');
    expect(html).not.toContain('Child 5');
    expect(html).toContain('Show 2 more children');
  });

  it('truncates long agent names in relation pills with a tooltip', () => {
    const longNamed = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Current' },
        {
          agentId: 'agent-2',
          parentAgentId: 'main',
          name: 'A very long sibling agent name that would otherwise overflow the relations strip entirely',
        },
      ],
    );
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentRelations forest={longNamed} currentAgentId="agent-1" onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('title="A very long sibling agent name');
    expect(html).toContain('truncate');
  });

  it('keeps the RightRail subagent section in a bounded scroll region', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={createViewState('sess-1')}
            forest={forest}
            onCancelTask={() => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-subagent-scroll');
    expect(html).toContain('max-h-80');
    expect(html).toContain('overflow-y-auto');
  });

  it('differentiates the subagent rail: own task, needs-input badge, parent and sibling nav', () => {
    const railForest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', startedAt: '2026-01-01T00:00:00.000Z' },
        { agentId: 'agent-2', parentAgentId: 'main', name: 'Reviewer', startedAt: '2026-01-01T00:01:00.000Z' },
        { agentId: 'agent-3', parentAgentId: 'main', name: 'Scribe', startedAt: '2026-01-01T00:02:00.000Z' },
      ],
    );
    const subagentBlock: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-2',
      subagentId: 'agent-2',
      parentAgentId: 'main',
      parentToolCallId: 'call-2',
      name: 'Reviewer',
      description: 'Review the presentation contract',
      model: 'provider/child-model',
      thinkingEffort: undefined,
      status: 'completed',
      summary: 'Presentation contract verified.',
      error: undefined,
      usage: { inputOther: 1200, output: 300, inputCacheRead: 0, inputCacheCreation: 0 },
      startedAt: '2026-01-01T00:01:00.000Z',
      endedAt: '2026-01-01T00:01:30.000Z',
      toolCallCount: 5,
      transcript: [],
    };
    const agentState = {
      ...createViewState('sess-1'),
      todos: [{ title: 'child-only todo', status: 'in_progress' }],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={agentState}
            forest={railForest}
            selectedAgentId="agent-2"
            subagent={{
              agentId: 'agent-2',
              block: subagentBlock,
              pendingInteractionCount: 2,
              onJumpToSpawn: () => {},
            }}
            onCancelTask={() => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    // Own task chapter stays focused on status and task description.
    expect(html).toContain('Review the presentation contract');
    expect(html).not.toContain('Presentation contract verified.');
    expect(html).toContain('data-agent-status="completed"');
    expect(html).not.toContain('30.0s');
    // Needs-input badge with the pending count.
    expect(html).toContain('data-needs-input');
    expect(html).toContain('Needs input');
    // Navigation: parent jump-back plus chronological sibling steppers.
    expect(html).toContain('data-jump-to-spawn');
    expect(html).toContain('data-sibling-prev');
    expect(html).toContain('data-sibling-next');
    expect(html).toContain('Researcher');
    expect(html).toContain('Scribe');
    // The agent's own todos, not the main agent's.
    expect(html).toContain('child-only todo');
    // Differentiated: the full-tree overview section yields to the task/nav chapters.
    expect(html).not.toContain('data-subagent-scroll');
  });

  it('omits the needs-input badge when nothing is pending on the subagent', () => {
    const railForest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher' },
      ],
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={createViewState('sess-1')}
            forest={railForest}
            selectedAgentId="agent-1"
            subagent={{
              agentId: 'agent-1',
              block: undefined,
              pendingInteractionCount: 0,
              onJumpToSpawn: undefined,
            }}
            onCancelTask={() => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain('data-needs-input');
    expect(html).not.toContain('data-jump-to-spawn');
    expect(html).not.toContain('data-sibling-prev');
  });
});

describe('canonical SessionView product gates', () => {
  it('projects user identity for edit/fork and refuses assistant regenerate via last-message fallback', () => {
    const state = projectAgentTranscriptView(createViewState('sess-1'), 'main', capabilityMatrixSnapshot());
    const user = state.blocks.find((block) => block.kind === 'user');
    expect(user).toMatchObject({ userMessageId: USER_MESSAGE_ID });
    const assistant = state.blocks.find((block) => block.kind === 'assistant');
    expect(assistant?.messageId).toBe('msg-asst-canonical');
    expect(assistantMessageIdFromBlock(assistant!)).toBe('msg-asst-canonical');
  });

  it('renders subagent cards, row actions, origin-tagged child approval, and turn tail from the transcript chain', () => {
    const snapshot = capabilityMatrixSnapshot();
    const state = projectAgentTranscriptView(createViewState('sess-1'), 'main', snapshot);
    const forest = sessionAgentForestFromAgentSnapshots(new Map([['main', snapshot], [CHILD_AGENT_ID, snapshot]]));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <Transcript
            state={{ ...state, loaded: true, turnTail: { turnId: 't1', endedAt: '2026-01-01T00:00:02.000Z', durationMs: 1800, ttftMs: 120, usage: undefined, tokensPerSecond: undefined } }}
            forest={forest}
            onLoadOlder={async () => false}
            onResolveApproval={async () => {}}
            onAnswerQuestion={async () => {}}
            onDismissQuestion={async () => {}}
            rowActions={{
              disabled: false,
              onEditMessage: () => undefined,
              onRegenerate: () => undefined,
              onFork: () => undefined,
            }}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).toContain(`data-subagent-id="${CHILD_AGENT_ID}"`);
    expect(html).toContain('data-row-action="edit"');
    expect(html).toContain('data-row-action="fork"');
    expect(html).toContain('data-row-action="regenerate"');
    expect(html).toContain('data-turn-tail');
    expect(html.includes('from subagent') || html.includes('子代理')).toBe(true);
    expect(html).not.toContain('data-steer');
    expect(html).toContain('data-shell');
  });
});

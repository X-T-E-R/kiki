// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PromptItem, Session } from '@kiki/protocol';
import { submitFirstSessionMessage, readFirstSessionMessage, writeFirstSessionMessage, clearFirstSessionMessage, type FirstSessionMessageRecord } from '../lib/newSessionCreation';
import { configureSpaceStorage, spaceStorage } from '../lib/spaceStorage';
import { resolveComposerModelOverrides, type ComposerModelBindingChange, type PersistedComposerScalars } from '@kiki/session-core/composer';

import {
  assistantMessageIdFromBlock,
  buildAgentForest,
  createViewState,
  projectAgentTranscriptView,
  sessionAgentForestFromAgentSnapshots,
  type SubagentBlock,
  type Block,
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
  CHILD_CHIP_LIMIT,
  relatedAgentNodes,
} from './AgentBreadcrumb';
import { AgentTreeView } from './AgentTreeView';
import { Transcript } from './Transcript';
import { ContextMeter } from './ContextMeter';
import { RightRail } from './RightRail';
import { resolveRunningSubagentTask } from './agent-workspace';

/** JSON body a stubbed fetch was handed; these fixtures always post serialized strings. */
function sentJson(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
}

// The profile head and capability block read the agent panel over the
// connection; these fixtures have none, so they render as plain stand-ins.
vi.mock('./rail-variants/DefaultSections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rail-variants/DefaultSections')>()),
  ProfileHead: ({ label }: { label: string }) => <div data-rail-profile-head>{label}</div>,
  CapabilitiesBlock: () => null,
}));

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
  sessionAbsenceShouldLeaveRoute,
  sessionRouteOwnsSession,

  activateSkillWithConditionalClear,
  captureSkillRequest,
  completeSkillControlSelection,
  skillControlSelectionKey,
  agentDetailPath,
  agentOlderErrorText,
  agentTranscriptPoll,
  canAbortActiveTurn,
  beginAgentOlderFetch,
  finishAgentOlderFetch,
  INITIAL_AGENT_OLDER_FETCH_GATE,
  isApprovalShortcutAmbiguous,
  resetAgentOlderFetchGate,
  settleAgentOlderFetch,
  isTerminalEscapeTarget,
  resolveAllApprovals,
  resolveApprovalShortcutTarget,
  approvalShortcutRoot,
  collectApprovalShortcutCards,
  resolveControlledFlag,
  resolveControlledValue,
  resolvePlanGate,
  resolveProfileSwitchSubmission,
  resolveControlledSkillSubmission,
  executionSwitchName,
  executionPickIsPending,
  sessionHasStartedConversation,
  withOptimisticUserBlock,
  recoverFailedSubmission,
  parseSessionCreateHandoff,
  promptGoalObjective,
  replaceQueuedPrompt,
  withoutQueuedAttachment,
  removeQueuedAttachment,
  fileMentionFromPathMedia,
  resolveSessionCreateSubmission,
  resolveSessionSeatPhase,
  resolveSessionSendReady,
  sessionIdForSendReadyRead,
  initialBindingStillPending,
  sessionAgentProfileWorkspaceId,
  SessionRouteView,
  shouldClearModeOverride,
  shouldClearPendingProfileOnSendError,
  sendNowOwnTurnNotice,
  shouldCloseSessionChromeOnEscape,
  shouldHandleGlobalAbortOnEscape,
  shouldHandleApprovalShortcut,
  isTerminalShortcut,
} from './SessionView';
import { nowReceiptDecision, sendNowNotice, sendNowQueuedNotice } from './agent-workspace';
import { API_CODES, ApiError, KikiClient } from '../lib/client';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
// The 286 header test surface opens this dialog lazily; keep the test harness
// focused on session chrome without requiring a live connection context.
vi.mock('./persona/PersonaSettingsUpdate', () => ({
  PersonaSettingsDialog: () => null,
  PersonaSettingsUpdate: () => null,
}));

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
    expect(html).toContain('In send order');
    // Drain order reads as plain numbers (no # prefix).
    expect(html).toMatch(/>1<\/span>/);
    expect(html).toMatch(/>2<\/span>/);
    expect(html).toContain('first parked prompt');
    expect(html).toContain('second parked prompt');
    expect(html).toContain('Send now');
    expect(html).toContain('Remove');
    // The strip is the queue drawer body: its header carries Clear all.
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

  it('renders the full list open (the drawer is the disclosure) under the queue region label', () => {
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
    expect(html).toContain('aria-label="Queued prompts"');
    expect(html).not.toContain('hidden=""');
    expect(html).not.toContain('Show or hide the queued prompts');
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

  it('renders drag handles only when onMove is wired and more than one prompt is parked', () => {
    const bare = renderToStaticMarkup(
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
    expect(bare).not.toContain('aria-label="Reorder this queued prompt"');
    const single = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'only parked prompt' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
          onMove={noop}
        />
      </I18nProvider>,
    );
    expect(single).not.toContain('aria-label="Reorder this queued prompt"');
    const pair = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[
            { promptId: 'p1', text: 'first parked prompt' },
            { promptId: 'p2', text: 'second parked prompt' },
          ]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
          onMove={noop}
        />
      </I18nProvider>,
    );
    expect(pair.match(/aria-label="Reorder this queued prompt"/g)).toHaveLength(2);
  });

  it('marks the row parked in the composer and explains the edit hold', () => {
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
          onEdit={noop}
          editingPromptId="p2"
        />
      </I18nProvider>,
    );
    expect(html).toContain('Editing · starts after this turn');
    expect(html).toContain('data-queue-hold-notice');
    expect(html).toContain('the 1 ahead still send');
    expect(html).not.toContain('hidden=""');
  });
});

describe('queued prompt editing', () => {
  it.each([true, false])('keeps queued quote, thread and room spans aligned with a file mention (%s)', async (withMention) => {
    const { buildPromptContent } = await import('@kiki/session-core/composer');
    const { contentTextPresentation, projectPresentedText } = await import('@kiki/transcript');
    const quote = 'quoted passage\n\n';
    const thread = '<thread_refs>thread context</thread_refs>\n\n';
    const room = '<room_ref>room context</room_ref>\n\n';
    const text = `${quote}${thread}${room}visible body`;
    const spans = [
      { start: 0, end: quote.length, kind: 'selection' as const, quote: 'quoted passage' },
      { start: quote.length, end: quote.length + thread.length, kind: 'context' as const },
      { start: quote.length + thread.length, end: quote.length + thread.length + room.length, kind: 'context' as const },
    ];
    const attachments = withMention ? [{ kind: 'file' as const, path: 'src/example.ts', name: 'example.ts', isDir: false }] : [];
    const content = buildPromptContent(text, attachments, { spans })!;
    const finalText = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
    const mapped = contentTextPresentation(content, '\n\n');
    const offset = withMention ? '@src/example.ts\n\n'.length : 0;
    expect(mapped?.spans).toEqual(spans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset })));
    expect(finalText).toBe(`${withMention ? '@src/example.ts\n\n' : ''}${text}`);
    expect(projectPresentedText(finalText, mapped)).toBe(`${withMention ? '@src/example.ts\n\n' : ''}visible body`);
    expect(contentTextPresentation(buildPromptContent('plain body', attachments, { spans: [] })!, '\n\n')).toBeUndefined();
  });

  it('uses the atomic replace action with the same prompt identity', async () => {
    const replace = vi.fn(async () => undefined);
    await replaceQueuedPrompt('p1', 'replacement', replace);
    expect(replace).toHaveBeenCalledExactlyOnceWith('p1', 'replacement');
  });

  it('removes only the selected attachment from the exact queued message parts', () => {
    const first = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/first.png' } };
    const second = { type: 'file' as const, file_id: 'file_2', name: 'notes.txt', media_type: 'text/plain', size: 12 };
    const content = [{ type: 'text' as const, text: 'review' }, first, second];
    expect(withoutQueuedAttachment(content, 0)).toEqual([second]);
    expect(withoutQueuedAttachment(content, 1)).toEqual([first]);
    expect(withoutQueuedAttachment([first], 0)).toEqual([]);
  });

  it('removes structured and presentation attachments in media order while preserving text metadata', () => {
    const first = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/first.png' } };
    const second = { type: 'file' as const, file_id: 'file_2', name: 'notes.txt', media_type: 'text/plain', size: 12 };
    const notice = 'Attached file "report.pdf": C:/session/report.pdf';
    const attachment = { path: 'C:/session/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 42 };
    const content = [
      { type: 'text' as const, text: 'keep', presentation: { spans: [{ start: 0, end: 4, kind: 'context' as const }] } },
      first,
      { type: 'text' as const, text: notice, presentation: { spans: [{ start: 0, end: notice.length, kind: 'attachment' as const, attachment }] } },
      second,
      { type: 'text' as const, text: 'after', presentation: { spans: [{ start: 0, end: 5, kind: 'context' as const }] } },
    ];
    expect(removeQueuedAttachment(content, 0)).toEqual({
      text: `keep\n\n${notice}\n\nafter`,
      media: [second],
      presentation: {
        spans: [
          { start: 0, end: 4, kind: 'context' },
          { start: 'keep'.length + 2, end: 'keep'.length + 2 + notice.length, kind: 'attachment', attachment },
          { start: 'keep'.length + notice.length + 4, end: 'keep'.length + notice.length + 9, kind: 'context' },
        ],
      },
    });
    expect(removeQueuedAttachment(content, 2)).toEqual({
      text: 'keep\n\nafter',
      media: [first, second],
      presentation: { spans: [{ start: 0, end: 4, kind: 'context' }, { start: 6, end: 11, kind: 'context' }] },
    });
  });

  it('does not remove literal text when a selected media entry has no presentation span', () => {
    const file = { type: 'file' as const, file_id: 'file-1', name: 'literal.txt', media_type: 'text/plain', size: 1 };
    const content = [{ type: 'text' as const, text: 'literal mention' }, file];
    expect(removeQueuedAttachment(content, 0)).toEqual({ text: 'literal mention', media: [], presentation: undefined });
  });

  it('removes only the marked notice range from text that also contains user prose', () => {
    const notice = 'Attached file report.pdf';
    const text = `keep ${notice} this literal text`;
    const content = [{
      type: 'text' as const,
      text,
      presentation: { spans: [{ start: 5, end: 5 + notice.length, kind: 'attachment' as const, attachment: { path: 'C:/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 1 } }] },
    }];
    expect(removeQueuedAttachment(content, 0)).toEqual({ text: 'keep  this literal text', media: [], presentation: undefined });
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

  it('chips @subagent tokens but leaves slash-looking prose unchipped', () => {
    const html = render('ask @reviewer to run /lint please');
    expect(html).toContain('data-ref-chip="subagent"');
    expect(html).not.toContain('data-ref-chip="skill"');
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

describe('session send readiness', () => {
  const shellReady = {
    controllerAvailable: true,
    leaseReady: true,
    loaded: true,
    loadError: undefined,
    resyncing: false,
    resyncFailed: false,
  };

  it('allows durable send as soon as a controller exists, before transcript seed or WS readiness', () => {
    expect(resolveSessionSendReady(shellReady)).toBe(true);
    expect(resolveSessionSendReady({ ...shellReady, leaseReady: false, loaded: false, resyncing: true })).toBe(true);
    expect(resolveSessionSendReady({ ...shellReady, controllerAvailable: false })).toBe(false);
  });

  it('keeps send available when history loading failed, while still requiring a controller', () => {
    expect(resolveSessionSendReady({ ...shellReady, loadError: 'snapshot failed' })).toBe(true);
    expect(resolveSessionSendReady({ ...shellReady, resyncing: true })).toBe(true);
    expect(resolveSessionSendReady({ ...shellReady, resyncFailed: true })).toBe(true);
    expect(resolveSessionSendReady({ ...shellReady, controllerAvailable: false, loadError: 'snapshot failed' })).toBe(false);
  });

  it('does not start session-operation reads before the snapshot lease is settled', () => {
    expect(sessionIdForSendReadyRead('session-a', false)).toBeUndefined();
    expect(sessionIdForSendReadyRead('session-a', true)).toBe('session-a');
  });

  it('keeps an explicit new-session model through a stale binding snapshot, but honors clear or a newer pick', () => {
    const base = { expectedModel: 'picked/model', modelOverride: 'picked/model', boundModel: 'default/model' };
    expect(initialBindingStillPending(base)).toBe(true);
    expect(initialBindingStillPending({ ...base, boundModel: 'picked/model' })).toBe(false);
    expect(initialBindingStillPending({ ...base, modelOverride: undefined })).toBe(false);
    expect(initialBindingStillPending({ ...base, modelOverride: 'newer/model' })).toBe(false);
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
      goalObjective: undefined,
      ephemeral: undefined,
    });
  });

  it('carries the persona greeting-reply bit to the first prompt only when set', () => {
    const handoff = parseSessionCreateHandoff({ initialPrompt: 'hi', personaGreetingReply: true });
    expect(handoff.personaGreetingReply).toBe(true);
    expect(resolveSessionCreateSubmission(handoff)).toMatchObject({ kind: 'prompt', text: 'hi', personaGreetingReply: true });
    expect(parseSessionCreateHandoff({ initialPrompt: 'hi', personaGreetingReply: 'yes' }).personaGreetingReply).toBeUndefined();
    expect(parseSessionCreateHandoff({ initialPrompt: 'hi', ephemeral: true }).ephemeral).toBe(true);
    expect(parseSessionCreateHandoff({ initialPrompt: 'hi', ephemeral: false }).ephemeral).toBe(false);
    expect(resolveSessionCreateSubmission({ initialPrompt: 'hi' })).not.toHaveProperty('personaGreetingReply');
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

  it('validates presentation metadata before carrying a first prompt across navigation', () => {
    const presentation = { spans: [{ start: 0, end: 5, kind: 'selection' as const, quote: 'hello' }] };
    expect(parseSessionCreateHandoff({ initialPrompt: 'hello', initialPresentation: presentation }).initialPresentation).toEqual(presentation);
    expect(parseSessionCreateHandoff({ initialPrompt: 'hello', initialPresentation: { spans: [{ start: -1, end: 5, kind: 'selection' }] } }).initialPresentation).toBeUndefined();
    expect(resolveSessionCreateSubmission({ initialPrompt: 'hello', initialPresentation: presentation })).toMatchObject({
      kind: 'prompt', text: 'hello', presentation,
    });
  });

  it('resolves a skill as the single post-snapshot action with its attachments', () => {
    const attachments = [{ kind: 'file' as const, path: 'note.md', name: 'note.md', isDir: false }];
    expect(
      resolveSessionCreateSubmission({
        initialPrompt: 'must not also send',
        initialAttachments: [],
        initialSkill: { name: 'review', args: '--fix', attachments, userInput: '/skill:review --fix\nKeep this line.' },
        goalObjective: 'ship safely',
      }),
    ).toEqual({
      kind: 'skill',
      name: 'review',
      args: '--fix',
      attachments,
      userInput: '/skill:review --fix\nKeep this line.',
      goalObjective: 'ship safely',
    });
  });

  it('resolves the legacy first prompt and preserves an explicit goal binding', () => {
    expect(resolveSessionCreateSubmission({ initialPrompt: 'hello' })).toEqual({
      kind: 'prompt',
      text: 'hello',
      attachments: [],
      goalObjective: undefined,
    });
    expect(resolveSessionCreateSubmission({
      initialPrompt: 'ship safely',
      goalObjective: 'ship safely',
    })).toEqual({
      kind: 'prompt',
      text: 'ship safely',
      attachments: [],
      goalObjective: 'ship safely',
    });
    expect(resolveSessionCreateSubmission({})).toBeUndefined();
  });
});

describe('fileMentionFromPathMedia', () => {
  it('maps durable path-only file media to a file mention', () => {
    expect(fileMentionFromPathMedia({ kind: 'file', path: 'C:/session/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 42 })).toEqual({
      kind: 'file', path: 'C:/session/report.pdf', name: 'report.pdf', isDir: false,
    });
  });

  it('does not reinterpret uploaded or deferred file media as a mention', () => {
    expect(fileMentionFromPathMedia({ kind: 'file', path: 'report.pdf', fileId: 'file-1' })).toBeUndefined();
    expect(fileMentionFromPathMedia({ kind: 'file', path: 'report.pdf', detail: { agentId: 'main', attachmentId: 'a1' } })).toBeUndefined();
    expect(fileMentionFromPathMedia({ kind: 'image', path: 'report.png' })).toBeUndefined();
  });
});

describe('promptGoalObjective', () => {
  it('binds a goal only for the explicitly goal-armed submission', () => {
    expect(promptGoalObjective()).toBeUndefined();
    expect(promptGoalObjective({})).toBeUndefined();
    expect(promptGoalObjective({ goalObjective: 'ship safely' })).toBe('ship safely');
  });
});

describe('resolveControlledSkillSubmission', () => {
  const input = { name: 'kiki-ops', args: 'Help me start.', userInput: '/kiki-ops Help me start.', attachments: [], pendingProfile: undefined, boundProfile: 'agent', boundExecution: { executor: 'native', profile: 'agent', overrides: undefined }, modelTouched: false, effortTouched: false, model: 'example/model', thinking: 'high', permissionTouched: false };
  it('keeps the existing skill REST route when no control was chosen', () => {
    expect(resolveControlledSkillSubmission(input)).toBeUndefined();
  });
  it('carries the chosen model and effort with the exact welcome presentation and attachments', () => {
    const request = resolveControlledSkillSubmission({ ...input, modelTouched: true, effortTouched: true, attachments: [{ kind: 'file', path: 'note.md', name: 'note.md', isDir: false }] });
    expect(request).toMatchObject({ model: 'example/model', thinking: 'high', skills: [{ name: 'kiki-ops', args: 'Help me start.' }] });
    expect(request?.content[0]).toEqual({ type: 'text', text: '@note.md\n\n/kiki-ops Help me start.' });
    expect(JSON.stringify(request?.content)).toContain('note.md');
  });
  it('carries a pending bare execution without leaking native model or effort', () => {
    const request = resolveControlledSkillSubmission({ ...input, pendingExecution: { executor: 'claude-acp', profile: undefined, overrides: undefined } });
    expect(request?.execution).toEqual({ executor: 'claude-acp' });
    expect(request?.model).toBeUndefined();
    expect(request?.thinking).toBeUndefined();
  });
  it.each(['direct', 'compact', 'fresh'] as const)('freezes confirmed %s mode on the actual skill prompt, not a separate control', (modelSwitchMode) => {
    const request = captureSkillRequest(resolveControlledSkillSubmission({ ...input, modelTouched: true, modelSwitchMode })!);
    expect(request).toMatchObject({ model: input.model, model_switch_mode: modelSwitchMode, skills: [{ name: input.name }] });
    const selection = { modelOverride: input.model, modelSwitchMode };
    const captured = skillControlSelectionKey(selection);
    expect(skillControlSelectionKey({ ...selection, modelSwitchMode: modelSwitchMode === 'fresh' ? 'direct' : 'fresh' })).not.toBe(captured);
    const clear = vi.fn();
    completeSkillControlSelection({ controlled: request, capturedSelection: captured, currentSelection: captured, clear, refresh: vi.fn() });
    expect(clear).toHaveBeenCalledOnce();
    expect(request.model_switch_mode).toBe(modelSwitchMode);
  });
  it('does not attach a native mode to profile/engine replacement or effort-only controls', () => {
    for (const selection of [{ pendingProfile: 'review-profile', modelTouched: true },
      { pendingExecution: { executor: 'claude-acp', profile: undefined, overrides: undefined }, modelTouched: true }, { effortTouched: true }]) {
      const request = resolveControlledSkillSubmission({ ...input, ...selection, modelSwitchMode: 'compact' });
      expect(request?.model_switch_mode).toBeUndefined();
    }
  });
});

describe('activateSkillWithConditionalClear', () => {
  it.each(['model', 'effort'] as const)('retains a newer %s pick through accepted skill binding refresh and the real resolver', async (control) => {
    const binding = { model: 'example/old', thinking: 'low' };
    let selection: PersistedComposerScalars = { modelOverride: control === 'model' ? 'example/A' : undefined,
      effortOverride: control === 'effort' ? 'high' : undefined,
      modelChoice: control === 'model' ? binding : undefined,
      effortChoice: control === 'effort' ? binding : undefined };
    const capturedSelection = skillControlSelectionKey(selection);
    const controlled = { content: [{ type: 'text' as const, text: '/review' }],
      model: selection.modelOverride, thinking: selection.effortOverride };
    let acceptedBindingChange: ComposerModelBindingChange | undefined;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const clear = vi.fn();
    const composition = { draft: '/review', attachments: [] };
    const acceptedBinding = { model: controlled.model ?? binding.model, thinking: controlled.thinking ?? binding.thinking };
    const refresh = vi.fn(() => {
      selection = resolveComposerModelOverrides({ ...selection, conversationStarted: true, pendingBinding: false,
        binding: acceptedBinding, acceptedBindingChange });
    });
    const pending = activateSkillWithConditionalClear({ activate: async () => {
      await held;
      completeSkillControlSelection({ controlled, binding, capturedSelection,
        currentSelection: skillControlSelectionKey(selection), clear, refresh,
        preserveBindingChange: (change) => { acceptedBindingChange = change; },
      });
    }, submitted: composition, current: () => composition, clear: vi.fn() });
    selection = { ...selection, modelOverride: control === 'model' ? 'example/B' : undefined,
      effortOverride: control === 'effort' ? 'max' : undefined };
    finish();
    await pending;
    expect(clear).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(control === 'model' ? selection.modelOverride : selection.effortOverride)
      .toBe(control === 'model' ? 'example/B' : 'max');
    expect(control === 'model' ? selection.modelChoice : selection.effortChoice).toEqual(acceptedBinding);
    expect(resolveComposerModelOverrides({ ...selection, conversationStarted: true, pendingBinding: false,
      binding: { model: 'example/foreign', thinking: 'low' }, acceptedBindingChange }))
      .toMatchObject({ modelOverride: undefined, effortOverride: undefined });
  });

  it.each(['model', 'effort'] as const)('preserves a newer %s pick when an older controlled skill succeeds', async (control) => {
    const boundChoice = { model: 'bound-model', thinking: 'low' };
    let selection = { pendingProfile: 'review-profile', pendingExecution: undefined,
      modelOverride: 'model-A', effortOverride: 'high', modelChoice: boundChoice, effortChoice: boundChoice };
    const capturedSelection = skillControlSelectionKey(selection);
    const controlled = { prompt_id: 'old-skill', content: [{ type: 'text' as const, text: '/review' }],
      profile: 'review-profile', model: 'model-A', thinking: 'high' };
    const clear = vi.fn();
    const refresh = vi.fn();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const activate = vi.fn().mockReturnValueOnce(held).mockResolvedValue(undefined);
    const composition = { draft: '/review', attachments: [] };
    const run = () => activateSkillWithConditionalClear({
      activate: async () => {
        await activate(controlled);
        completeSkillControlSelection({ controlled, capturedSelection,
          currentSelection: skillControlSelectionKey(selection), clear, refresh });
      },
      submitted: composition, current: () => composition, clear: vi.fn(),
    });
    const pending = run();
    if (control === 'effort') {
      const failed = expect(pending).rejects.toThrow('unknown response');
      reject(new TypeError('unknown response'));
      await failed;
      selection = { ...selection, effortOverride: 'max' };
      await run();
    } else {
      selection = { ...selection, modelOverride: 'model-B' };
      resolve();
      await pending;
    }
    expect(selection.modelChoice).toEqual(boundChoice);
    expect(selection.effortChoice).toEqual(boundChoice);
    expect(clear).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(activate.mock.calls.at(-1)?.[0]).toBe(controlled);
  });

  it.each(['model', 'effort'] as const)('consumes a matching %s-only skill selection and refreshes after acceptance', async (control) => {
    const boundChoice = { model: 'bound-model', thinking: 'low' };
    const selection = { pendingProfile: undefined, pendingExecution: undefined,
      modelOverride: control === 'model' ? 'model-A' : undefined,
      effortOverride: control === 'effort' ? 'high' : undefined,
      modelChoice: control === 'model' ? boundChoice : undefined,
      effortChoice: control === 'effort' ? boundChoice : undefined };
    const controlled = resolveControlledSkillSubmission({ name: 'review', args: '', userInput: '/review', attachments: [],
      pendingProfile: undefined, boundProfile: 'default', model: selection.modelOverride, thinking: selection.effortOverride,
      modelTouched: control === 'model', effortTouched: control === 'effort' })!;
    expect(controlled.profile).toBeUndefined();
    expect(controlled.execution).toBeUndefined();
    const clear = vi.fn(() => {
      selection.modelOverride = undefined;
      selection.effortOverride = undefined;
      selection.modelChoice = undefined;
      selection.effortChoice = undefined;
    });
    const refresh = vi.fn();
    const capturedSelection = skillControlSelectionKey(selection);
    const composition = { draft: '/review', attachments: [] };
    await activateSkillWithConditionalClear({ activate: async () => {
      completeSkillControlSelection({ controlled, capturedSelection,
        currentSelection: skillControlSelectionKey(selection), clear, refresh });
    }, submitted: composition, current: () => composition, clear: vi.fn() });
    expect(clear).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(selection).toMatchObject({ modelOverride: undefined, effortOverride: undefined,
      modelChoice: undefined, effortChoice: undefined });
  });

  it('captures one controlled skill identity across an accepted unknown response and manual retry', async () => {
    const attachments = [{ kind: 'file' as const, path: 'note.md', name: 'note.md', isDir: false }];
    const selection = { name: 'review', args: '--fix', userInput: '/review --fix\nOriginal task.', attachments,
      pendingProfile: 'review-profile', boundProfile: 'default',
      pendingExecution: { executor: 'native', profile: undefined, overrides: undefined }, boundExecution: undefined,
      modelTouched: true, effortTouched: true, model: 'selected-model', thinking: 'high',
      permissionTouched: true, permissionMode: 'manual' as const };
    const captured = captureSkillRequest(resolveControlledSkillSubmission(selection)!);
    const submitted = { draft: selection.userInput, attachments };
    let current = submitted;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requests: unknown[] = [];
    const accepted = new Set<string>();
    let executions = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = sentJson(init) as { procedure?: { method?: string }; prompt_id?: string; content?: unknown };
      if (body.procedure?.method === 'resume') {
        return Response.json({ code: 0, msg: 'ok', data: { id: 'session_test', kind: 'session' } });
      }
      requests.push(body);
      const id = body.prompt_id ?? `unkeyed-${requests.length}`;
      if (!accepted.has(id)) { accepted.add(id); executions++; }
      if (requests.length === 1) { await held; throw new TypeError('accepted response unavailable'); }
      return Response.json({ code: 0, msg: 'ok', data: { prompt_id: id, user_message_id: id,
        status: 'running', content: body.content, created_at: '2026-01-01T00:00:00Z' } });
    }));
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    const clear = vi.fn();
    const run = () => activateSkillWithConditionalClear({ activate: () => client.submitPrompt('session_test', captured),
      submitted, current: () => current, clear });
    try {
      const first = run();
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      current = { draft: 'new task while waiting', attachments: [] };
      selection.model = 'new-model';
      selection.thinking = 'low';
      const rejected = expect(first).rejects.toThrow('accepted response unavailable');
      release();
      await rejected;
      await run();
      expect(captured.prompt_id).toEqual(expect.any(String));
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]).toMatchObject({ skills: [{ name: 'review', args: '--fix' }],
        profile: 'review-profile', model: 'selected-model', thinking: 'high', permission_mode: 'manual' });
      expect(executions).toBe(1);
      expect(clear).not.toHaveBeenCalled();
      expect(current.draft).toBe('new task while waiting');
      const next = captureSkillRequest(resolveControlledSkillSubmission(selection)!);
      expect(next.prompt_id).not.toBe(captured.prompt_id);
      expect(next.model).toBe('new-model');
    } finally { await client.klient.close(); vi.unstubAllGlobals(); }
  });

  it('retains a legacy skill request body and identity for a manual response-loss retry', async () => {
    const body = captureSkillRequest({ args: '--fix', user_input: '/review --fix',
      attachments: [{ type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/legacy.png' } }] });
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push(sentJson(init));
      if (requests.length === 1) throw new TypeError('activation response unavailable');
      return Response.json({ code: 0, msg: 'ok', data: { activated: true, skill_name: 'review' } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    const submitted = { draft: body.user_input, attachments: [] };
    let current = submitted;
    const clear = vi.fn();
    const run = () => activateSkillWithConditionalClear({ activate: () => client.activateSkill('session_test', 'review', body),
      submitted, current: () => current, clear });
    try {
      await expect(run()).rejects.toThrow('activation response unavailable');
      current = { draft: 'new task', attachments: [] };
      await run();
      expect(requests).toEqual([body, body]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(clear).not.toHaveBeenCalled();
    } finally { await client.klient.close(); vi.unstubAllGlobals(); }
  });

  it('retains the full submission on failure for a retry', async () => {
    const attachments = [{ kind: 'file' as const, path: 'note.md', name: 'note.md', isDir: false }];
    const submitted = { draft: '/review --fix\nKeep this line.', attachments };
    const clear = vi.fn();
    await expect(activateSkillWithConditionalClear({
      activate: async () => { throw new Error('activation rejected'); },
      submitted, current: () => submitted, clear,
    })).rejects.toThrow('activation rejected');
    expect(clear).not.toHaveBeenCalled();
  });

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
  it('inherits displayed model/thinking when no control was chosen', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: 'high',
      }),
    ).toEqual({ model: undefined, thinking: undefined });
  });

  it('treats a pending pick equal to the live binding as no switch', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'agent',
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: undefined,
      }),
    ).toEqual({ model: undefined, thinking: undefined });
  });

  it('withholds model/thinking on a switch so the new profile pins apply', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'reviewer',
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
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
        effortTouched: true,
        model: 'provider/other',
        thinking: 'low',
      }),
    ).toEqual({ profile: 'reviewer', model: 'provider/other', thinking: 'low' });
  });

  it('withholds the approval mode of a bare engine the user never chose', () => {
    // The real defect: `permission_mode` is a session override on the
    // execution path, so sending the session's current mode decided approvals
    // for a harness that was explicitly chosen as-is.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: undefined,
        thinking: undefined,
        permissionMode: 'manual',
        pendingExecution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ execution: { executor: 'claude-acp' }, model: undefined, thinking: undefined, permissionMode: undefined });
  });

  it('sends an approval mode the user picked on a bare engine', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: undefined,
        thinking: undefined,
        permissionTouched: true,
        permissionMode: 'yolo',
        pendingExecution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ execution: { executor: 'claude-acp' }, model: undefined, thinking: undefined, permissionMode: 'yolo' });
  });

  it('leaves the approval mode alone when the execution names it', () => {
    // The execution already states the value; a second statement would either
    // conflict or silently turn `null` ("fall through") back into a default.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'vendor-model',
        thinking: 'high',
        permissionMode: 'manual',
        pendingExecution: {
          executor: 'example-acp',
          profile: undefined,
          overrides: { model: 'vendor-model', thinking: 'high' },
        },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({
      execution: { executor: 'example-acp', overrides: { model: 'vendor-model', thinking: 'high' } },
      model: undefined,
      thinking: undefined,
      permissionMode: undefined,
    });
  });

  it('keeps the approval mode on an external engine that has a profile', () => {
    // A profile is what supplies the mode, so the session's value still goes.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: undefined,
        thinking: undefined,
        permissionMode: 'auto',
        pendingExecution: { executor: 'claude-acp', profile: 'reviewer', overrides: undefined },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ execution: { executor: 'claude-acp', profile: 'reviewer' }, model: undefined, thinking: undefined, permissionMode: 'auto' });
  });

  it('carries a bare external engine with no profile, so the harness runs as it is', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: 'high',
        pendingExecution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ execution: { executor: 'claude-acp' }, model: undefined, thinking: undefined });
  });

  it('sends no execution selection when the pending pick matches the live binding', () => {
    const bound = { executor: 'native', profile: 'agent', overrides: undefined };
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: undefined,
        pendingExecution: { ...bound },
        boundExecution: { ...bound },
      }),
    ).toEqual({ model: undefined, thinking: undefined });
  });

  it('keeps the user model when they re-picked it after confirming an engine switch', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: true,
        model: 'provider/other',
        thinking: 'low',
        pendingExecution: { executor: 'codex-app-server', profile: 'reviewer', overrides: undefined },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ execution: { executor: 'codex-app-server', profile: 'reviewer' }, model: 'provider/other', thinking: 'low' });
  });

  it('keeps session overrides the user set, and does not invent absent ones', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: undefined,
        thinking: undefined,
        pendingExecution: {
          executor: 'claude-acp',
          profile: undefined,
          overrides: { kiki_context: [], allow_kiki_subagents: false },
        },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({
      execution: { executor: 'claude-acp', overrides: { kiki_context: [], allow_kiki_subagents: false } },
      model: undefined,
      thinking: undefined,
    });
  });

  it('sends no model or effort on a plain message of a bare session the user never touched', () => {
    // The display sentinel leak: nothing is being switched, so the composer's
    // "off" effort has no incoming generation to absorb it. It is a displayed
    // default, not a choice, and on the execution path it becomes a session
    // override that the harness then inherits.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'fixture/kiki-pro',
        thinking: 'off',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'example-acp', profile: undefined, overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: undefined, permissionMode: undefined });
  });

  it('does not promote a native binding into message overrides', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: 'high',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: undefined, permissionMode: 'manual' });
  });

  it('sends a model or effort the user picked on a plain message of a bare session', () => {
    // The withheld half is not a blanket "send nothing": an explicit pick on a
    // bare engine is exactly the customisation the bare binding still allows.
    // Touching model/effort says nothing about approvals, so the approval mode
    // stays behind until the user moves that control too.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: true,
        model: 'provider/other',
        thinking: 'low',
        permissionTouched: true,
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'example-acp', profile: undefined, overrides: undefined },
      }),
    ).toEqual({ model: 'provider/other', thinking: 'low', permissionMode: 'manual' });
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: true,
        model: 'provider/other',
        thinking: 'low',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'example-acp', profile: undefined, overrides: undefined },
      }),
    ).toEqual({ model: 'provider/other', thinking: 'low', permissionMode: undefined });
  });

  it('withholds only the control the execution names, on a plain message of a bare session', () => {
    // `model` is stated, `thinking` is not: the effort display value is still
    // only a display value, so it stays behind.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'vendor-model',
        thinking: 'off',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: {
          executor: 'example-acp',
          profile: undefined,
          overrides: { model: 'vendor-model' },
        },
      }),
    ).toEqual({ model: undefined, thinking: undefined, permissionMode: undefined });
  });

  it('sends a new effort on an external binding that already names thinking, without an execution or model', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'vendor/sonnet',
        thinking: 'high',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: {
          executor: 'example-acp',
          profile: undefined,
          overrides: { model: 'vendor-model', thinking: 'medium' },
        },
      }),
    ).toEqual({ model: undefined, thinking: 'high', permissionMode: undefined });
  });

  it('sends a native effort pick as thinking and keeps the existing permission rule', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'fixture/live-model',
        thinking: 'high',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: 'high', permissionMode: 'manual' });
  });

  it('sends null when Default clears a native effort, without an execution selection', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'fixture/live-model',
        thinking: '',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: null, permissionMode: 'manual' });
  });

  it('sends null when Default clears a native execution thinking override, without a new execution', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'fixture/live-model',
        thinking: '',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: {
          executor: 'native',
          profile: 'agent',
          overrides: { model: 'fixture/live-model', thinking: 'high' },
        },
      }),
    ).toEqual({ model: undefined, thinking: null, permissionMode: 'manual' });
  });

  it('sends null when Default clears an external thinking override, and omits thinking when effort was not touched', () => {
    const boundExecution = {
      executor: 'example-acp',
      profile: undefined,
      overrides: { model: 'vendor/sonnet', thinking: 'medium' as const },
    };
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'vendor/sonnet',
        thinking: '',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution,
      }),
    ).toEqual({ model: undefined, thinking: null, permissionMode: undefined });
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'vendor/sonnet',
        thinking: '',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution,
      }),
    ).toEqual({ model: undefined, thinking: undefined, permissionMode: undefined });
  });

  it('sends the effort alone when only the effort was moved, and not the displayed model', () => {
    // One shared flag made an effort pick promote the model id the user never
    // chose. On a bare engine that model is a session override the harness then
    // inherits, so this is the single-control case, not the "both explicit" one.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: true,
        model: 'provider/model',
        thinking: 'low',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'example-acp', profile: undefined, overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: 'low', permissionMode: undefined });
  });

  it('sends the model alone when only the model was moved, and not the displayed effort', () => {
    // The mirror image. `thinking: 'off'` is what the catalog reports when
    // nothing was chosen, so carrying it alongside the model states an effort
    // override the user never made.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: false,
        model: 'provider/other',
        thinking: 'off',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'example-acp', profile: undefined, overrides: undefined },
      }),
    ).toEqual({ model: 'provider/other', thinking: undefined, permissionMode: undefined });
  });

  it('sends only the chosen model on a native session', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: false,
        model: 'provider/other',
        thinking: 'high',
        permissionMode: 'manual',
        pendingExecution: undefined,
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({ model: 'provider/other', thinking: undefined, permissionMode: 'manual' });
  });

  it('does not let a stale touched flag re-send a control the incoming execution owns', () => {
    // The switch branch used `modelTouched` directly, bypassing the ownership
    // test. A user who moved the model earlier and then switched to an engine
    // that states its own model would have both fields sent, and the legacy one
    // would overwrite the selection's value. Ownership is per key, so the
    // approval mode — which this selection does NOT name — still rides.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: true,
        model: 'stale-picked-model',
        thinking: 'stale-picked-effort',
        permissionMode: 'manual',
        permissionTouched: true,
        pendingExecution: {
          executor: 'example-acp',
          profile: undefined,
          overrides: { model: 'vendor-model', thinking: null },
        },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({
      execution: { executor: 'example-acp', overrides: { model: 'vendor-model', thinking: null } },
      model: undefined,
      thinking: undefined,
      permissionMode: 'manual',
    });
  });

  it('withholds a stale approval mode when the incoming execution names it, per key', () => {
    // The `null` here means "fall through to the next layer", so re-sending the
    // session's mode would silently turn it back into a concrete value. Model
    // and effort are a different key this selection does not name, so the
    // user's own picks still ride — ownership is decided one control at a time.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: true,
        model: 'stale-picked-model',
        thinking: 'stale-picked-effort',
        permissionMode: 'manual',
        permissionTouched: true,
        pendingExecution: {
          executor: 'example-acp',
          profile: undefined,
          overrides: { permission_mode: null },
        },
        boundExecution: { executor: 'native', profile: 'agent', overrides: undefined },
      }),
    ).toEqual({
      execution: { executor: 'example-acp', overrides: { permission_mode: null } },
      model: 'stale-picked-model',
      thinking: 'stale-picked-effort',
      permissionMode: undefined,
    });
  });

  it('still lets an explicit post-confirm pick ride a switch that names no override', () => {
    // The existing contract: when the incoming binding stays silent, a pick
    // made after confirming wins over the incoming profile's pins — and the
    // control that was not picked does not ride along with it.
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: 'reviewer',
        boundProfile: 'agent',
        modelTouched: true,
        effortTouched: false,
        model: 'provider/other',
        thinking: 'off',
        pendingExecution: undefined,
        boundExecution: undefined,
      }),
    ).toEqual({ profile: 'reviewer', model: 'provider/other', thinking: undefined });
  });

  it('inherits the external profile binding without message model overrides', () => {
    expect(
      resolveProfileSwitchSubmission({
        pendingProfile: undefined,
        boundProfile: 'agent',
        modelTouched: false,
        effortTouched: false,
        model: 'provider/model',
        thinking: 'high',
        permissionMode: 'auto',
        pendingExecution: undefined,
        boundExecution: { executor: 'claude-acp', profile: 'reviewer', overrides: undefined },
      }),
    ).toEqual({ model: undefined, thinking: undefined, permissionMode: 'auto' });
  });
});

describe('executionSwitchName', () => {
  it('names the engine by its catalog label, and the native engine as Kiki', () => {
    const labels = { __native: 'Kiki', 'claude-acp': 'Claude Code' };
    expect(executionSwitchName({ executor: 'claude-acp', profile: undefined, overrides: undefined }, labels)).toBe('Claude Code');
    expect(executionSwitchName({ executor: 'native', profile: 'agent', overrides: undefined }, labels)).toBe('Kiki');
  });

  it('falls back to the raw id for an engine the catalog does not list', () => {
    expect(executionSwitchName({ executor: 'custom-xyz', profile: undefined, overrides: undefined }, { __native: 'Kiki' })).toBe('custom-xyz');
  });
});

describe('shouldClearPendingProfileOnSendError', () => {
  it('keeps the pending pick (and draft) for transport-source failures and timeout', () => {
    expect(
      shouldClearPendingProfileOnSendError(new ApiError({
        code: -1, msg: 'network down', data: null, source: 'transport', reason: 'transport.network',
      })),
    ).toBe(false);
    expect(
      shouldClearPendingProfileOnSendError(
        new ApiError({ code: API_CODES.TIMEOUT, msg: 'timed out', data: null, source: 'transport', reason: 'transport.timeout' }),
      ),
    ).toBe(false);
    expect(shouldClearPendingProfileOnSendError(new Error('boom'))).toBe(false);
  });

  it('does not reinterpret a server-origin negative code as transport failure', () => {
    expect(
      shouldClearPendingProfileOnSendError(new ApiError({ code: -1, msg: 'server rejected', data: null, source: 'server' })),
    ).toBe(true);
  });

  it('clears the pick only on a definitive server-side business rejection', () => {
    expect(
      shouldClearPendingProfileOnSendError(new ApiError({ code: 40001, msg: 'route locked', data: null })),
    ).toBe(true);
  });
});

describe('sendNowNotice', () => {
  it('does not toast for a healthy durable restoring acknowledgement', () => {
    expect(sendNowNotice('restoring', undefined)).toBeUndefined();
    expect(sendNowNotice('started', undefined)).toBeUndefined();
    expect(sendNowNotice('steered', undefined)).toBeUndefined();
  });

  it('keeps the held recovery notice and identifies requests no longer pending', () => {
    expect(sendNowNotice('held', undefined)).toEqual({ tone: 'info', key: 'sv.submissionRecovery.server' });
    expect(sendNowNotice('not_pending', 'prompt_no_longer_pending')).toEqual({ tone: 'info', key: 'sv.steerQueuedNotPending' });
  });

  it('names the reason the server kept the message queued', () => {
    expect(sendNowNotice('queued', 'target_changed')?.key).toBe('sv.steerQueuedTargetChanged');
    expect(sendNowNotice('queued', 'prompt_no_longer_pending')?.key).toBe('sv.steerQueuedNotPending');
    expect(sendNowNotice('queued', 'steer_rejected')?.key).toBe('sv.steerQueuedRejected');
    expect(sendNowNotice('queued', 'external_retry')?.key).toBe('sv.steerQueuedExternalUnknown');
    expect(sendNowNotice('held', 'external_retry')?.key).toBe('sv.steerQueuedExternalUnknown');
    expect(sendNowNotice('queued', 'executor_deferred')?.key).toBe('sv.steerQueuedExternal');
    expect(sendNowNotice('queued', 'model_switch_boundary')?.key).toBe('sv.steerQueuedModelBoundary');
    expect(sendNowNotice('queued', 'no_active_turn')?.key).toBe('sv.steerQueuedNoActiveTurn');
  });

  it('does not claim the turn ended when the receipt carries no reason', () => {
    expect(sendNowNotice('queued', undefined)?.key).toBe('sv.steerQueued');
    expect(sendNowQueuedNotice(undefined)).toBe('sv.steerQueued');
  });

  it('explains a Send now that has to open its own turn', () => {
    expect(sendNowOwnTurnNotice('binding')).toBe('sv.sendNowOwnTurnBinding');
    expect(sendNowOwnTurnNotice('model')).toBe('sv.sendNowOwnTurnModel');
  });
});

describe('nowReceiptDecision', () => {
  const entry = (overrides: Partial<PromptItem> = {}): PromptItem => ({
    prompt_id: 'p', user_message_id: 'u', status: 'queued',
    content: [{ type: 'text', text: 'body' }], created_at: '2026-10-20T00:00:00.000Z',
    ...overrides,
  });
  const decide = (input: { ingress?: readonly PromptItem[]; reported?: string | null; settled?: boolean }) =>
    nowReceiptDecision({ promptId: 'p', reported: input.reported ?? null, ingress: input.ingress ?? [], settled: input.settled ?? false });

  it('waits while the durable read has not landed yet', () => {
    expect(decide({})).toEqual({ kind: 'wait' });
    expect(decide({ ingress: [entry({ admission: 'restoring' })] })).toEqual({ kind: 'wait' });
  });

  it('never treats an unadmitted receipt or a stale delivery field as final', () => {
    expect(decide({ ingress: [entry({ admission: 'restoring', delivery_state: 'queued', delivery_reason: 'target_changed' })] }))
      .toEqual({ kind: 'wait' });
    expect(decide({ ingress: [entry({ admission: 'held', delivery_state: 'queued', delivery_reason: 'steer_rejected' })] }))
      .toEqual({ kind: 'wait' });
  });

  it('lets a started prompt win over a stale queued record still in the ingress', () => {
    expect(decide({
      settled: true,
      ingress: [entry({ admission: 'admitted', delivery_state: 'queued', delivery_reason: 'target_changed' })],
    })).toEqual({ kind: 'drop' });
  });

  it('reports the final reason once', () => {
    expect(decide({ ingress: [entry({ admission: 'admitted', delivery_state: 'queued', delivery_reason: 'target_changed' })] }))
      .toEqual({ kind: 'report', reason: 'target_changed' });
    expect(decide({ reported: 'target_changed', ingress: [entry({ admission: 'admitted', delivery_state: 'queued', delivery_reason: 'target_changed' })] }))
      .toEqual({ kind: 'drop' });
  });

  it('hands the prompt to the transcript once it runs, steers or reaches a row', () => {
    expect(decide({ ingress: [entry({ admission: 'admitted', status: 'running' })] })).toEqual({ kind: 'drop' });
    expect(decide({ ingress: [entry({ admission: 'admitted', delivery_state: 'steered' })] })).toEqual({ kind: 'drop' });
    expect(decide({ ingress: [entry({ admission: 'failed' })] })).toEqual({ kind: 'drop' });
    expect(decide({ settled: true })).toEqual({ kind: 'drop' });
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

describe('executionPickIsPending', () => {
  // What the /new draft stores: the user's pick exactly as chosen.
  const draft = { executor: 'native', profile: 'agent', profile_file: undefined, overrides: undefined };
  // The server's resolved binding merges session defaults the draft never
  // named (the create path folds permission_mode into the selection's
  // overrides), so an identity comparison reads a switch that never happened.
  const boundResolved = {
    executor: 'native',
    profile: 'agent',
    profile_file: undefined,
    overrides: { permission_mode: 'manual' as const },
  };

  it('does not read a restored /new draft pick as a switch before the conversation starts', () => {
    expect(executionPickIsPending(draft, boundResolved, false)).toBe(false);
    expect(executionPickIsPending({ ...draft, overrides: { model: 'example/model' } },
      { ...boundResolved, overrides: { permission_mode: 'manual' as const, model: 'example/model' } }, false)).toBe(false);
  });

  it('treats a differing pick as pending once the conversation has started', () => {
    expect(executionPickIsPending(draft, boundResolved, true)).toBe(true);
    expect(executionPickIsPending({ executor: 'claude-acp', profile: undefined, overrides: undefined }, boundResolved, true)).toBe(true);
  });

  it('never reports pending without a pick', () => {
    expect(executionPickIsPending(undefined, boundResolved, false)).toBe(false);
    expect(executionPickIsPending(undefined, boundResolved, true)).toBe(false);
  });
});

describe('optimistic submission', () => {
  it('shows a compact sending status and keeps its slow state in the tooltip', () => {
    const state = createViewState('session');
    const pending = { id: 'local-1', text: 'New message', createdAt: '2026-08-23T00:00:00.000Z', slow: false, preserved: true, retryable: false, status: 'sending' as const };
    const render = (slow: boolean) => renderToStaticMarkup(<MemoryRouter><I18nProvider>
      <Transcript
        state={{ ...state, loaded: true, transcriptReady: true, blocks: withOptimisticUserBlock(state.blocks, { ...pending, slow }) }}
        onLoadOlder={async () => false}
        onResolveApproval={async () => {}}
        onAnswerQuestion={async () => {}}
        onDismissQuestion={async () => {}}
      />
    </I18nProvider></MemoryRouter>);
    expect(render(false)).toContain('data-optimistic-status="sending"');
    expect(render(false)).toContain('New message');
    expect(render(true)).toContain('data-optimistic-slow=""');
    expect(withOptimisticUserBlock(state.blocks, undefined)).toBe(state.blocks);
  });

  it('keeps unknown delivery and held recovery on the message object with an action only when held', () => {
    const state = createViewState('session');
    const render = (status: 'offline' | 'server', retryable: boolean) => renderToStaticMarkup(<MemoryRouter><I18nProvider>
      <Transcript
        state={{ ...state, loaded: true, transcriptReady: true, blocks: withOptimisticUserBlock(state.blocks, {
          id: 'pending-message', text: 'Needs retry', createdAt: '2026-08-23T00:00:00Z', slow: true,
          preserved: true, retryable, status,
        }) }}
        onLoadOlder={async () => false}
        onResolveApproval={async () => {}}
        onAnswerQuestion={async () => {}}
        onDismissQuestion={async () => {}}
        onRetryPending={() => {}}
      />
    </I18nProvider></MemoryRouter>);
    const offline = render('offline', true);
    expect(offline).toContain('data-optimistic-status="offline"');
    expect(offline).toContain('data-pending-retry');
    expect(offline).not.toContain('stillSending');
    const held = render('server', true);
    expect(held).toContain('data-optimistic-status="server"');
    expect(held).toContain('data-pending-retry');
    const syncing = render('server', false);
    expect(syncing).toContain('data-optimistic-status="server"');
    expect(syncing).not.toContain('data-pending-retry');
  });

  it.each(['queued', 'running', undefined] as const)('replaces the pending echo on a canonical %s event before the REST receipt', (promptStatus) => {
    const pending = { id: 'prompt-new', text: 'Repeated text', createdAt: '2026-08-23T00:00:00Z', slow: true, preserved: true, retryable: false, status: 'sending' as const };
    const blocks: readonly Block[] = [{ kind: 'user', id: 'message-new', promptId: pending.id,
      text: pending.text, createdAt: pending.createdAt, promptStatus }];
    expect(withOptimisticUserBlock(blocks, pending)).toBe(blocks);
    const unrelated = [{ ...blocks[0]!, promptId: 'another-prompt' }] as readonly Block[];
    expect(withOptimisticUserBlock(unrelated, pending)).toHaveLength(2);
  });

  it('restores a failed send only when the composer is still empty', () => {
    const attachments = [{ kind: 'file', path: 'example.txt', name: 'example.txt', isDir: false }] as const;
    expect(recoverFailedSubmission('', [], 'Original draft', attachments)).toEqual({
      text: 'Original draft', attachments,
    });
    expect(recoverFailedSubmission('New follow-up', [], 'Original draft', attachments)).toBeUndefined();
    expect(recoverFailedSubmission('', attachments, 'Original draft', attachments)).toBeUndefined();
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

describe('approval shortcut workspace scope', () => {
  it('picks only main cards when the keyboard target is outside the preview', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-agent-workspace-target="main"><button data-approval-id="main-1"></button></div>' +
      '<aside data-preview-workspace><section data-preview-tabpanel="panel:child"><div data-agent-workspace-target="child"><button data-approval-id="child-1"></button></div></section></aside>';
    const cards = collectApprovalShortcutCards(approvalShortcutRoot(root, root, undefined)!);
    expect(cards.map((card) => card.id)).toEqual(['main-1']);
    const childButton = root.querySelector('[data-approval-id="child-1"]')!;
    expect(collectApprovalShortcutCards(approvalShortcutRoot(root, childButton, undefined)!).map((card) => card.id))
      .toEqual(['child-1']);
    // At narrow widths the panel covers main even if focus remained on the
    // document body after opening it; no keyboard decision reaches behind it.
    expect(collectApprovalShortcutCards(approvalShortcutRoot(root, root, undefined, true)!).map((card) => card.id))
      .toEqual(['child-1']);
  });

  it('scopes routed child and ignores hidden preview tabs', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-agent-workspace-target="child"><button data-approval-id="route"></button></div>' +
      '<aside data-preview-workspace><section data-preview-tabpanel="panel:other" hidden><div data-agent-workspace-target="other"><button data-approval-id="hidden"></button></div></section></aside>';
    expect(collectApprovalShortcutCards(approvalShortcutRoot(root, root, 'child')!).map((card) => card.id))
      .toEqual(['route']);
    expect(approvalShortcutRoot(root, root.querySelector('[data-approval-id="hidden"]'), 'child')).toBeNull();
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

describe('shouldHandleGlobalAbortOnEscape', () => {
  const ready = {
    key: 'Escape',
    defaultPrevented: false,
    overlayOpen: false,
    terminalFocused: false,
    terminalOpen: false,
    inFormField: false,
  };

  it('aborts only when no nearer interaction consumed Escape', () => {
    expect(shouldHandleGlobalAbortOnEscape(ready)).toBe(true);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, defaultPrevented: true })).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, overlayOpen: true })).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, terminalFocused: true })).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, terminalOpen: true })).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, inFormField: true })).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({ ...ready, key: 'Enter' })).toBe(false);
  });

  it('does not abort a running main turn for body-focused Escape while child preview is fullscreen', () => {
    const running = { ...createViewState('session-test'), busy: true, abortablePromptId: 'p-main' };
    const abortActive = vi.fn();
    const attemptAbort = (fullscreenPreviewOpen: boolean, defaultPrevented = false) => {
      if (canAbortActiveTurn(running) && shouldHandleGlobalAbortOnEscape({
        ...ready, defaultPrevented, fullscreenPreviewOpen,
      })) abortActive();
    };
    attemptAbort(true); // Listener ran before the preview's fullscreen closer.
    attemptAbort(true, true); // Listener ran after that closer claimed Escape.
    expect(abortActive).not.toHaveBeenCalled();
    attemptAbort(false); // Without preview chrome, Escape still aborts main.
    expect(abortActive).toHaveBeenCalledTimes(1);
  });

  it('does not abort a running main turn when Escape was consumed by mobile sidebar drawer', () => {
    const running = { ...createViewState('session-test'), busy: true, abortablePromptId: 'p-main' };
    const abortActive = vi.fn();
    // Case 1: mobile drawer registered in uiBusy overlayOpen
    if (canAbortActiveTurn(running) && shouldHandleGlobalAbortOnEscape({ ...ready, overlayOpen: true })) {
      abortActive();
    }
    // Case 2: mobile drawer consumed Escape via defaultPrevented
    if (canAbortActiveTurn(running) && shouldHandleGlobalAbortOnEscape({ ...ready, defaultPrevented: true })) {
      abortActive();
    }
    expect(abortActive).not.toHaveBeenCalled();
  });

  it('uses an in-flight engine id rather than requiring a visible user prompt', () => {
    const idle = createViewState('session-test');
    expect(canAbortActiveTurn(idle)).toBe(false);
    expect(canAbortActiveTurn({ ...idle, busy: true, abortablePromptId: 'p-cron' })).toBe(true);
    expect(canAbortActiveTurn({ ...idle, busy: true, abortableTurnId: 4 })).toBe(true);
    expect(canAbortActiveTurn({ ...idle, busy: false, abortablePromptId: 'p-cron' })).toBe(false);
    expect(canAbortActiveTurn({ ...idle, busy: false, abortableTurnId: 4 })).toBe(false);
    expect(canAbortActiveTurn({ ...idle, busy: true, abortablePromptId: undefined })).toBe(false);
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
    expect(html).toContain('data-context-level="ok"');
  });

  it('turns amber and points to details at exactly 50%', () => {
    const html = renderMeter(50_000, 100_000);
    expect(html).toContain('50%');
    expect(html).toContain('data-context-level="warn"');
    expect(html).toContain('details</span>');
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

  it('leaves only a definite absence while this session still owns the route', () => {
    const gone = 'session sess-a does not exist (code 40401)';
    expect(sessionRouteOwnsSession('/s/sess-a', 'sess-a')).toBe(true);
    expect(sessionRouteOwnsSession('/s/sess-a/agent/main', 'sess-a')).toBe(true);
    expect(sessionRouteOwnsSession('/s/sess-ab', 'sess-a')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/s/sess-a')).toBe(true);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/s/sess-a/agent/main')).toBe(true);
    expect(sessionAbsenceShouldLeaveRoute('session not found: sess-a (code 40401)', 'sess-a', '/s/sess-a')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute('session sess-a not found (code 40401)', 'sess-a', '/s/sess-a')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute('content unavailable (code 40401)', 'sess-a', '/s/sess-a')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute('session sess-a has no recoverable cwd (code 40401)', 'sess-a', '/s/sess-a')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/s/sess-b')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/new')).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/s/sess-a', true)).toBe(false);
    expect(sessionAbsenceShouldLeaveRoute(gone, 'sess-a', '/s/sess-a', false)).toBe(true);
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
    expect(html).toContain('2 sessions need you');
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
            state={{ ...createViewState('sess-1'), loaded: true, transcriptReady: true, blocks: [grandchild] }}
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

  it('shows parent and child chips by default and keeps siblings behind one count chip', async () => {
    const longParent = 'Composer state variants for the settings sheet';
    const family = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'lead', parentAgentId: 'main', name: longParent, status: 'running', description: 'Draft the composer states' },
        { agentId: 'agent-1', parentAgentId: 'lead', name: 'Current' },
        ...Array.from({ length: 14 }, (_, index) => ({
          agentId: `peer-${index + 1}`,
          parentAgentId: 'lead',
          name: `Peer ${index + 1}`,
        })),
        ...Array.from({ length: CHILD_CHIP_LIMIT + 2 }, (_, index) => ({
          agentId: `child-${index + 1}`,
          parentAgentId: 'agent-1',
          name: `Child ${index + 1}`,
        })),
      ],
    );
    const related = relatedAgentNodes(family, 'agent-1');
    expect(related.siblings).toHaveLength(14);
    expect(related.siblings.every((node) => node.parentAgentId === 'lead')).toBe(true);

    const opened: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentRelations forest={family} currentAgentId="agent-1" onOpen={(id) => { opened.push(id); }} />
        </I18nProvider>,
      );
    });
    try {
      const strip = container.querySelector('[data-agent-relations]')!;
      // Parent: one chip; its word is a separate quiet label, never a
      // "Parent:" prefix glued to the name. Full name, task and state ride
      // the tooltip.
      const parent = strip.querySelector<HTMLButtonElement>('[data-relation="parent"]')!;
      expect(parent.textContent).toBe(`Parent${longParent}`);
      expect(parent.textContent).not.toContain(':');
      expect(parent.getAttribute('aria-label')).toBe(`Parent ${longParent}`);
      expect(parent.title.split('\n')[0]).toBe(longParent);
      expect(parent.title).toContain(longParent);
      expect(parent.title).toContain('Draft the composer states');
      expect(parent.title).toContain('Running');
      // Children: visible at the same time, one chip each; past the inline
      // cap (or the strip's two lines, measured in a browser) the rest fold
      // into a "+N" chip that lists them.
      const children = [...strip.querySelectorAll('[data-relation="child"]')].map((chip) => chip.getAttribute('data-agent-id'));
      expect(children).toHaveLength(CHILD_CHIP_LIMIT);
      const moreChildren = strip.querySelector<HTMLButtonElement>('[data-relations-toggle="children"]')!;
      expect(moreChildren.textContent).toBe('+2');
      await act(async () => { moreChildren.click(); });
      const childList = document.querySelector<HTMLElement>('[data-relations-popover="children"]')!;
      const listed = [...childList.querySelectorAll('[data-agent-id]')].map((row) => row.getAttribute('data-agent-id'));
      // Chips and list together cover every child exactly once, in forest order.
      expect([...children, ...listed]).toEqual(related.children.map((node) => node.agentId));
      await act(async () => { moreChildren.click(); });
      expect(document.querySelector('[data-relations-popover]')).toBeNull();
      // Siblings: a single count chip, no sibling listed until it is opened.
      const siblings = strip.querySelector<HTMLButtonElement>('[data-relations-toggle="siblings"]')!;
      expect(siblings.getAttribute('aria-expanded')).toBe('false');
      expect(siblings.textContent).toBe('Siblings14');
      expect(document.querySelector('[data-relations-popover]')).toBeNull();
      expect(strip.querySelector('[data-agent-id^="peer-"]')).toBeNull();

      await act(async () => { siblings.click(); });
      const popover = document.querySelector<HTMLElement>('[data-relations-popover="siblings"]')!;
      expect(popover.querySelectorAll('[data-agent-id]')).toHaveLength(14);
      // A long list filters by name.
      const filter = popover.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(filter, 'Peer 1');
        filter.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect([...popover.querySelectorAll('[data-agent-id]')].map((row) => row.getAttribute('data-agent-id')))
        .toEqual(['peer-1', 'peer-10', 'peer-11', 'peer-12', 'peer-13', 'peer-14']);
      await act(async () => { popover.querySelector<HTMLButtonElement>('[data-agent-id="peer-12"]')!.click(); });
      expect(document.querySelector('[data-relations-popover]')).toBeNull();

      // Every chip opens through the one handler the timeline card uses.
      await act(async () => { parent.click(); });
      await act(async () => { strip.querySelector<HTMLButtonElement>('[data-agent-id="child-2"]')!.click(); });
      expect(opened).toEqual(['peer-12', 'lead', 'child-2']);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
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
    // Main's team roster: bounded rows (overflow goes to the view-all dialog).
    expect(html).toContain('data-subagent-scroll');
    expect(html).toContain('data-agent-tree');
  });

  it('adds subagent context to the shared rail: own task, needs-input badge, tree as the switch surface', async () => {
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
    // Live render: the rail defers mounting the agent panel behind an
    // IntersectionObserver effect, which never fires under static markup.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
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
    });
    const html = container.innerHTML;
    // Now tells the finished agent's story: its result, the brief on hover.
    expect(html).toContain('Presentation contract verified.');
    expect(html).toContain('title="Presentation contract verified.\n\nReview the presentation contract"');
    expect(html).toContain('data-agent-status="completed"');
    expect(html).not.toContain('30.0s');
    // Needs-input badge with the pending count.
    expect(html).toContain('data-needs-input');
    expect(html).toContain('Needs you');
    // Switching agents goes up the breadcrumb to main's team list, not a
    // separate sibling nav block.
    expect(html).not.toContain('data-jump-to-spawn');
    expect(html).not.toContain('data-sibling-prev');
    expect(html).not.toContain('data-sibling-next');
    expect(html).not.toContain('data-agent-tree');
    // The agent's own todos, not the main agent's.
    expect(html).toContain('child-only todo');
    // The focused agent's own controls.
    expect(html).toContain('data-subagent-context');
    // Focus ownership is explicit: the head reads "Main agent / Reviewer".
    expect(html).toContain('data-rail-owner-name="Reviewer"');
    expect(html).toContain('data-inspect-main');
    await act(async () => root.unmount());
    container.remove();
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
    expect(html).not.toContain('data-sibling-prev');
    expect(html).not.toContain('data-sibling-next');
  });

  it('shows the failure reason inline for a failed subagent', () => {
    const railForest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher' },
      ],
    );
    const failedBlock: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-1',
      subagentId: 'agent-1',
      parentAgentId: 'main',
      parentToolCallId: 'call-1',
      name: 'Researcher',
      label: 'Researcher',
      description: 'Research the topic',
      model: undefined,
      thinkingEffort: undefined,
      status: 'failed',
      summary: undefined,
      error: 'model request failed: upstream timeout',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      toolCallCount: 0,
      transcript: [],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={createViewState('sess-1')}
            forest={railForest}
            selectedAgentId="agent-1"
            subagent={{
              agentId: 'agent-1',
              block: failedBlock,
              pendingInteractionCount: 0,
              onJumpToSpawn: undefined,
            }}
            onCancelTask={() => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-agent-status="failed"');
    expect(html).toContain('model request failed: upstream timeout');
    // A failure is stated, not emphasized: no danger colour in the rail (as a
    // class token; the overview's selector that remaps danger is not one).
    expect(html).not.toMatch(/[\s"]text-danger[\s"]/);
  });

  it('lists the team, clickable task rows, and the bulk stop button', () => {
    const railForest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
      ],
    );
    const state = {
      ...createViewState('sess-1'),
      session: {
        id: 'sess-1',
        metadata: { cwd: 'C:/work/example' },
        message_count: 0,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      tasks: [
        {
          id: 't1',
          session_id: 'sess-1',
          kind: 'bash',
          description: 'dev server',
          status: 'running',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'sub-1',
          session_id: 'sess-1',
          kind: 'subagent',
          description: 'Researcher',
          status: 'running',
          created_at: '2026-01-01T00:00:00.000Z',
          agent_id: 'agent-1',
        },
      ],
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={state as never}
              forest={railForest}
              onCancelTask={() => {}}
              onStopAgentTask={() => Promise.resolve()}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Few agents fit the team roster; the view-all entry waits for overflow.
    expect(html).not.toContain('data-subagents-view-all');
    expect(html).toContain('data-agent-id="agent-1"');
    expect(html).toContain('data-task-open="t1"');
    // Subagent runs stay in the team chapter; the task rows skip them.
    expect(html).not.toContain('data-task-open="sub-1"');
    expect(html).toContain('data-terminate-all-subagents');
  });

  it('hides the bulk stop button when no stopper is wired', () => {
    const railForest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'main' },
        { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
      ],
    );
    const state = {
      ...createViewState('sess-1'),
      tasks: [
        {
          id: 'sub-1',
          session_id: 'sess-1',
          kind: 'subagent',
          description: 'Researcher',
          status: 'running',
          created_at: '2026-01-01T00:00:00.000Z',
          agent_id: 'agent-1',
        },
      ],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={state as never}
            forest={railForest}
            onCancelTask={() => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain('data-terminate-all-subagents');
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
    // The settled card is process now: it folds into the turn's "Worked" line,
    // which counts it (the card itself renders once the fold is opened).
    expect(html).toMatch(/data-history-fold="\d+"/);
    expect(html).toMatch(/1 subagent|派出 1 个子智能体/);
    expect(html).toContain('data-row-action="edit"');
    expect(html).toContain('data-row-action="fork"');
    expect(html).toContain('data-row-action="regenerate"');
    expect(html).toContain('data-turn-tail');
    expect(html.includes('from subagent') || html.includes('子代理')).toBe(true);
    expect(html).not.toContain('data-steer');
    // The shell run folded with it; the fold counts it as a step.
    expect(html).toMatch(/\d+ steps?|\d+ 步/);
  });
});

describe('nested subagent task ownership', () => {
  it('finds B in parent A task state instead of the main task snapshot', () => {
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'agent-a', parentAgentId: 'main', name: 'A', status: 'running' },
        { agentId: 'agent-b', parentAgentId: 'agent-a', name: 'B', status: 'running' },
      ],
    );
    const nestedTask = {
      id: 'spawn-b',
      session_id: 'sess-1',
      kind: 'subagent' as const,
      description: 'B',
      status: 'running' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      run_in_background: true,
      agent_id: 'agent-b',
    };

    const resolved = resolveRunningSubagentTask({
      agentId: 'agent-b',
      parentAgentId: forest.byId['agent-b']?.parentAgentId,
      mainTasks: [],
      parentTasks: [nestedTask],
    });

    expect(resolved).toEqual({ ownerAgentId: 'agent-a', task: nestedTask });
  });
});

describe('recovered-queue hold gate', () => {
  it('resets recovery controls per session through the route owner key', () => {
    const noop = () => {};
    const sessionA = SessionRouteView({ onToggleSidebar: noop, sessions: [], sessionId: 'session-a' });
    const sessionB = SessionRouteView({ onToggleSidebar: noop, sessions: [], sessionId: 'session-b' });
    expect(sessionA.key).toBe('session-a');
    expect(sessionB.key).toBe('session-b');
    expect(sessionB.key).not.toBe(sessionA.key);
  });
});


describe('new-session durable first message', () => {
  const frozen = (): FirstSessionMessageRecord => ({
    status: 'ready',
    message: { initialPromptId: 'new-session:example-create', initialPrompt: 'Original message', planMode: true, personaGreetingReply: true },
    submission: { promptId: 'new-session:example-create', text: 'Original message', content: [{ type: 'text', text: 'Original message' }], skills: [{ name: 'example-skill', args: 'original' }], planMode: true, personaGreetingReply: true, model: undefined, thinking: undefined },
  });

  it('saves the exact submission before sending and only queries after refresh or a lost response', async () => {
    const record = frozen();
    let saved = record;
    let release!: (value: string) => void;
    const submit = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const save = (value: FirstSessionMessageRecord) => { saved = structuredClone(value); };
    const first = submitFirstSessionMessage({ record, save, read: vi.fn(), submit });
    expect(saved).toEqual({ ...record, status: 'submitted' });
    expect(submit).toHaveBeenCalledExactlyOnceWith(record.submission);
    const read = vi.fn().mockResolvedValue('accepted');
    await expect(submitFirstSessionMessage({ record: structuredClone(saved), save, read, submit })).resolves.toBe('accepted');
    expect(read).toHaveBeenCalledExactlyOnceWith(record.message.initialPromptId);
    expect(submit).toHaveBeenCalledTimes(1);
    release('accepted');
    await expect(first).resolves.toBe('accepted');
  });

  it('never auto-replays an unknown first message and only explicitly retries after an authoritative missing receipt', async () => {
    const record = { ...frozen(), status: 'submitted' as const };
    const submit = vi.fn().mockResolvedValue('accepted');
    const save = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(new Error('read timed out')).mockResolvedValue(undefined);
    await expect(submitFirstSessionMessage({ record, save, read, submit, retryMissing: true })).rejects.toThrow('read timed out');
    await expect(submitFirstSessionMessage({ record, save, read, submit })).rejects.toThrow('no confirmed receipt');
    expect(submit).not.toHaveBeenCalled();
    await expect(submitFirstSessionMessage({ record, save, read, submit, retryMissing: true })).resolves.toBe('accepted');
    expect(submit).toHaveBeenCalledExactlyOnceWith(record.submission);
    expect(save).toHaveBeenCalledWith(record);
  });

  it('preserves held receipts without replaying and keeps late writes in their original home and connection', async () => {
    const record = { ...frozen(), status: 'submitted' as const };
    const submit = vi.fn();
    const held = { admission: 'held' };
    await expect(submitFirstSessionMessage({ record, save: vi.fn(), read: async () => held, submit })).resolves.toEqual(held);
    expect(submit).not.toHaveBeenCalled();
    configureSpaceStorage({ homeId: 'first-message-a' });
    const captured = spaceStorage.capture();
    configureSpaceStorage({ homeId: 'first-message-b' });
    writeFirstSessionMessage('connection-a', 'session-shared', record, captured);
    expect(readFirstSessionMessage('connection-a', 'session-shared')).toBeUndefined();
    configureSpaceStorage({ homeId: 'first-message-a' });
    expect(readFirstSessionMessage('connection-b', 'session-shared')).toBeUndefined();
    expect(readFirstSessionMessage('connection-a', 'session-shared')).toEqual(record);
    clearFirstSessionMessage('connection-a', 'session-shared');
    configureSpaceStorage(null);
  });
});

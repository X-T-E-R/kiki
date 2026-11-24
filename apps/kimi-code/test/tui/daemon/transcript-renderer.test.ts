import { Container, visibleWidth } from '@kiki/pi-tui';
import type { PromptItem } from '@kiki/protocol';
import { agentTranscriptToBlocks } from '@kiki/session-core/session/transcript';
import type { Block } from '@kiki/session-core/session/transcript/types';
import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { adaptQuestionResponse } from '#/tui/interactions/question-adapter';
import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import type { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { createBlockComponent, DaemonTranscriptRenderer, TranscriptNoteComponent } from '#/tui/daemon/transcript-renderer';
import {
  DaemonContentContinuationManager,
  type ContentContinuationController,
} from '#/tui/daemon/content-continuation';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '').replaceAll(/\u001B\]133;[ABC]\u0007/g, '');
}

function render(blocks: readonly Block[]): string {
  const container = new Container();
  const renderer = new DaemonTranscriptRenderer(container);
  renderer.sync(blocks);
  return strip(container.render(100).join('\n'));
}

describe('DaemonTranscriptRenderer', () => {
  it.each([52, 120])('folds settled work and keeps Steer, replies and errors visible at %s columns', (width) => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const frame = () => strip(container.render(width).join('\n'));
    const thinking = Array.from({ length: 30 }, (_, i) => `Internal thought ${i}`).join('\n');
    const reads = [1, 2, 3].map((id) => ({
      kind: 'tool' as const, id: `read-${id}`, toolCallId: `read-${id}`, name: 'Read', turnId: 't1',
      args: { path: `file-${id}.txt` }, argsText: '', display: undefined, description: undefined,
      status: 'done' as const, output: `Read detail ${id}`, isError: false, durationMs: undefined,
      progressText: undefined,
    }));
    renderer.sync([
      { kind: 'user', id: 'steer', text: 'Keep this follow-up', createdAt: '', turnId: 't1' },
      { kind: 'system-reminder', id: 'directive', text: 'Recipe reminder detail\nAnother directive', createdAt: undefined, turnId: 't1' },
      { kind: 'thinking', id: 'thought', text: thinking, streaming: false, createdAt: undefined, turnId: 't1' },
      ...reads,
      { kind: 'assistant', id: 'answer', text: 'This is the answer', streaming: false, createdAt: undefined, turnId: 't1' },
      { ...reads[0]!, id: 'failed', toolCallId: 'failed', turnId: 't2', status: 'error', args: { path: 'failed.txt' }, output: 'File not found' },
      { kind: 'system-reminder', id: 'standalone', variant: 'steer', text: 'Standalone reminder detail', createdAt: undefined },
    ]);
    expect(frame()).toContain('Worked · 3 steps · 1 thought');
    expect(frame()).not.toContain('1 note');
    expect(frame()).toContain('This is the answer');
    expect(frame()).toContain('failed.txt');
    expect(frame().match(/Keep this follow-up/g)).toHaveLength(1);
    expect(frame()).toContain('Steer');
    expect(frame()).not.toMatch(/Recipe reminder detail|Standalone reminder detail|Internal thought|Read detail/);
    renderer.setExpanded(true);
    expect(frame()).toContain('Recipe reminder detail');
    expect(frame()).toContain('Standalone reminder detail');
    expect(frame()).toContain('Internal thought 29');
    expect(frame()).toContain('file-3.txt');
    renderer.setExpanded(false);
    expect(frame()).not.toMatch(/Recipe reminder detail|Standalone reminder detail|Internal thought/);
  });
  it('renders session-core user, assistant, tool, subagent, approval, and question blocks', () => {
    const output = render([
      {
        kind: 'user',
        id: 'user-1',
        text: 'Inspect the workspace',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'I will inspect it.',
        streaming: false,
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        kind: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        name: 'Read',
        argsText: '{"path":"README.md"}',
        args: { path: 'README.md' },
        display: undefined,
        description: undefined,
        status: 'done',
        output: 'contents',
        isError: false,
        durationMs: 12,
        progressText: undefined,
      },
      {
        kind: 'subagent',
        id: 'subagent-1',
        subagentId: 'agent-1',
        parentAgentId: 'main',
        parentToolCallId: 'tool-2',
        name: 'explore',
        description: 'Map the TUI',
        model: undefined,
        thinkingEffort: undefined,
        status: 'running',
        summary: undefined,
        error: undefined,
        endedAt: undefined,
        toolCallCount: 0,
        transcript: [],
      },
      {
        kind: 'approval',
        id: 'approval-1',
        request: {
          approval_id: 'approval-1',
          session_id: 'session-1',
          tool_call_id: 'tool-3',
          tool_name: 'Bash',
          action: 'run command',
          tool_input_display: undefined,
          created_at: '2026-01-01T00:00:02.000Z',
          expires_at: '2026-01-01T00:01:02.000Z',
        },
        resolution: undefined,
      },
      {
        kind: 'question',
        id: 'question-1',
        request: {
          question_id: 'question-1',
          session_id: 'session-1',
          questions: [{ id: 'q1', question: 'Which option?', options: [] }],
          created_at: '2026-01-01T00:00:03.000Z',
        },
        outcome: undefined,
      },
    ]);

    expect(output).toContain('Inspect the workspace');
    expect(output).toContain('I will inspect it.');
    expect(output).toContain('Read');
    expect(output).toContain('README.md');
    expect(output).toContain('explore · Map the TUI');
    expect(output).toContain('Approval required · run command');
    expect(output).toContain('Which option?');
  });

  it('renders message blocks without exposing source tool arguments', () => {
    const output = render([
      {
        kind: 'message',
        id: 'message-sent',
        origin: 'send_message',
        status: 'sent',
        text: 'Delivered result',
        attachments: [],
        deliveredTo: ['user'],
        handoff: {
          targetPersonaId: 'review-bot',
          targetSessionId: 'session-2',
          targetName: 'Review Bot',
        },
      },
      {
        kind: 'message',
        id: 'message-sending',
        origin: 'send_message',
        status: 'sending',
        text: 'Drafting result',
        attachments: [],
        deliveredTo: [],
      },
      {
        kind: 'message',
        id: 'message-failed',
        origin: 'send_message',
        status: 'failed',
        text: 'Failed result',
        attachments: [],
        deliveredTo: [],
        sourceTool: { argsText: '{"text":"INTERNAL_ONLY"}' } as never,
      },
      {
        kind: 'message',
        id: 'message-cancelled',
        origin: 'persona_greeting',
        status: 'cancelled',
        text: 'Cancelled greeting',
        attachments: [],
        deliveredTo: [],
      },
    ]);

    expect(output).toContain('→ Review Bot: Delivered result');
    expect(output).toContain('Sending: Drafting result');
    expect(output).toContain('Message not sent (failed): Failed result');
    expect(output).toContain('Message not sent (cancelled): Cancelled greeting');
    expect(output).not.toContain('INTERNAL_ONLY');
  });

  it('updates queued and blocked user messages in place and removes the label on delivery', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const user = {
      kind: 'user' as const,
      id: 'user-queue',
      text: 'Keep this prompt',
      media: [{ kind: 'file' as const, name: 'notes.txt' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    renderer.sync([{ ...user, promptStatus: 'queued' }]);
    const mounted = container.children[0];
    expect(strip(container.render(80).join('\n'))).toContain('Queued');

    renderer.sync([{ ...user, promptStatus: 'blocked' }]);
    expect(container.children[0]).toBe(mounted);
    expect(strip(container.render(80).join('\n'))).toContain('Blocked');
    expect(strip(container.render(80).join('\n'))).not.toContain('Queued');

    renderer.sync([{ ...user, text: 'Keep this refined prompt', promptStatus: 'running' }]);
    expect(container.children[0]).toBe(mounted);
    const delivered = strip(container.render(80).join('\n'));
    expect(delivered).toContain('Keep this refined prompt');
    expect(delivered).toContain('[file: notes.txt]');
    expect(delivered).not.toMatch(/Queued|Blocked|Delivered|Running/);
    renderer.sync([user]);
    expect(strip(container.render(80).join('\n'))).not.toMatch(/Queued|Blocked|Delivered|Running/);
  });

  it.each([
    ['failed', true, 'Reply failed'],
    ['failed', false, 'Prompt failed before delivery'],
    ['aborted', true, 'Prompt aborted'],
    ['aborted', false, 'Prompt aborted before delivery'],
  ] as const)('updates %s outcomes (delivered=%s) on their own user message', (status, delivered, label) => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const user = {
      kind: 'user' as const,
      id: 'user-outcome',
      text: 'Original prompt stays visible',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const neighbor = { ...user, id: 'user-neighbor', text: 'Unrelated successful prompt' };
    renderer.sync([user, neighbor]);
    const mounted = container.children[0];
    renderer.sync([
      { ...user, promptOutcome: { status, delivered, error: 'Provider stopped\nOriginal reason' } },
      neighbor,
    ]);

    expect(container.children[0]).toBe(mounted);
    const output = strip(mounted!.render(80).join('\n'));
    expect(output).toContain(user.text);
    expect(output).toContain(label);
    expect(output).toContain('Provider stopped');
    expect(output).toContain('Original reason');
    expect(output).not.toContain('/undo');
    expect(strip(container.children[1]!.render(80).join('\n'))).not.toContain(label);
    for (const width of [24, 60, 80]) {
      for (const line of mounted!.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    renderer.sync([user, neighbor]);
    expect(strip(mounted!.render(80).join('\n'))).not.toContain(label);
  });

  it('projects failed, cancelled, and held durable requests without duplicating canonical user blocks', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const ingress: PromptItem[] = [
      {
        prompt_id: 'failed-prompt',
        user_message_id: 'failed-user',
        status: 'queued',
        content: [{ type: 'text', text: 'Failed durable request' }],
        created_at: '2026-01-01T00:00:00.000Z',
        admission: 'failed',
        admission_error: { code: 500, message: 'Provider refused the saved prompt' },
      },
      {
        prompt_id: 'cancelled-prompt',
        user_message_id: 'cancelled-user',
        status: 'queued',
        content: [{ type: 'text', text: 'Cancelled durable request' }],
        created_at: '2026-01-01T00:00:01.000Z',
        admission: 'cancelled',
      },
      {
        prompt_id: 'held-prompt',
        user_message_id: 'held-user',
        status: 'queued',
        content: [{ type: 'text', text: 'Held durable request' }],
        created_at: '2026-01-01T00:00:02.000Z',
        admission: 'held',
      },
    ];

    renderer.sync([], ingress);
    expect(container.children).toHaveLength(3);
    const recovered = strip(container.render(100).join('\n'));
    expect(recovered).toContain('Failed durable request');
    expect(recovered).toContain('Prompt failed before delivery');
    expect(recovered).toContain('Provider refused the saved prompt');
    expect(recovered).toContain('Cancelled durable request');
    expect(recovered).toContain('Prompt aborted before delivery');
    expect(recovered).toContain('Held durable request');
    expect(recovered).toContain('Prompt held · check the saved prompt before retrying');

    const canonical: Block = {
      kind: 'user',
      id: 'user-failed',
      promptId: 'failed-prompt',
      text: 'Canonical failed request',
      createdAt: '2026-01-01T00:00:00.000Z',
      promptOutcome: { status: 'failed', delivered: false, error: 'Canonical admission detail' },
    };
    renderer.sync([canonical], ingress);
    expect(container.children).toHaveLength(3);
    const withCanonical = strip(container.render(100).join('\n'));
    expect(withCanonical.match(/Canonical failed request/g)).toHaveLength(1);
    expect(withCanonical).toContain('Canonical admission detail');
    expect(withCanonical).not.toContain('Failed durable request');
    expect(withCanonical).toContain('Cancelled durable request');
    expect(withCanonical).toContain('Held durable request');
  });

  it('updates steer delivery labels without leaving a success label', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const user = {
      kind: 'user' as const,
      id: 'user-steer',
      text: 'Follow-up',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    renderer.sync([{ ...user, steerStatus: 'sending' }]);
    expect(strip(container.render(80).join('\n'))).toContain('Sending');
    renderer.sync([{ ...user, steerStatus: 'waiting' }]);
    expect(strip(container.render(80).join('\n'))).toContain('Waiting for delivery');
    renderer.sync([{ ...user, steerStatus: 'preparing' }]);
    expect(strip(container.render(80).join('\n'))).toContain('Preparing delivery…');
    renderer.sync([{ ...user, steerStatus: 'unconfirmed' }]);
    expect(strip(container.render(80).join('\n'))).toContain('Delivery unconfirmed · check the queue before retrying');
    renderer.sync([{ ...user, steerStatus: 'held' }]);
    expect(strip(container.render(80).join('\n'))).toContain('Prompt held · check the saved prompt before retrying');
    renderer.sync([user]);
    expect(strip(container.render(80).join('\n'))).not.toMatch(/Sending|Waiting|Preparing|unconfirmed|held|Delivered/);
  });

  it('renders structured media on user and assistant blocks', () => {
    const output = render([
      {
        kind: 'user',
        id: 'user-media',
        text: 'See attachment',
        media: [{ kind: 'image', fileId: 'image-1' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'assistant',
        id: 'assistant-media',
        text: 'Generated file',
        media: [{ kind: 'file', fileId: 'file-1', name: 'result.txt' }],
        streaming: false,
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    expect(output).toContain('[image: image-1]');
    expect(output).toContain('[file: result.txt]');
  });

  it('mounts the real image component for inline image media', () => {
    const component = createBlockComponent({
      kind: 'user',
      id: 'user-inline-image',
      text: 'See image',
      media: [{
        kind: 'image',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        mime: 'image/png',
      }],
      createdAt: '2026-01-01T00:00:00.000Z',
    }) as Container;

    expect(component.children.some((child) => child instanceof ImageThumbnail)).toBe(true);
  });

  it('updates streaming assistant and running tool components in place', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    renderer.sync([
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'Hel',
        streaming: true,
        createdAt: undefined,
      },
      {
        kind: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        name: 'Read',
        argsText: '',
        args: { path: 'a.ts' },
        display: undefined,
        description: undefined,
        status: 'running',
        output: undefined,
        isError: undefined,
        durationMs: undefined,
        progressText: undefined,
      },
    ]);
    const before = [...container.children];

    renderer.sync([
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'Hello',
        streaming: false,
        createdAt: undefined,
      },
      {
        kind: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        name: 'Read',
        argsText: '',
        args: { path: 'a.ts' },
        display: undefined,
        description: undefined,
        status: 'done',
        output: 'done',
        isError: false,
        durationMs: 5,
        progressText: undefined,
      },
    ]);

    expect(container.children[0]).toBe(before[0]);
    expect(container.children[1]).toBe(before[1]);
    expect(strip(container.render(80).join('\n'))).toContain('Hello');
    expect(strip(container.render(80).join('\n'))).toContain('Used Read');
  });

  it('replaces mutable text blocks when session-core publishes new state', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const approvalRequest = {
      approval_id: 'approval-1',
      session_id: 'session-1',
      tool_call_id: 'tool-1',
      tool_name: 'Bash',
      action: 'run command',
      tool_input_display: { kind: 'generic' },
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-01T00:01:00.000Z',
    };
    const questionRequest = {
      question_id: 'question-1',
      session_id: 'session-1',
      questions: [
        {
          id: 'q1',
          question: 'Choose?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
      created_at: '2026-01-01T00:00:00.000Z',
    };
    renderer.sync([
      {
        kind: 'subagent',
        id: 'subagent-1',
        subagentId: 'agent-1',
        parentAgentId: 'main',
        parentToolCallId: 'tool-2',
        name: 'explore',
        description: 'Map files',
        model: undefined,
        thinkingEffort: undefined,
        status: 'running',
        summary: undefined,
        error: undefined,
        endedAt: undefined,
        toolCallCount: 0,
        transcript: [],
      },
      {
        kind: 'shell',
        id: 'shell-1',
        commandId: 'shell-1',
        command: undefined,
        output: 'partial',
        done: false,
        isError: undefined,
      },
      { kind: 'approval', id: 'approval-1', request: approvalRequest, resolution: undefined },
      { kind: 'question', id: 'question-1', request: questionRequest, outcome: undefined },
    ]);
    const before = [...container.children];

    renderer.sync([
      {
        kind: 'subagent',
        id: 'subagent-1',
        subagentId: 'agent-1',
        parentAgentId: 'main',
        parentToolCallId: 'tool-2',
        name: 'explore',
        description: 'Map files',
        model: undefined,
        thinkingEffort: undefined,
        status: 'completed',
        summary: 'Mapped',
        error: undefined,
        endedAt: '2026-01-01T00:00:05.000Z',
        toolCallCount: 2,
        transcript: [],
      },
      {
        kind: 'shell',
        id: 'shell-1',
        commandId: 'shell-1',
        command: undefined,
        output: 'final',
        done: true,
        isError: false,
      },
      {
        kind: 'approval',
        id: 'approval-1',
        request: approvalRequest,
        resolution: { decision: 'approved', resolvedAt: '2026-01-01T00:00:03.000Z' },
      },
      {
        kind: 'question',
        id: 'question-1',
        request: questionRequest,
        outcome: { kind: 'answered', at: '2026-01-01T00:00:04.000Z' },
      },
    ]);

    expect(container.children).not.toEqual(before);
    for (const [index, component] of container.children.entries()) {
      expect(component).not.toBe(before[index]);
    }
    const output = strip(container.render(100).join('\n'));
    expect(output).toContain('✓ explore');
    expect(output).toContain('$ final');
    expect(output).toContain('Approval approved · run command');
  });

  it('leaves unchanged blocks and their rendered lines untouched while another block streams', () => {
    const container = new GutterContainer(1, 1);
    const renderer = new DaemonTranscriptRenderer(container);
    const settled: Block[] = [
      { kind: 'user', id: 'user-1', text: 'Fix it', createdAt: '2026-01-01T00:00:00.000Z', promptStatus: 'queued' },
      {
        kind: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        name: 'Bash',
        argsText: '',
        args: { command: 'ls' },
        display: undefined,
        description: undefined,
        status: 'done',
        output: 'a\nb\nc\nd',
        isError: false,
        durationMs: 3,
        progressText: undefined,
      },
      { kind: 'assistant', id: 'assistant-1', text: '## Done\n\n- one', streaming: false, createdAt: undefined },
      {
        kind: 'message',
        id: 'message-1',
        origin: 'send_message',
        status: 'sent',
        text: 'note',
        attachments: [],
        deliveredTo: ['user'],
      },
    ];
    const live: Block = { kind: 'assistant', id: 'live', text: 'Str', streaming: true, createdAt: undefined };
    const blocks = [...settled, live];
    renderer.sync(blocks);
    container.render(82);
    const children = [...container.children];
    const childFrames = children.map((child) => child.render(80));
    // ToolCallComponent's own cache never hits (its leading Spacer returns a
    // fresh array per render), so check that it is not rebuilt instead.
    const tool = children[1] as ToolCallComponent;
    const toolUpdates = [vi.spyOn(tool, 'updateToolCall'), vi.spyOn(tool, 'setResult')];

    renderer.sync(blocks);
    renderer.sync([...settled, { ...live, text: 'Streaming more' }]);

    expect(container.children).toHaveLength(children.length);
    for (const [index, child] of children.entries()) expect(container.children[index]).toBe(child);
    const output = strip(container.render(82).join('\n'));
    for (const index of [0, 2, 3]) expect(children[index]!.render(80)).toBe(childFrames[index]);
    for (const update of toolUpdates) expect(update).not.toHaveBeenCalled();
    expect(output).toContain('Streaming more');
  });

  it('shows a compact shell command and expands its output on demand', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    renderer.sync([
      {
        kind: 'shell',
        id: 'shell-command',
        commandId: 'command-1',
        command: 'pnpm test',
        output: '42 passed',
        done: true,
        isError: false,
      },
    ]);

    const compact = strip(container.render(80).join('\n'));
    expect(compact).toContain('$ pnpm test');
    expect(compact).not.toContain('42 passed');
    renderer.setExpanded(true);
    const expanded = strip(container.render(80).join('\n'));
    expect(expanded).toMatch(/\$ pnpm test[^\n]*\n +42 passed/u);
  });

  it('maps question dialog labels back to REST option identifiers', () => {
    expect(
      adaptQuestionResponse(
        {
          kind: 'question',
          id: 'question-1',
          request: {
            question_id: 'question-1',
            session_id: 'session-1',
            questions: [
              {
                id: 'single',
                question: 'Pick one',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
              },
              {
                id: 'multi',
                question: 'Pick many',
                multi_select: true,
                allow_other: true,
                options: [
                  { id: 'x', label: 'X' },
                  { id: 'y', label: 'Y' },
                ],
              },
            ],
            created_at: '2026-01-01T00:00:00.000Z',
          },
          outcome: undefined,
        },
        { answers: ['B', 'X, custom'], method: 'enter' },
      ),
    ).toEqual({
      single: { kind: 'single', option_id: 'b' },
      multi: { kind: 'multi_with_other', option_ids: ['x'], other_text: 'custom' },
    });
  });

  it('renders via <client> attribution from UserBlock.via, UserBlock.sourceOrigin.via, and ingress item.origin.via', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const viaFieldUser = {
      kind: 'user' as const,
      id: 'u-via',
      text: 'Check status',
      createdAt: '2026-06-01T12:34:56.000Z',
      via: { client: 'companion' },
    } as Block;
    const sourceOriginUser: Block = {
      kind: 'user',
      id: 'u-origin',
      text: 'Inspect logs',
      createdAt: '2026-06-01T12:34:58.000Z',
      sourceOrigin: { kind: 'user', via: { client: 'companion', channel: 'owner' } },
    };
    const localUser: Block = {
      kind: 'user',
      id: 'u-local',
      text: 'Local prompt',
      createdAt: '2026-06-01T12:35:00.000Z',
    };
    const failedIngress = {
      prompt_id: 'p-ingress-1',
      created_at: '2026-06-01T12:35:02.000Z',
      content: [{ type: 'text', text: 'Held remote prompt' }],
      admission: 'held',
      origin: { kind: 'user', via: { client: 'companion', channel: 'terminal' } },
    } as unknown as PromptItem;

    renderer.sync([viaFieldUser, sourceOriginUser, localUser], { ingress: [failedIngress] });
    const initial = strip(container.render(80).join('\n'));
    expect(initial).toContain('Check status  via companion');
    expect(initial).toContain('Inspect logs  via companion');
    expect(initial).toContain('Held remote prompt  via companion');
    expect(initial).toContain('Local prompt');
    expect(initial.match(/via companion/g)).toHaveLength(3);

    renderer.setShowTimestamps(true);
    const withTs = strip(container.render(80).join('\n'));
    expect(withTs).toContain('Check status  via companion');
    expect(withTs).toContain('Inspect logs  via companion');
    expect(withTs).toContain('Held remote prompt  via companion');
  });

  it('hides internal reminders/plumbing, summarizes Recipes cleanly, and deduplicates turn failure errors in collapsed mode only', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const recipeBody = '<recipe name="clean-code">\nAlways verify before committing:\n- Run unit tests\n</recipe>';

    renderer.sync([
      {
        kind: 'user',
        id: 'u1',
        turnId: 't1',
        text: 'Run task',
        createdAt: '',
        promptOutcome: {
          status: 'failed',
          delivered: true,
          error: 'Retry attempts exhausted (5/5). Connection error.',
        },
      },
      {
        kind: 'system',
        id: 'sys-recipe-1',
        turnId: 't1',
        variant: 'injection',
        source: 'model_steering',
        text: recipeBody,
        createdAt: undefined,
      },
      {
        kind: 'system',
        id: 'sys-internal',
        turnId: 't1',
        variant: 'injection',
        source: 'runtime_snapshot',
        text: '<system-reminder>\nHost runtime snapshot\n</system-reminder>',
        createdAt: undefined,
      },
      {
        kind: 'system-reminder',
        id: 'rem-renew',
        turnId: 't1',
        category: { kind: 'renew', reason: 'budget' } as never,
        text: 'Renew cognition anchor',
        createdAt: undefined,
      },
      {
        kind: 'notice',
        id: 'notice-interrupt',
        turnId: 't1',
        tone: 'neutral',
        text: 'interruption',
      },
      {
        kind: 'notice',
        id: 'agent-frame-1',
        turnId: 't1',
        tone: 'danger',
        text: 'Retry attempts exhausted (5/5). Connection error.',
      },
      {
        kind: 'notice',
        id: 'agent-turn-outcome-t1',
        turnId: 't1',
        tone: 'danger',
        text: 'Reply failed · Retry attempts exhausted (5/5). Connection error.',
      },
      {
        kind: 'user',
        id: 'u2',
        turnId: 't2',
        text: 'Second turn',
        createdAt: '',
      },
      {
        kind: 'system',
        id: 'sys-recipe-2',
        turnId: 't2',
        variant: 'injection',
        source: 'model_steering',
        text: recipeBody,
        createdAt: undefined,
      },
    ]);

    const collapsed = strip(container.render(100).join('\n'));
    expect(collapsed).toContain('Recipe · clean-code');
    expect(collapsed.match(/Recipe · clean-code/g)).toHaveLength(1);
    expect(collapsed).not.toContain('Always verify before committing:');
    expect(collapsed).not.toContain('Reminder · renew');
    expect(collapsed).not.toContain('Host runtime snapshot');
    expect(collapsed).not.toContain('interruption');
    expect(collapsed.match(/Retry attempts exhausted \(5\/5\)\. Connection error\./g)).toHaveLength(1);

    renderer.setExpanded(true);
    const expanded = strip(container.render(100).join('\n'));
    expect(expanded).toContain('Always verify before committing:');
    expect(expanded).toContain('Reminder · renew');
    expect(expanded).toContain('Interrupted');
    // Expanded view preserves every underlying notice without deduplication
    expect(expanded.match(/Retry attempts exhausted \(5\/5\)\. Connection error\./g)).toHaveLength(3);
  });

  it('preserves failed compaction diagnostics after a failed prompt and preserves danger notices across separate promptless turns', () => {
    const compactionOut = render([
      {
        kind: 'user',
        id: 'u-timeout',
        turnId: 't1',
        text: 'Summarize history',
        createdAt: '',
        promptOutcome: {
          status: 'failed',
          delivered: true,
          error: 'Timeout',
        },
      },
      {
        kind: 'notice',
        id: 'compaction-failed-1',
        tone: 'danger',
        text: 'compaction',
        compactionPhase: 'failed',
        compactionFailure: 'Timeout',
      },
      {
        kind: 'notice',
        id: 'distinct-danger-1',
        turnId: 't1',
        tone: 'danger',
        text: 'Socket read timeout while flushing stream',
      },
    ]);
    expect(compactionOut).toContain('Reply failed · Timeout');
    expect(compactionOut).toContain('Context compaction failed · Timeout');
    expect(compactionOut).toContain('Socket read timeout while flushing stream');

    const promptlessOut = render([
      {
        kind: 'notice',
        id: 'agent-frame-p1',
        tone: 'danger',
        text: 'Permission denied',
      },
      {
        kind: 'assistant',
        id: 'a-p1',
        text: 'First autonomous turn ended.',
        streaming: false,
        createdAt: undefined,
      },
      {
        kind: 'notice',
        id: 'agent-frame-p2',
        tone: 'danger',
        text: 'Permission denied',
      },
    ]);
    expect(promptlessOut.match(/Permission denied/g)).toHaveLength(2);

    const consecutivePromptlessOut = render([
      {
        kind: 'notice',
        id: 'agent-frame-only-1',
        tone: 'danger',
        text: 'Permission denied',
      },
      {
        kind: 'notice',
        id: 'agent-frame-only-2',
        tone: 'danger',
        text: 'Permission denied',
      },
    ]);
    expect(consecutivePromptlessOut.match(/Permission denied/g)).toHaveLength(2);
  });

  it('end-to-end agentTranscriptToBlocks -> DaemonTranscriptRenderer deduplicates same-turn frame error but preserves subsequent promptless turn error', () => {
    const projectedBlocks = agentTranscriptToBlocks({
      agent_id: 'main',
      prompts: [
        {
          promptId: 'p0',
          status: 'failed',
          content: [{ type: 'text', text: 'Deploy candidate' }],
          error: 'Permission denied',
          createdAt: '2026-06-01T12:00:00.000Z',
          finishedAt: '2026-06-01T12:00:01.000Z',
        },
      ],
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          promptId: 'p0',
          ordinal: 1,
          state: 'failed',
          origin: { kind: 'user', payload: { promptId: 'p0' } },
          prompt: 'Deploy candidate',
          startedAt: '2026-06-01T12:00:00.000Z',
          endedAt: '2026-06-01T12:00:01.000Z',
          error: 'Permission denied',
          steps: [
            {
              kind: 'step',
              stepId: 's0',
              turnId: 't0',
              ordinal: 1,
              state: 'failed',
              frames: [
                {
                  kind: 'notice',
                  frameId: 'f0',
                  level: 'error',
                  message: 'Permission denied',
                },
              ],
            },
          ],
        },
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 2,
          state: 'failed',
          origin: { kind: 'task', taskId: 'task-1' },
          prompt: '',
          startedAt: '2026-06-01T12:00:02.000Z',
          endedAt: '2026-06-01T12:00:03.000Z',
          error: 'Permission denied',
          steps: [
            {
              kind: 'step',
              stepId: 's1',
              turnId: 't1',
              ordinal: 1,
              state: 'failed',
              frames: [
                {
                  kind: 'notice',
                  frameId: 'f1',
                  level: 'error',
                  message: 'Permission denied',
                },
              ],
            },
          ],
        },
      ],
    });

    const t0Notice = projectedBlocks.find((b) => b.id === 'agent-frame-f0');
    const t1Notice = projectedBlocks.find((b) => b.id === 'agent-frame-f1');
    expect(t0Notice).toMatchObject({ kind: 'notice', turnId: 't0', tone: 'danger' });
    expect(t1Notice).toMatchObject({ kind: 'notice', turnId: 't1', tone: 'danger' });

    const collapsed = render(projectedBlocks);
    expect(collapsed).toContain('Reply failed · Permission denied');
    // 1 on t0's prompt outcome ("Reply failed · Permission denied") + 1 standalone notice for promptless t1
    expect(collapsed.match(/Permission denied/g)).toHaveLength(2);
  });

  it('wraps long key-value /status lines in TranscriptNoteComponent with hanging indentation', () => {
    const note = new TranscriptNoteComponent(
      'Working directory: /Users/example/projects/workspace/apps/kimi-code/src/tui/daemon',
    );
    const rendered = note.render(56).map(strip).filter((line) => line.trim().length > 0);
    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered[0]).toMatch(/^ {2}Working directory: \/Users\/example\/projects\/workspace\/$/);
    expect(rendered[1]).toBe(`${' '.repeat(21)}apps/kimi-code/src/tui/daemon`);
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(56);
    }
  });

  it('pumps bounded tool and shell continuations on Ctrl+O expand, surfaces side-channel notes, and releases leases on collapse (#67, #68)', () => {
    const released: string[] = [];
    let contentRevision = 1;
    let toolOutput = `${'0'.repeat(1024)}`;
    let shellOutput = `BEGIN_ISSUE6_LINES\n${'x'.repeat(1005)}`;
    const toolFrameSource = { kind: 'frame' as const, id: 'f-tool', turnId: 't0', stepId: 's0' };
    const shellFrameSource = { kind: 'frame' as const, id: 'f-shell', turnId: 't0', stepId: 's0' };
    let toolRefs = [
      {
        source: toolFrameSource,
        revision: 'rev-1',
        path: ['output'],
        kind: 'text' as const,
        direction: 'forward' as const,
        offset: 1024,
        total: 2048,
      },
    ];
    let shellRefs = [
      {
        source: shellFrameSource,
        revision: 'rev-1',
        path: ['output'],
        kind: 'text' as const,
        direction: 'forward' as const,
        offset: 1024,
        total: 4096,
      },
    ];
    const notesByToolId = new Map<string, string>([
      [
        'call_edit_1',
        'Note: stale.txt changed on disk since you last read it; the edit was applied because the text it replaced still matched exactly.',
      ],
    ]);
    const hydratedNotes = new Map<string, string>();

    const controller: ContentContinuationController = {
      beginContentRead(agentId, source, roots) {
        const key = `${agentId}:${source.kind}:${source.id}:${roots.join(',')}`;
        if (source.id === 'f-tool') {
          toolOutput = `${'0'.repeat(1024)}\nEND_TOOL_CONTINUATION`;
          toolRefs = [];
          contentRevision += 1;
        } else if (source.id === 'f-shell') {
          shellOutput = `BEGIN_ISSUE6_LINES\n${'x'.repeat(1005)}\nEND_ISSUE6_LINES`;
          shellRefs = [];
          contentRevision += 1;
        }
        return {
          release() {
            released.push(key);
          },
          retry() {},
        };
      },
      contentRefsFor(_agentId, source) {
        if (source.kind === 'frame' && source.id === 'f-tool') return toolRefs;
        if (source.kind === 'frame' && source.id === 'f-shell') return shellRefs;
        return [];
      },
      isContentRange() {
        return false;
      },
      async readContentRange() {
        return '';
      },
      async loadTranscriptDetail() {
        return true;
      },
      async lookupToolCall(_agentId, toolCallId) {
        const note = notesByToolId.get(toolCallId);
        if (note !== undefined) {
          hydratedNotes.set(toolCallId, note);
          contentRevision += 1;
          return { status: 'found', frame: { note } };
        }
        return { status: 'found', frame: {} };
      },
      getToolCallDetail(_agentId, toolCallId) {
        const note = hydratedNotes.get(toolCallId);
        return note === undefined ? undefined : { status: 'found', frame: { note } };
      },
      getContentRevision() {
        return contentRevision;
      },
    };

    const manager = new DaemonContentContinuationManager();
    manager.setTarget(controller, 'main');
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);

    const currentBlocks = (): Block[] => [
      {
        kind: 'tool',
        id: 'block-edit',
        frameId: 'f-edit',
        stepId: 's0',
        turnId: 't0',
        toolCallId: 'call_edit_1',
        name: 'Edit',
        argsText: '{"path":"stale.txt","old_string":"a","new_string":"b"}',
        args: { path: 'stale.txt', old_string: 'a', new_string: 'b' },
        display: undefined,
        description: undefined,
        status: 'done',
        output: 'Edited stale.txt',
        isError: false,
        durationMs: 10,
        progressText: undefined,
      },
      {
        kind: 'tool',
        id: 'block-wait',
        frameId: 'f-tool',
        stepId: 's0',
        turnId: 't0',
        toolCallId: 'call_wait_1',
        name: 'TaskWait',
        argsText: '{"timeout":5}',
        args: { timeout: 5 },
        display: undefined,
        description: undefined,
        status: 'done',
        output: toolOutput,
        outputPending: toolRefs.length > 0,
        isError: false,
        durationMs: 20,
        progressText: undefined,
      },
      {
        kind: 'shell',
        id: 'block-shell',
        frameId: 'f-shell',
        stepId: 's0',
        turnId: 't0',
        commandId: 'call_bash_1',
        command: 'seq 1 5000',
        output: shellOutput,
        done: true,
        isError: false,
      },
    ];

    const syncView = () => {
      const blocks = currentBlocks();
      manager.syncBlocks(blocks);
      renderer.sync(blocks, {
        toolMetaRevision: manager.getRevision(),
        resolveBlockMeta: (block) => manager.resolveBlockMeta(block),
      });
    };

    syncView();
    const collapsedOut = strip(container.render(120).join('\n'));
    expect(collapsedOut).toContain('stale.txt changed on disk since you last read it');
    expect(collapsedOut).not.toContain('END_TOOL_CONTINUATION');
    expect(collapsedOut).not.toContain('END_ISSUE6_LINES');
    expect(released).toEqual([]);

    manager.setExpanded(true);
    renderer.setExpanded(true);
    syncView();
    syncView();

    const expandedOut = strip(container.render(120).join('\n'));
    expect(expandedOut).toContain('END_TOOL_CONTINUATION');
    expect(expandedOut).toContain('BEGIN_ISSUE6_LINES');
    expect(expandedOut).toContain('END_ISSUE6_LINES');

    manager.setExpanded(false);
    renderer.setExpanded(false);
    expect(released).toEqual([
      'main:frame:f-tool:output,error,note',
      'main:frame:f-shell:output,error,note',
    ]);
    renderer.dispose();
  });

  it('auto-folds single settled thinking and single settled tool blocks, supports individual MouseRoutable fold toggle, and surfaces only failures without leaking completed thinking', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const frame = (width = 100) => strip(container.render(width).join('\n'));
    const mkTool = (id: string, path: string, turnId: string, status: 'done' | 'error' = 'done'): Block => ({
      kind: 'tool',
      id,
      toolCallId: id,
      name: 'Read',
      turnId,
      args: { path },
      argsText: '',
      display: undefined,
      description: undefined,
      status,
      output: status === 'error' ? `${path} does not exist` : `content-of-${path}`,
      isError: status === 'error',
      durationMs: 10,
      progressText: undefined,
    });

    renderer.sync([
      { kind: 'user', id: 'u1', turnId: 't1', text: 'One-word reply', createdAt: '' },
      { kind: 'thinking', id: 'th1', turnId: 't1', text: 'Secret chain of thought line 1\nSecret line 2', streaming: false, createdAt: undefined },
      { kind: 'assistant', id: 'a1', turnId: 't1', text: 'pong', streaming: false, createdAt: undefined },

      { kind: 'user', id: 'u2', turnId: 't2', text: 'Read alpha', createdAt: '' },
      mkTool('tool-single', 'alpha.txt', 't2'),
      { kind: 'assistant', id: 'a2', turnId: 't2', text: '42', streaming: false, createdAt: undefined },

      { kind: 'user', id: 'u3', turnId: 't3', text: 'Read three with error', createdAt: '' },
      { kind: 'thinking', id: 'th3', turnId: 't3', text: 'Turn 3 private reasoning', streaming: false, createdAt: undefined },
      mkTool('tool-ok-1', 'alpha.txt', 't3'),
      mkTool('tool-ok-2', 'beta.txt', 't3'),
      mkTool('tool-err-3', 'missing.txt', 't3', 'error'),
      { kind: 'assistant', id: 'a3', turnId: 't3', text: 'missing.txt is absent', streaming: false, createdAt: undefined },
    ]);

    const compact = frame();
    expect(compact).toContain('▸ Thought: Secret chain of thought line 1');
    expect(compact).not.toContain('Secret line 2');
    expect(compact).toContain('▸ Worked · 1 step · read alpha.txt');
    expect(compact).not.toContain('content-of-alpha.txt');
    expect(compact).toContain('▸ Worked · 3 steps · 1 thought · 1 failed');
    expect(compact).toContain('missing.txt does not exist');
    expect(compact).not.toContain('Used Read (beta.txt)');

    // Clicking only the first fold (▸ Thought) expands just turn 1 without affecting turn 2 or turn 3.
    const thoughtSummary = container.children.find((child) => strip(child.render(100).join('\n')).includes('▸ Thought')) as {
      routeMouse?: (event: { leftClick: boolean }, line: number, col: number) => boolean;
    };
    expect(typeof thoughtSummary?.routeMouse).toBe('function');
    expect(thoughtSummary.routeMouse!({ leftClick: true }, 0, 4)).toBe(true);
    const afterClick = frame();
    expect(afterClick).toContain('▾ Thought: Secret chain of thought line 1');
    expect(afterClick).toContain('Secret line 2');
    expect(afterClick).toContain('▸ Worked · 1 step · read alpha.txt');

    // Clicking the same header collapses turn 1 back cleanly.
    expect(thoughtSummary.routeMouse!({ leftClick: true }, 0, 4)).toBe(true);
    expect(frame()).toContain('▸ Thought: Secret chain of thought line 1');
    expect(frame()).not.toContain('Secret line 2');
  });

  it('summarizes live subagent-group and historical media-run cleanly and supports click expand', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const frame = () => strip(container.render(100).join('\n'));
    const mkSub = (id: string, name: string, status: 'running' | 'completed' | 'failed'): Block => ({
      kind: 'subagent',
      id: `sub-${id}`,
      subagentId: id,
      parentAgentId: 'main',
      parentToolCallId: `call-${id}`,
      parentTurnId: 't2',
      name,
      description: `Task for ${name}`,
      model: undefined,
      thinkingEffort: undefined,
      status,
      summary: status === 'completed' ? `${name} done` : undefined,
      error: status === 'failed' ? `${name} crashed` : undefined,
      endedAt: undefined,
      toolCallCount: 1,
      transcript: [],
    });
    const mediaTool = (id: string, path: string, turnId: string): Block => ({
      kind: 'tool',
      id,
      toolCallId: id,
      name: 'ReadMediaFile',
      turnId,
      args: { path },
      argsText: '',
      display: undefined,
      description: undefined,
      status: 'done',
      output: undefined,
      media: [{ kind: 'image', fileId: `file-${id}`, name: path, mime: 'image/png' }],
      isError: false,
      durationMs: 12,
      progressText: undefined,
    });

    renderer.sync(
      [
        { kind: 'user', id: 'u1', turnId: 't1', text: 'Inspect image', createdAt: '' },
        mediaTool('m1', 'shot.png', 't1'),
        mediaTool('m2', 'chart.png', 't1'),
        { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Looked at both.', streaming: false, createdAt: undefined },
        { kind: 'user', id: 'u2', turnId: 't2', text: 'Run agents', createdAt: '' },
        mkSub('a1', 'explore', 'completed'),
        mkSub('a2', 'reviewer', 'running'),
        mkSub('a3', 'worker', 'failed'),
      ],
      { liveTurnId: 't2' },
    );

    const compact = frame();
    expect(compact).toContain('▸ Viewed · 2 images · shot.png, chart.png');
    // Live subagent group renders readable per-child rows for active & failed peers rather than squashing them.
    expect(compact).toContain('▾ Agents · 3 (1 active, 1 done, 1 failed)');
    expect(compact).toContain('reviewer');
    expect(compact).toContain('Task for reviewer');
    expect(compact).toContain('worker');
    expect(compact).toContain('worker crashed');
    expect(compact).toContain('1 finished peer');
    expect(compact).not.toContain('Task for explore');

    // Clicking the live group header collapses healthy active rows while still keeping failure visible.
    const liveGroup = container.children.find((child) => strip(child.render(100).join('\n')).includes('▾ Agents ·')) as {
      routeMouse?: (event: { leftClick: boolean }, line: number, col: number) => boolean;
    };
    expect(liveGroup.routeMouse!({ leftClick: true }, 1, 4)).toBe(true);
    const collapsedAgents = frame();
    expect(collapsedAgents).toContain('▸ Agents · 3 (1 active, 1 done, 1 failed)');
    expect(collapsedAgents).toContain('worker crashed');
    expect(collapsedAgents).not.toContain('Task for reviewer');
  });

  it('gates forest failure status and error to the latest subagent card when a resumed subagent fails later', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container);
    const frame = () => strip(container.render(100).join('\n'));
    const mkSub = (
      id: string,
      subagentId: string,
      parentTurnId: string,
      name: string,
      status: 'completed' | 'failed',
      description: string,
      error?: string,
    ): Block => ({
      kind: 'subagent',
      id,
      subagentId,
      parentAgentId: 'main',
      parentToolCallId: `call-${id}`,
      parentTurnId,
      name,
      description,
      model: undefined,
      thinkingEffort: undefined,
      status,
      summary: status === 'completed' ? `${name} done` : undefined,
      error,
      endedAt: undefined,
      toolCallCount: 1,
      transcript: [],
    });

    renderer.sync(
      [
        { kind: 'user', id: 'u1', turnId: 't1', text: 'First run', createdAt: '' },
        mkSub('card-0', 'agent-other-1', 't1', 'explore', 'completed', 'Explore step'),
        mkSub('card-0b', 'agent-other-2', 't1', 'reviewer', 'completed', 'Review step'),
        mkSub('card-1', 'agent-reused', 't1', 'worker', 'completed', 'Initial run succeeded'),
        { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Done first.', streaming: false, createdAt: undefined },
        { kind: 'user', id: 'u2', turnId: 't2', text: 'Resume run', createdAt: '' },
        mkSub('card-2', 'agent-reused', 't2', 'worker', 'failed', 'Resumed run failed', 'boom on resume'),
        { kind: 'assistant', id: 'a2', turnId: 't2', text: 'Failed second.', streaming: false, createdAt: undefined },
      ],
      {
        liveTurnId: 't2',
        forest: {
          byId: {
            'agent-reused': {
              id: 'agent-reused',
              parentId: 'main',
              name: 'worker',
              status: 'failed',
              error: 'boom on resume',
              children: [],
            },
          },
          rootIds: ['agent-reused'],
        } as never,
      },
    );

    const output = frame();
    expect(output).toContain('▸ Worked · 3 agents');
    expect(output).not.toContain('Initial run succeeded');
    expect(output).toContain('Resumed run failed');
    expect(output).toContain('✗');

    const workedSummary = container.children.find((child) => strip(child.render(100).join('\n')).includes('▸ Worked ·')) as {
      routeMouse?: (event: { leftClick: boolean }, line: number, col: number) => boolean;
    };
    expect(workedSummary.routeMouse!({ leftClick: true }, 0, 4)).toBe(true);
    const expanded = frame();
    expect(expanded).toContain('✓ worker · Initial run succeeded');
    expect(expanded).toContain('▸ ✗ worker · Resumed run failed');
  });
});

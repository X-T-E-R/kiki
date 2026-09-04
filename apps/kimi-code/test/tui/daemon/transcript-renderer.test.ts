import { Container } from '@moonshot-ai/pi-tui';
import type { Block } from '@kiki/session-core/session/transcript/types';
import { describe, expect, it } from 'vitest';

import { adaptQuestionResponse } from '#/tui/interactions/question-adapter';
import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { createBlockComponent, DaemonTranscriptRenderer } from '#/tui/daemon/transcript-renderer';

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
});

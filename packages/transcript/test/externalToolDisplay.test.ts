import { describe, expect, it } from 'vitest';

import {
  externalToolKindConflicts,
  normalizeStoredExternalToolDisplay,
  projectExternalToolDisplay,
} from '#/facts/externalToolDisplay';
import { TranscriptFactReducer } from '#/facts/reducer';
import { TranscriptWireAdapter, type TranscriptWireRecord } from '#/facts/wireAdapter';
import { AgentTranscript } from '#/store/agentTranscript';

const viewInput = { AbsolutePath: '/workspace/example/file.ts' };
const commandInput = { CommandLine: 'rg -n tool src', Cwd: '/workspace/example' };

function replay(records: readonly TranscriptWireRecord[]): AgentTranscript {
  const transcript = new AgentTranscript('main');
  const reducer = new TranscriptFactReducer(transcript);
  const adapter = new TranscriptWireAdapter('main');
  for (const record of records) reducer.apply(adapter.add(record));
  return transcript;
}

function toolFrame(transcript: AgentTranscript, toolCallId: string) {
  return transcript.getTurn('t1')?.steps.flatMap((step) => step.frames).find(
    (frame): frame is Extract<typeof frame, { kind: 'tool' }> => frame.kind === 'tool' && frame.toolCallId === toolCallId,
  );
}

describe('projectExternalToolDisplay', () => {
  it('projects the AGY tool shapes that were stored as generic', () => {
    expect(projectExternalToolDisplay({
      name: 'view_file', title: 'view_file', kind: 'other', rawInput: viewInput, summary: 'view_file',
    })).toEqual({ kind: 'file_io', operation: 'read', path: '/workspace/example/file.ts' });
    expect(projectExternalToolDisplay({
      name: 'read_file', title: 'read_file', kind: 'other', rawInput: { Path: '/workspace/example/file.ts' }, summary: 'read_file',
    })).toEqual({ kind: 'file_io', operation: 'read', path: '/workspace/example/file.ts' });
    expect(projectExternalToolDisplay({
      name: 'run_command', title: 'run_command', kind: 'other', rawInput: commandInput, summary: 'run_command',
    })).toEqual({ kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' });
    expect(projectExternalToolDisplay({
      name: 'grep_search', title: 'grep_search', kind: 'other', rawInput: { Query: 'tool', SearchPath: '/workspace/example' }, summary: 'grep_search',
    })).toEqual({ kind: 'search', query: 'tool', scope: '/workspace/example' });
    expect(projectExternalToolDisplay({
      name: 'find_by_name', title: 'find_by_name', kind: 'other', rawInput: { Pattern: '*.ts', SearchDirectory: '/workspace/example' }, summary: 'find_by_name',
    })).toEqual({ kind: 'search', query: '*.ts', scope: '/workspace/example' });
    expect(projectExternalToolDisplay({
      name: 'replace_file_content', title: 'replace_file_content', kind: 'other',
      rawInput: { TargetFile: '/workspace/example/file.ts', TargetContent: 'old line', ReplacementContent: 'new line' },
      summary: 'replace_file_content',
    })).toEqual({ kind: 'file_io', operation: 'edit', path: '/workspace/example/file.ts', before: 'old line', after: 'new line' });
    expect(projectExternalToolDisplay({
      name: 'multi_replace_file_content', title: 'multi_replace_file_content', kind: 'other',
      rawInput: {
        TargetFile: '/workspace/example/file.ts',
        ReplacementChunks: [
          { TargetContent: 'alpha', ReplacementContent: 'beta' },
          { TargetContent: 'one', ReplacementContent: 'two' },
        ],
      },
      summary: 'multi_replace_file_content',
    })).toEqual({
      kind: 'generic',
      summary: '/workspace/example/file.ts',
      detail: {
        diffs: [
          { path: '/workspace/example/file.ts', before: 'alpha', after: 'beta' },
          { path: '/workspace/example/file.ts', before: 'one', after: 'two' },
        ],
      },
    });
    expect(projectExternalToolDisplay({
      name: 'write_file', title: 'write_file', kind: 'other',
      rawInput: { Path: '/workspace/example/out.ts', Content: 'export {}\n' },
      summary: 'write_file',
    })).toEqual({ kind: 'file_io', operation: 'write', path: '/workspace/example/out.ts', content: 'export {}\n' });
    expect(projectExternalToolDisplay({
      name: 'edit_file', title: 'edit_file', kind: 'other',
      rawInput: { Path: '/workspace/example/file.ts', Target: 'remove me\n', Replacement: '' },
      summary: 'edit_file',
    })).toEqual({ kind: 'file_io', operation: 'edit', path: '/workspace/example/file.ts', before: 'remove me\n', after: '' });
  });

  it('keeps a conflicting kind and an unknown tool generic', () => {
    expect(externalToolKindConflicts({ name: 'grep', kind: 'execute' })).toBe(true);
    expect(externalToolKindConflicts({ name: 'view_file', kind: 'other' })).toBe(false);
    expect(projectExternalToolDisplay({
      name: 'grep', title: 'grep', kind: 'execute', rawInput: { pattern: 'x', command: 'rg x' }, summary: 'grep',
    })).toEqual({ kind: 'generic', summary: 'grep' });
    expect(normalizeStoredExternalToolDisplay(
      { kind: 'generic', summary: 'widget' },
      { name: 'widget', kind: 'other', rawInput: { widget: { id: 7 } } },
    )).toEqual({ kind: 'generic', summary: 'widget' });
  });

  it('marks a multi-file change as an edit and a multi-file read as a read', () => {
    const paths = ['/workspace/example/a.ts', '/workspace/example/b.ts'];
    expect(projectExternalToolDisplay({
      title: 'File change', kind: 'file', summary: 'File change',
      rawInput: paths.map((path) => ({ path })),
    })).toEqual({ kind: 'generic', summary: paths.join(', '), detail: { paths, operation: 'edit' } });
    expect(projectExternalToolDisplay({
      name: 'view_file', title: 'view_file', kind: 'read', summary: 'view_file',
      locations: paths.map((path) => ({ path })),
    })).toEqual({ kind: 'generic', summary: paths.join(', '), detail: { paths, operation: 'read' } });
    expect(normalizeStoredExternalToolDisplay(
      { kind: 'generic', summary: paths.join(', '), detail: { paths } },
      { title: 'File change', kind: 'file', rawInput: paths.map((path) => ({ path })) },
    )).toEqual({ kind: 'generic', summary: paths.join(', '), detail: { paths, operation: 'edit' } });
  });

  it('does not replace a display that is already native', () => {
    const stored = { kind: 'command', command: 'pwd' };
    expect(normalizeStoredExternalToolDisplay(stored, {
      name: 'view_file', kind: 'other', rawInput: viewInput,
    })).toBe(stored);
  });
});

describe('cold generic external wire', () => {
  const output = {
    kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'run_command',
    remoteToolCallId: 'call-run', remoteSessionId: 'remote-session',
    rawInput: commandInput, text: 'running', status: 'in_progress',
  };
  const records: TranscriptWireRecord[] = [
    { type: 'context.append_loop_event', time: 1, event: { type: 'step.begin', uuid: 'step-1', turnId: '1', step: 1 } },
    {
      type: 'context.append_loop_event', time: 2, event: {
        type: 'tool.call', stepUuid: 'step-1', toolCallId: 'external:agy:view', name: 'view_file', turnId: '1',
        args: viewInput,
        extras: { kind: 'other', display: { kind: 'generic', summary: 'view_file', detail: { kind: 'other' } } },
      },
    },
    {
      type: 'executor.tool.display', time: 3, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:view',
      name: 'view_file', state: 'done', input: viewInput,
      display: { kind: 'generic', summary: 'view_file' },
      output: { ...output, title: 'view_file', rawInput: viewInput, text: 'file', status: 'completed' },
    },
    {
      type: 'context.append_loop_event', time: 4, event: {
        type: 'tool.call', stepUuid: 'step-1', toolCallId: 'external:agy:run', name: 'run_command', turnId: '1',
        args: commandInput,
        extras: { kind: 'other', display: { kind: 'generic', summary: 'run_command', detail: { kind: 'other' } } },
      },
    },
    {
      type: 'executor.tool.display', time: 5, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:run',
      name: 'run_command', state: 'running', input: commandInput,
      display: { kind: 'generic', summary: 'run_command' }, output,
    },
    {
      type: 'executor.tool.display', time: 6, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:run',
      name: 'run_command', state: 'error', input: commandInput,
      display: { kind: 'generic', summary: 'run_command' },
      output: { ...output, text: 'exit 1', status: 'failed', rawOutput: { kept: true } },
    },
    {
      type: 'executor.tool.display', time: 7, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:stop',
      name: 'run_command', state: 'interrupted', input: commandInput,
      display: { kind: 'generic', summary: 'run_command' },
      output: { ...output, text: 'partial', status: 'cancelled' },
    },
    {
      type: 'executor.tool.display', time: 8, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:widget',
      name: 'widget', state: 'done', input: { widget: { id: 7 } },
      display: { kind: 'generic', summary: 'widget', detail: { kind: 'other' } },
      output: { kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'widget', text: 'nope', rawInput: { widget: { id: 7 } } },
    },
    {
      type: 'executor.tool.display', time: 9, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:typed',
      name: 'Bash', state: 'done', input: { command: 'pwd' },
      display: { kind: 'command', command: 'pwd' },
      output: { text: 'ok' },
    },
    {
      type: 'executor.tool.display', time: 10, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:diffs',
      name: 'replace_file_content', state: 'done', input: {},
      display: { kind: 'generic', summary: 'replace_file_content' },
      output: {
        kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'replace_file_content',
        content: [
          { type: 'diff', path: '/workspace/example/a.ts', oldText: 'a', newText: 'b' },
          { type: 'diff', path: '/workspace/example/b.ts', oldText: 'c', newText: 'd' },
        ],
      },
    },
    {
      type: 'executor.tool.display', time: 11, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:replace-input',
      name: 'replace_file_content', state: 'done',
      input: { TargetFile: '/workspace/example/c.ts', TargetContent: 'before', ReplacementContent: 'after' },
      display: { kind: 'generic', summary: 'replace_file_content' },
      output: {
        kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'replace_file_content',
        text: 'updated', status: 'completed',
      },
    },
    {
      type: 'executor.tool.display', time: 12, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:carried-input',
      name: 'edit_file', state: 'running',
      input: { Path: '/workspace/example/d.ts', Target: 'old', Replacement: 'new' },
      display: { kind: 'generic', summary: 'edit_file' },
      output: {
        kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'edit_file',
        rawInput: { Path: '/workspace/example/d.ts', Target: 'old', Replacement: 'new' }, status: 'in_progress',
      },
    },
    {
      type: 'executor.tool.display', time: 13, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:carried-input',
      name: 'edit_file', state: 'done',
      display: { kind: 'generic', summary: 'edit_file' },
      output: {
        kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'edit_file',
        text: 'patched', status: 'completed',
      },
    },
    {
      type: 'executor.tool.display', time: 14, turnId: 1, stepId: 'step-1', toolCallId: 'external:agy:missing-input',
      name: 'read_file', state: 'done',
      display: { kind: 'generic', summary: 'read_file' },
      output: {
        kind: 'external_tool_output', protocol: 'acp-v1', toolKind: 'other', title: 'read_file',
        text: 'contents without recorded input', status: 'completed',
      },
    },
  ];

  it('recovers native rows from a generic wire without rewriting the record', () => {
    const source = records[2]!;
    const before = JSON.stringify(source);
    const transcript = replay(records);
    expect(JSON.stringify(source)).toBe(before);
    expect(toolFrame(transcript, 'external:agy:view')).toMatchObject({
      name: 'view_file', state: 'done', input: viewInput,
      display: { kind: 'file_io', operation: 'read', path: '/workspace/example/file.ts' },
      output: { text: 'file', rawInput: viewInput, status: 'completed' },
    });
    expect(toolFrame(transcript, 'external:agy:run')).toMatchObject({
      name: 'run_command', state: 'error', input: commandInput,
      display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
      output: { text: 'exit 1', status: 'failed', rawInput: commandInput, rawOutput: { kept: true } },
    });
    expect(toolFrame(transcript, 'external:agy:stop')).toMatchObject({
      state: 'interrupted',
      display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
      output: { text: 'partial', status: 'cancelled', rawInput: commandInput },
    });
    expect(toolFrame(transcript, 'external:agy:widget')).toMatchObject({
      name: 'widget',
      display: { kind: 'generic', summary: 'widget', detail: { kind: 'other' } },
      output: { text: 'nope', rawInput: { widget: { id: 7 } } },
    });
    expect(toolFrame(transcript, 'external:agy:typed')).toMatchObject({ display: { kind: 'command', command: 'pwd' } });
    expect(toolFrame(transcript, 'external:agy:diffs')).toMatchObject({
      display: {
        kind: 'generic',
        summary: '/workspace/example/a.ts, /workspace/example/b.ts',
        detail: {
          diffs: [
            { path: '/workspace/example/a.ts', before: 'a', after: 'b' },
            { path: '/workspace/example/b.ts', before: 'c', after: 'd' },
          ],
        },
      },
    });
    expect(toolFrame(transcript, 'external:agy:replace-input')).toMatchObject({
      display: {
        kind: 'file_io',
        operation: 'edit',
        path: '/workspace/example/c.ts',
        before: 'before',
        after: 'after',
      },
    });
    expect(toolFrame(transcript, 'external:agy:carried-input')).toMatchObject({
      name: 'edit_file',
      state: 'done',
      input: { Path: '/workspace/example/d.ts', Target: 'old', Replacement: 'new' },
      display: {
        kind: 'file_io',
        operation: 'edit',
        path: '/workspace/example/d.ts',
        before: 'old',
        after: 'new',
      },
      output: { text: 'patched', status: 'completed' },
    });
    expect(toolFrame(transcript, 'external:agy:missing-input')).toMatchObject({
      name: 'read_file',
      state: 'done',
      display: { kind: 'generic', summary: 'read_file' },
      output: { text: 'contents without recorded input', status: 'completed' },
    });
    expect(toolFrame(transcript, 'external:agy:missing-input')?.input).toBeUndefined();
    expect(replay(records).snapshot()).toEqual(transcript.snapshot());
  });
});

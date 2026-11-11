import { describe, expect, it } from 'vitest';

import {
  codexApplyPatchToUnifiedDiff,
  codexUsageLimitResetAt,
  extractCodexShellOutput,
  extractStructuredFileDiffs,
  fileChangesToPreview,
  mapCodexNotification,
  mergeCodexRateLimits,
  normalizeCommandExecutionCommand,
  parseCodexFileChanges,
  parseCodexRateLimitSnapshot,
  parseCodexTurnOutcome,
  splitCodexMcpToolResultImages,
} from '../src/events';

describe('Codex notification mapping', () => {
  it.each(['agentMessage', 'reasoning', 'plan', 'userMessage'])(
    'drops recognized %s item starts without reporting unknown events',
    (type) => {
      expect(mapCodexNotification('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { id: 'item-1', type },
      }).events).toEqual([]);
    },
  );

  it('maps recognized tool item starts and completions', () => {
    expect(mapCodexNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 1,
      item: { id: 'command-1', type: 'commandExecution', command: 'echo test' },
    }).events).toEqual([
      expect.objectContaining({ type: 'tool.call', toolCallId: 'command-1' }),
    ]);
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'command-1', type: 'commandExecution', command: 'echo test', status: 'completed' },
    }).events).toEqual([
      expect.objectContaining({ type: 'tool.update', toolCallId: 'command-1', status: 'completed' }),
    ]);
  });

  it('unwraps Unix and Windows shell command envelopes and strips Chunk ID metadata headers', () => {
    expect(normalizeCommandExecutionCommand('/bin/zsh -lc "pnpm test"')).toBe('pnpm test');
    expect(normalizeCommandExecutionCommand(['bash', '-c', 'git status --short'])).toBe('git status --short');
    expect(normalizeCommandExecutionCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-ChildItem src"'))
      .toBe('Get-ChildItem src');
    expect(normalizeCommandExecutionCommand(['cmd.exe', '/c', '"echo ok"'])).toBe('echo ok');

    const wrapped = [
      'Chunk ID: f3d8a1',
      'Wall time: 0.1234 seconds',
      'Process exited with code 0',
      'Original token count: 14',
      'Output:',
      'hello world',
      'line two',
    ].join('\n');
    expect(extractCodexShellOutput(wrapped)).toBe('hello world\nline two');
    expect(extractCodexShellOutput('plain output')).toBe('plain output');

    const completed = mapCodexNotification('item/completed', {
      item: {
        id: 'cmd-envelope',
        type: 'commandExecution',
        command: ['/bin/zsh', '-lc', 'pnpm lint'],
        cwd: '/repo',
        exitCode: 1,
        status: 'completed',
        aggregatedOutput: wrapped,
      },
    }).events[0];
    expect(completed).toMatchObject({
      type: 'tool.update',
      toolCallId: 'cmd-envelope',
      title: 'pnpm lint',
      name: 'shell',
      kind: 'command',
      status: 'failed',
      rawOutput: 'hello world\nline two',
      locations: [{ path: '/repo' }],
    });
  });

  it('extracts multi-file structured diffs and bounded unified previews for fileChange and apply_patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/alpha.ts',
      '@@',
      ' const keep = true;',
      '-const oldVal = 1;',
      '+const newVal = 2;',
      '*** Add File: src/beta.ts',
      '+export const beta = 42;',
      '*** Delete File: src/legacy.ts',
      '-export const legacy = 0;',
      '*** End Patch',
    ].join('\n');

    const parsed = parseCodexFileChanges(patch);
    expect(parsed.map((entry) => ({ path: entry.path, kind: entry.kind }))).toEqual([
      { path: 'src/alpha.ts', kind: 'update' },
      { path: 'src/beta.ts', kind: 'add' },
      { path: 'src/legacy.ts', kind: 'delete' },
    ]);

    const diffs = extractStructuredFileDiffs(parsed);
    expect(diffs).toEqual([
      {
        type: 'diff',
        path: 'src/alpha.ts',
        oldText: 'const keep = true;\nconst oldVal = 1;',
        newText: 'const keep = true;\nconst newVal = 2;',
        movePath: undefined,
      },
      {
        type: 'diff',
        path: 'src/beta.ts',
        oldText: null,
        newText: 'export const beta = 42;',
        movePath: undefined,
      },
      {
        type: 'diff',
        path: 'src/legacy.ts',
        oldText: 'export const legacy = 0;',
        newText: '',
      },
    ]);

    const started = mapCodexNotification('item/started', {
      item: {
        id: 'fc-1',
        type: 'fileChange',
        changes: {
          'src/alpha.ts': { kind: 'update', diff: codexApplyPatchToUnifiedDiff('*** Update File: src/alpha.ts\n@@\n-old\n+new') },
          'src/beta.ts': { kind: 'add', content: 'export const b = 1;\n' },
        },
      },
    }).events[0];
    expect(started).toMatchObject({
      type: 'tool.call',
      toolCallId: 'fc-1',
      name: 'apply_patch',
      kind: 'file',
      title: 'File change (2 files)',
      locations: [{ path: 'src/alpha.ts' }, { path: 'src/beta.ts' }],
      content: [
        { type: 'diff', path: 'src/alpha.ts', oldText: 'old', newText: 'new' },
        { type: 'diff', path: 'src/beta.ts', oldText: null, newText: 'export const b = 1;\n' },
      ],
    });

    const hugeFiles = Array.from({ length: 6 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: 'add',
      diff: 'x'.repeat(500),
    }));
    const preview = fileChangesToPreview(hugeFiles, 450);
    expect(preview.unifiedDiff).toContain('diff --git a/src/file-0.ts b/src/file-0.ts');
    expect(preview.unifiedDiff).toContain('more files omitted]');
  });

  it('splits MCP embedded images into NormalizedExecutorContent while preserving approval refusal code', () => {
    const split = splitCodexMcpToolResultImages({
      content: [
        { type: 'text', text: 'Screenshot captured' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', uri: 'file:///shot.png' },
      ],
    });
    expect(split.images).toEqual([
      { mimeType: 'image/png', data: 'iVBORw0KGgo=', uri: 'file:///shot.png' },
    ]);
    expect(split.output).toEqual({
      content: [
        { type: 'text', text: 'Screenshot captured' },
        { type: 'text', text: '[image]' },
      ],
    });

    const completedWithImage = mapCodexNotification('item/completed', {
      item: {
        id: 'mcp-img',
        type: 'mcpToolCall',
        server: 'browser',
        tool: 'screenshot',
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: 'done' },
            { type: 'image', mimeType: 'image/png', data: 'YWJj' },
          ],
        },
      },
    }).events[0];
    expect(completedWithImage).toMatchObject({
      type: 'tool.update',
      toolCallId: 'mcp-img',
      name: 'mcp__browser__screenshot',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'done' }, { type: 'text', text: '[image]' }] },
      content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj', uri: undefined }],
    });

    const completed = (error: unknown) => mapCodexNotification('item/completed', {
      item: { id: 'mcp-1', type: 'mcpToolCall', server: 'kiki-harness', tool: 'kiki_list', status: 'failed', error },
    }).events[0];
    expect(completed({ message: 'MCP tool call requires approval, but approval policy is never' }))
      .toMatchObject({ type: 'tool.update', status: 'failed', errorCode: 'codex_mcp_approval_denied' });
    expect(completed({ message: 'tool crashed' })).toMatchObject({ status: 'failed', errorCode: undefined });
    expect(mapCodexNotification('item/completed', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'x', status: 'failed',
        error: { message: 'requires approval, but approval policy is never' } },
    }).events[0]).toMatchObject({ errorCode: undefined });
  });

  it('aggregates collabAgentToolCall child states and humanizes subAgentActivity paths', () => {
    const transient = mapCodexNotification('item/started', {
      item: {
        id: 'collab-1',
        type: 'collabAgentToolCall',
        tool: 'spawn_agent',
        prompt: 'Audit contract',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['child-1', 'child-2'],
        agentsStates: {
          'child-1': { status: 'completed' },
          'child-2': { status: 'errored' },
        },
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
      },
    }).events[0];
    expect(transient).toMatchObject({
      type: 'tool.call',
      toolCallId: 'collab-1',
      title: 'spawn_agent',
      status: 'in_progress',
      rawInput: expect.objectContaining({
        tool: 'spawn_agent',
        prompt: 'Audit contract',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['child-1', 'child-2'],
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
      }),
    });

    const failedChild = mapCodexNotification('item/completed', {
      item: {
        id: 'collab-2',
        type: 'collabAgentToolCall',
        tool: 'wait',
        agentsStates: { 'child-1': { status: 'notFound' } },
      },
    }).events[0];
    expect(failedChild).toMatchObject({ status: 'failed' });

    const subActivity = mapCodexNotification('item/started', {
      item: {
        id: 'sub-1',
        type: 'subAgentActivity',
        agentPath: '/root/code_reviewer/security_audit',
        agentThreadId: 'sub-thread-1',
        kind: 'interrupted',
      },
    }).events[0];
    expect(subActivity).toMatchObject({
      type: 'tool.call',
      title: 'Code reviewer / Security audit',
      status: 'cancelled',
      rawInput: expect.objectContaining({
        agent: 'Code reviewer / Security audit',
        prompt: 'code_reviewer/security_audit',
        agentThreadId: 'sub-thread-1',
      }),
    });
  });

  it('parses Codex rateLimits updates, merges partial snapshots, and extracts usageLimit turn outcomes', () => {
    const firstMapped = mapCodexNotification('account/rateLimits/updated', {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 100, resetsAt: 1_800_003_600, windowDurationMins: 10080 },
        },
      },
    });
    expect(firstMapped.rateLimits).toMatchObject({
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 100, resetsAt: 1_800_003_600 },
    });
    const merged = mergeCodexRateLimits(
      firstMapped.rateLimits,
      parseCodexRateLimitSnapshot({ limitId: 'other-service', primary: { usedPercent: 0, resetsAt: 1 } }),
    );
    expect(codexUsageLimitResetAt(merged)).toBe(new Date(1_800_003_600 * 1000).toISOString());

    const retry429 = parseCodexTurnOutcome(
      'failed',
      {
        message: 'Too many failed attempts',
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      },
      merged,
    );
    expect(retry429.usageLimit).toMatchObject({
      code: 'responseTooManyFailedAttempts',
      httpStatusCode: 429,
      resetAt: new Date(1_800_003_600 * 1000).toISOString(),
    });

    const sharingOutcome = parseCodexTurnOutcome(
      'failed',
      { message: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' },
      merged,
    );
    expect(sharingOutcome.usageLimit).toEqual({
      code: 'subscription_sharing_usage_limit_exceeded',
      message: 'Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.',
      httpStatusCode: 429,
      resetAt: undefined,
      resetAtMs: undefined,
    });
  });

  it('drops completed user echoes and maps completed agent messages', () => {
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'user-1', type: 'userMessage', text: 'echo' },
    }).events).toEqual([]);
    expect(mapCodexNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 2,
      item: { id: 'message-1', type: 'agentMessage', text: 'answer' },
    }).events).toEqual([{
      type: 'message.delta',
      role: 'assistant',
      messageId: 'message-1',
      content: { type: 'text', text: 'answer' },
    }]);
  });

  it('maps web search, collaboration, diff and compaction to timeline events', () => {
    for (const type of ['webSearch', 'collabAgentToolCall', 'subAgentActivity']) {
      expect(mapCodexNotification('item/started', {
        item: { id: 'tool-1', type, query: 'docs', input: { agent: 'reviewer', prompt: 'check' } },
      }).events).toEqual([expect.objectContaining({ type: 'tool.call', toolCallId: 'tool-1' })]);
    }
    expect(mapCodexNotification('turn/diff/updated', { diff: '--- a/file' }).events)
      .toEqual([{ type: 'turn.diff', diff: '--- a/file' }]);
    expect(mapCodexNotification('thread/compacted', { threadId: 'thread-1' }).events)
      .toEqual([{ type: 'context.compacted', threadId: 'thread-1' }]);
  });

  it('maps Codex lifecycle and terminal errors to runtime session facts', () => {
    expect(mapCodexNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }).events)
      .toEqual([{ type: 'session.info', meta: {
        source: 'codex-app-server', updateType: 'turn/started', status: 'running', turnId: 'turn-1',
      } }]);
    expect(mapCodexNotification('thread/status/changed', {
      threadId: 'thread-1', status: { type: 'active' },
    }).events).toEqual([{ type: 'session.info', meta: {
      source: 'codex-app-server', updateType: 'thread/status/changed', status: 'active',
    } }]);
    expect(mapCodexNotification('error', {
      threadId: 'thread-1', error: { message: 'upstream unavailable' }, willRetry: false,
    }).events).toEqual([{ type: 'session.info', meta: {
      source: 'codex-app-server', updateType: 'error', error: 'upstream unavailable', willRetry: false,
      errorCode: undefined, usageLimit: undefined,
    } }]);
  });

  it('uses per-turn usage from Codex token usage updates', () => {
    expect(mapCodexNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 },
        last: { totalTokens: 12, inputTokens: 8, cachedInputTokens: 2, outputTokens: 4 },
        modelContextWindow: 100,
      },
    })).toMatchObject({
      events: [{ type: 'usage', used: 12, size: 100 }],
      usage: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 4 },
    });
  });

  it.each(['functionCallOutput', 'hookPrompt', 'imageGeneration', 'contextCompaction'])(
    'reports unsupported %s item boundaries as unknown events',
    (type) => {
      expect(mapCodexNotification('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { id: 'item-1', type },
      }).events).toEqual([{ type: 'unknown', updateType: `item/started:${type}` }]);
      expect(mapCodexNotification('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { id: 'item-1', type },
      }).events).toEqual([{ type: 'unknown', updateType: `item/completed:${type}` }]);
    },
  );
});

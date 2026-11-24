import { PassThrough, Readable, Writable } from 'node:stream';

import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentApp,
  type InitializeResponse,
  type PermissionOption,
  type RequestPermissionRequest,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ANTIGRAVITY_EDIT_DIFF_OMITTED,
  AcpProcessClient,
  antigravityCommandOutlivesPrompt,
  antigravityEditPatch,
  antigravitySecurityWarning,
  antigravitySessionMode,
  antigravitySubagentLaunches,
  antigravitySupportsEmbeddedContext,
  antigravitySupportsLogout,
  antigravitySupportsPromptSteering,
  antigravityToolOutlivesPrompt,
  boundAntigravityCommandLine,
  boundAntigravityCommandOutput,
  classifyAntigravitySubagentToolCall,
  isAntigravityManagedMcpRequest,
  isAntigravitySnippetPatch,
  isOfficialAntigravityAcpServer,
  makeAntigravityUpdateStepsPlans,
  normalizeAntigravitySessionUpdate,
  type HostProcessLike,
  type HostProcessServiceLike,
  type NormalizedExecutorEvent,
} from '../src/index';

function createAgentProcessService(setup: (app: AgentApp) => AgentApp): HostProcessServiceLike {
  return {
    spawn: async () => {
      const clientToAgent = new PassThrough();
      const agentToClient = new PassThrough();
      const stderr = new PassThrough();
      let exitCode: number | null = null;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const app = setup(agent({ name: 'test-antigravity-acp' }));
      app.connect(ndJsonStream(Writable.toWeb(agentToClient), Readable.toWeb(clientToAgent)));
      const finish = (): void => {
        if (exitCode !== null) return;
        exitCode = 0;
        clientToAgent.end();
        agentToClient.end();
        stderr.end();
        resolveExit(0);
      };
      return {
        pid: 4242,
        get exitCode() {
          return exitCode;
        },
        stdin: clientToAgent,
        stdout: agentToClient,
        stderr,
        wait: () => exited,
        kill: async () => {
          finish();
        },
        dispose: () => {
          finish();
        },
      } satisfies HostProcessLike;
    },
  };
}

async function collectEvents(iterable: AsyncIterable<NormalizedExecutorEvent>): Promise<NormalizedExecutorEvent[]> {
  const events: NormalizedExecutorEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('Antigravity ACP 1.5+ capability helpers and protocol normalization', () => {
  const init = (overrides: Partial<InitializeResponse> = {}): InitializeResponse => ({
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
    agentCapabilities: {
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      auth: { logout: {} },
    } as InitializeResponse['agentCapabilities'],
    ...overrides,
  });

  it('detects official Antigravity ACP Server >= 1.5.0 steering, embeddedContext, and logout', () => {
    expect(isOfficialAntigravityAcpServer(init())).toBe(true);
    expect(antigravitySupportsPromptSteering(init())).toBe(true);
    expect(antigravitySupportsPromptSteering(init({ agentInfo: { name: 'Antigravity ACP Server', version: '1.5.0' } }))).toBe(true);
    expect(antigravitySupportsPromptSteering(init({ agentInfo: { name: 'Antigravity ACP Server', version: '1.4.5' } }))).toBe(false);
    expect(antigravitySupportsPromptSteering(init({ agentInfo: { name: 'Other ACP Server', version: '2.0.0' } }))).toBe(false);
    expect(antigravitySupportsEmbeddedContext(init())).toBe(true);
    expect(antigravitySupportsLogout(init())).toBe(true);
    expect(antigravitySupportsLogout(init({
      agentCapabilities: { authCapabilities: { logout: true } } as unknown as InitializeResponse['agentCapabilities'],
    }))).toBe(true);
    expect(antigravitySupportsLogout(init({ agentCapabilities: {} }))).toBe(false);
  });

  it('maps permission modes safely for agy 1.5+ without crashing on unadvertised modes', () => {
    expect(antigravitySessionMode('kiki-managed', 'auto', ['default', 'auto'])).toBe('auto');
    expect(antigravitySessionMode('kiki-managed', 'auto', ['default'])).toBe('default');
    expect(antigravitySessionMode('kiki-managed', 'yolo', ['default', 'auto'])).toBe('default');
    expect(antigravitySessionMode('kiki-managed', 'auto_edit', ['default', 'auto'])).toBe('default');
    expect(antigravitySessionMode('agy-cli', 'yolo', ['default', 'accept-edits', 'auto', 'plan'])).toBe('auto');
    expect(antigravitySessionMode('agy-cli', 'auto_edit', ['default', 'accept-edits', 'auto', 'plan'])).toBe('accept-edits');
    expect(antigravitySessionMode('agy-cli', 'auto_edit', ['default', 'auto'])).toBe('default');
  });

  it('extracts bounded agy.security.warning and verifies managed MCP server identity strictly', () => {
    const option: PermissionOption = {
      optionId: 'allow-always',
      name: 'Allow always',
      kind: 'allow_always',
      _meta: { 'agy.security.warning': { title: 'Warning', message: 'Runs arbitrary shell commands without asking.' } },
    };
    expect(antigravitySecurityWarning(option)).toBe('Runs arbitrary shell commands without asking.');
    const longOption: PermissionOption = {
      ...option,
      _meta: { 'agy.security.warning': { message: 'x'.repeat(800) } },
    };
    expect(antigravitySecurityWarning(longOption)).toHaveLength(512);

    const directMatch: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: { toolCallId: 't1', title: 'Run mcp_kiki_leased_AgentRun?', rawInput: { prompt: 'hi' } },
      options: [],
    };
    expect(isAntigravityManagedMcpRequest(directMatch, 'kiki_leased')).toBe(true);
    expect(isAntigravityManagedMcpRequest(directMatch, 'other_server')).toBe(false);
    expect(isAntigravityManagedMcpRequest({
      ...directMatch,
      toolCall: { ...directMatch.toolCall, rawInput: { CommandLine: 'rm -rf /' } },
    }, 'kiki_leased')).toBe(false);

    const proxiedMatch: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: { toolCallId: 't2', title: 'MCP Tool MemoryRead?', rawInput: { ServerName: 'kiki_leased', ToolName: 'MemoryRead' } },
      options: [],
    };
    expect(isAntigravityManagedMcpRequest(proxiedMatch, 'kiki_leased')).toBe(true);
    expect(isAntigravityManagedMcpRequest(proxiedMatch, 'evil_server')).toBe(false);
  });

  it('projects Run update_steps into canonical ACP plan updates and drops status-only follow-ups', () => {
    const planProjector = makeAntigravityUpdateStepsPlans();
    const first = planProjector({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'steps-1',
        title: 'Run update_steps',
        kind: 'other',
        status: 'in_progress',
        rawInput: {
          steps: [
            { title: 'Inspect files', status: 'done' },
            { title: 'Write tests', status: 'in_progress' },
          ],
        },
      },
    });
    expect(first).toEqual({
      sessionId: 's1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect files', priority: 'medium', status: 'completed' },
          { content: 'Write tests', priority: 'medium', status: 'in_progress' },
        ],
      },
    });
    const followUp = planProjector({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'steps-1',
        status: 'completed',
      },
    });
    expect(followUp).toBeUndefined();
  });

  it('synthesizes line-numbered unified diffs from PascalCase and snake_case ReplacementChunks', () => {
    const sourceFile = [
      'line 1',
      'const a = 1;',
      'const dup = true;',
      'line 4',
      'const dup = true;',
      'line 6',
      'const tail = 9;',
    ].join('\n');

    const pascalPatch = antigravityEditPatch({
      path: 'src/app.ts',
      rawInput: {
        ReplacementChunks: [
          { TargetContent: 'const dup = true;', ReplacementContent: 'const dup = false;\nconst added = 2;', StartLine: 4, EndLine: 6 },
          { TargetContent: 'const tail = 9;', ReplacementContent: 'const tail = 10;' },
        ],
      },
      readPreEditFile: () => sourceFile,
    });
    expect(typeof pascalPatch).toBe('string');
    expect(isAntigravitySnippetPatch(pascalPatch as string)).toBe(false);
    expect(pascalPatch).toContain('@@ -5 +5,2 @@');
    expect(pascalPatch).toContain('-const dup = true;');
    expect(pascalPatch).toContain('+const dup = false;');
    expect(pascalPatch).toContain('+const added = 2;');
    expect(pascalPatch).toContain('@@ -7 +8 @@');

    const snakePatch = antigravityEditPatch({
      path: 'src/app.ts',
      rawInput: {
        replacement_chunks: [
          { target_content: 'const a = 1;', replacement_content: 'const a = 2;' },
        ],
      },
      readPreEditFile: () => sourceFile,
    });
    expect(snakePatch).toContain('@@ -2 +2 @@');
    expect(snakePatch).toContain('-const a = 1;');
    expect(snakePatch).toContain('+const a = 2;');

    const snippetPatch = antigravityEditPatch({
      path: 'src/app.ts',
      rawInput: { TargetContent: 'const a = 1;', ReplacementContent: 'const a = 2;' },
    });
    expect(typeof snippetPatch).toBe('string');
    expect(isAntigravitySnippetPatch(snippetPatch as string)).toBe(true);

    const mixedOmitted = antigravityEditPatch({
      path: 'src/app.ts',
      rawInput: {
        ReplacementChunks: [
          { TargetContent: 'const a = 1;', ReplacementContent: 'const a = 2;' },
          { TargetContent: 'missing line', ReplacementContent: 'other' },
        ],
      },
      readPreEditFile: () => sourceFile,
    });
    expect(mixedOmitted).toBe(ANTIGRAVITY_EDIT_DIFF_OMITTED);
  });

  it('bounds CommandLine by head, combinedOutput by tail, and strips toolSummary and system_message', () => {
    const longCmd = `git status ${'a'.repeat(9_000)} END_MARKER`;
    const boundedCmd = boundAntigravityCommandLine(longCmd);
    expect(boundedCmd.startsWith('git status ')).toBe(true);
    expect(boundedCmd.endsWith('\n\n[Command truncated]')).toBe(true);
    expect(boundedCmd).not.toContain('END_MARKER');

    const longOut = `START_MARKER ${'b'.repeat(9_000)} TAIL_MARKER`;
    const boundedOut = boundAntigravityCommandOutput(longOut);
    expect(boundedOut.startsWith('[Earlier output truncated]\n\n')).toBe(true);
    expect(boundedOut.endsWith('TAIL_MARKER')).toBe(true);
    expect(boundedOut).not.toContain('START_MARKER');

    const normalized = normalizeAntigravitySessionUpdate({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        kind: 'edit',
        status: 'pending',
        title: 'Edit<system_message>secret</system_message> file',
        rawInput: {
          toolSummary: 'redundant',
          Arguments: { toolSummary: 'nested-redundant', keep: 'ok' },
          TargetFile: 'a.ts',
          TargetContent: 'old',
          ReplacementContent: 'new',
        },
        content: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
      },
    }, { readPreEditFile: () => 'header\nold\nfooter' });

    expect(normalized.update.title).toBe('Edit file');
    expect(normalized.update.rawInput).not.toHaveProperty('toolSummary');
    expect((normalized.update.rawInput as Record<string, unknown>)['Arguments']).toEqual({ keep: 'ok' });
    const diffEntry = (normalized.update.content as Array<Record<string, unknown>>)[0];
    expect(diffEntry?.['patch']).toMatchObject({ text: expect.stringContaining('@@ -2 +2 @@') });
  });

  it('classifies subagent, schedule, and non-daemon command tool calls accurately', () => {
    expect(antigravityCommandOutlivesPrompt({ kind: 'execute', rawInput: { CommandLine: 'npm test' } })).toBe(true);
    expect(antigravityCommandOutlivesPrompt({ kind: 'execute', rawInput: { CommandLine: 'npm run dev', IsDaemon: true } })).toBe(false);
    expect(antigravityToolOutlivesPrompt({ kind: 'other', title: 'Run schedule' })).toBe(true);
    expect(classifyAntigravitySubagentToolCall({ kind: 'other', title: 'Run invoke_subagent' })).toBe('subagent');
    expect(classifyAntigravitySubagentToolCall({ kind: 'other', title: 'Run invoke_subagent', meta: { is_mcp_tool_call: true } })).toBe('mcp');
    expect(antigravitySubagentLaunches({ Role: 'researcher', Prompt: 'find docs' })).toEqual([
      { role: 'researcher', prompt: 'find docs' },
    ]);
  });
});

describe('AcpProcessClient Antigravity 1.5+ steering, usage aggregation, logout, and background hold', () => {
  it('steers mid-turn with P2 without session/cancel, retries once on busy error, and aggregates P1 + P2 usage', async () => {
    let promptCalls = 0;
    let cancelCount = 0;
    let resolveP1!: () => void;
    let resolveP2!: () => void;
    const p1Started = new Promise<void>((resolve) => {
      resolveP1 = resolve;
    });
    const p2Started = new Promise<void>((resolve) => {
      resolveP2 = resolve;
    });
    let finishP1!: (value: { stopReason: 'end_turn'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;
    let finishP2!: (value: { stopReason: 'end_turn'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;
    let logoutCalled = false;

    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            promptCapabilities: { image: true, audio: true, embeddedContext: true },
            auth: { logout: {} },
          } as InitializeResponse['agentCapabilities'],
        }))
        .onRequest(methods.agent.session.new, async ({ client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'compact', description: 'Compact context' }],
            },
          });
          return { sessionId: 'agy-1', configOptions: [], modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }] } };
        })
        .onRequest('logout', (p: unknown) => p, () => {
          logoutCalled = true;
          return {};
        })
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          promptCalls += 1;
          if (promptCalls === 1) {
            await client.notify(methods.client.session.update, {
              sessionId: 'agy-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P1:' } },
            });
            return await new Promise((resolve) => {
              finishP1 = resolve;
              resolveP1();
            });
          }
          if (promptCalls === 2) {
            throw new RequestError(-32603, 'Agent is already processing a prompt');
          }
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P2:done' } },
          });
          return await new Promise((resolve) => {
            finishP2 = resolve;
            resolveP2();
          });
        })
        .onNotification(methods.agent.session.cancel, () => {
          cancelCount += 1;
        }),
    );

    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      { platform: 'linux', antigravityHooks: { timing: { busyRetryMs: 10 } } },
    );

    try {
      const opened = await client.openSession({ cwd: '/workspace' });
      expect(client.supportsPromptSteering()).toBe(true);
      expect(opened.availableCommands).toEqual(['/compact']);

      const turn = await client.startTurn({
        prompt: 'first',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const eventsPromise = collectEvents(turn.events);
      await p1Started;

      const steered = await client.steer([{ type: 'text', text: 'steer now' }]);
      expect(steered).toBe(true);
      expect(cancelCount).toBe(0);

      finishP1({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
      await p2Started;

      finishP2({ stopReason: 'end_turn', usage: { inputTokens: 250, outputTokens: 40, totalTokens: 290 } });
      const [result, events] = await Promise.all([turn.completion, eventsPromise]);

      expect(promptCalls).toBe(3);
      expect(cancelCount).toBe(0);
      expect(result.response.usage).toEqual({ inputTokens: 350, outputTokens: 60, totalTokens: 410 });
      expect(result.promptUsages).toHaveLength(2);
      const texts = events.filter((e) => e.type === 'message.delta').map((e) => e.content.type === 'text' ? e.content.text : '');
      expect(texts).toEqual(['P1:', 'P2:done']);

      expect(await client.logout()).toBe(true);
      expect(logoutCalled).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  it('holds turn open when non-daemon command or detached subagent outlives prompt and captures autonomous wake', async () => {
    let agentClient: { notify: (method: string, params: unknown) => Promise<void> } | undefined;
    let subagentDone = false;

    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: { loadSession: true },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-bg', configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          agentClient = client;
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-bg',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'cmd-1',
              title: 'Run command',
              kind: 'execute',
              status: 'in_progress',
              rawInput: { CommandLine: 'sleep 1' },
            },
          });
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-bg',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'sub-1',
              title: 'Run invoke_subagent',
              kind: 'other',
              status: 'completed',
              rawInput: { Role: 'worker', Prompt: 'audit' },
            },
          });
          return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
        }),
    );

    const childrenAtWork = vi.fn(async (_sessionId: string, toolCallIds: readonly string[]) => ({
      activeToolCallIds: subagentDone ? [] : [...toolCallIds],
      incomplete: false,
    }));

    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      {
        platform: 'linux',
        antigravityHooks: {
          childrenAtWork,
          hasPendingReply: async () => false,
          timing: { terminalDebounceMs: 25, openReplySilenceMs: 200, silentCommandCapMs: 500, subagentPollIntervalMs: 15 },
        },
      },
    );

    try {
      const turn = await client.startTurn({
        prompt: 'start background work',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const eventsPromise = collectEvents(turn.events);

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(client.status().state).toBe('prompting');

      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', status: 'completed' },
      });
      subagentDone = true;
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'autonomous reply' } },
      });
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg',
        update: { sessionUpdate: 'usage_update', used: 500, size: 100_000 },
      });

      const [result, events] = await Promise.all([turn.completion, eventsPromise]);
      expect(result.response.stopReason).toBe('end_turn');
      expect(events.some((e) => e.type === 'message.delta' && e.content.type === 'text' && e.content.text === 'autonomous reply')).toBe(true);
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      expect(client.status().state).toBe('ready');
    } finally {
      await client.shutdown();
    }
  });

  it('cleanly cancels a held background turn and sends session/cancel', async () => {
    let cancelCount = 0;
    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: {},
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-cancel', configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-cancel',
            update: { sessionUpdate: 'tool_call', toolCallId: 'sched-1', title: 'Run schedule', kind: 'other', status: 'in_progress' },
          });
          return { stopReason: 'end_turn' };
        })
        .onNotification(methods.agent.session.cancel, () => {
          cancelCount += 1;
        }),
    );

    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      { platform: 'linux', antigravityHooks: { timing: { terminalDebounceMs: 2_000, silentCommandCapMs: 5_000 } } },
    );

    try {
      const turn = await client.startTurn({
        prompt: 'wait',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const eventsPromise = collectEvents(turn.events);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(client.status().state).toBe('prompting');

      await turn.cancel('stop');
      const [result] = await Promise.all([turn.completion, eventsPromise]);
      expect(cancelCount).toBe(1);
      expect(result.response.stopReason).toBe('cancelled');
    } finally {
      await client.shutdown();
    }
  });

  it('rejects embedded context blocks when agent does not advertise embeddedContext', async () => {
    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: { promptCapabilities: { image: true, embeddedContext: false } },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-no-ctx', configOptions: [] })),
    );
    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      { platform: 'linux' },
    );
    try {
      await expect(client.startTurn({
        prompt: 'read pdf',
        attachments: [{ type: 'resource_link', uri: 'file:///tmp/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }],
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      })).rejects.toThrow(/embedded context/);

      await client.retireSession('poisoned');
      expect(client.status().state).toBe('cold');
      expect(client.sessionRef()).toBeUndefined();
      const reopened = await client.openSession({ cwd: '/workspace' });
      expect(reopened.mode).toBe('new');
      expect(reopened.sessionId).toBe('agy-no-ctx');
    } finally {
      await client.shutdown();
    }
  });

  it('does not finalize a turn when P2 steer advances promptSequence while P1 awaits hasPendingReply', async () => {
    let promptCalls = 0;
    let resolvePendingCheck!: (value: boolean) => void;
    let pendingCheckStarted!: () => void;
    const pendingWaiting = new Promise<void>((resolve) => {
      pendingCheckStarted = resolve;
    });
    let resolveP2Started!: () => void;
    const p2Started = new Promise<void>((resolve) => {
      resolveP2Started = resolve;
    });
    let finishP2!: (value: { stopReason: 'end_turn'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;

    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: { loadSession: true },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-f2', configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          promptCalls += 1;
          if (promptCalls === 1) {
            await client.notify(methods.client.session.update, {
              sessionId: 'agy-f2',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P1:' } },
            });
            return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 15, totalTokens: 115 } };
          }
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-f2',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'P2:survived' } },
          });
          return await new Promise((resolve) => {
            finishP2 = resolve;
            resolveP2Started();
          });
        }),
    );

    let pendingCalls = 0;
    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      {
        platform: 'linux',
        antigravityHooks: {
          hasPendingReply: async () => {
            pendingCalls += 1;
            if (pendingCalls === 1) {
              pendingCheckStarted();
              return await new Promise<boolean>((resolve) => {
                resolvePendingCheck = resolve;
              });
            }
            return false;
          },
        },
      },
    );

    try {
      const turn = await client.startTurn({
        prompt: 'first',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const eventsPromise = collectEvents(turn.events);
      await pendingWaiting;

      const steered = await client.steer([{ type: 'text', text: 'second' }]);
      expect(steered).toBe(true);
      await p2Started;

      resolvePendingCheck(false);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(client.status().state).toBe('prompting');

      finishP2({ stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 35, totalTokens: 235 } });
      const [result, events] = await Promise.all([turn.completion, eventsPromise]);
      expect(result.response.usage).toEqual({ inputTokens: 300, outputTokens: 50, totalTokens: 350 });
      expect(result.promptUsages).toHaveLength(2);
      const texts = events.filter((e) => e.type === 'message.delta').map((e) => e.content.type === 'text' ? e.content.text : '');
      expect(texts).toEqual(['P1:', 'P2:survived']);
    } finally {
      await client.shutdown();
    }
  });

  it('holds conservatively within bounded openReplySilenceMs when childrenAtWork scan is incomplete', async () => {
    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: { loadSession: true },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-f3a', configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: 'agy-f3a',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'sub-trunc',
              title: 'Run invoke_subagent',
              kind: 'other',
              status: 'completed',
              rawInput: { Role: 'worker', Prompt: 'deep scan' },
            },
          });
          return { stopReason: 'end_turn' };
        }),
    );

    const childrenAtWork = vi.fn(async () => ({ activeToolCallIds: [], incomplete: true }));
    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      {
        platform: 'linux',
        antigravityHooks: {
          childrenAtWork,
          hasPendingReply: async () => false,
          timing: { terminalDebounceMs: 15, openReplySilenceMs: 90, silentCommandCapMs: 500, subagentPollIntervalMs: 15 },
        },
      },
    );

    try {
      const startedAt = Date.now();
      const turn = await client.startTurn({
        prompt: 'launch many',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const eventsPromise = collectEvents(turn.events);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(client.status().state).toBe('prompting');

      const [result] = await Promise.all([turn.completion, eventsPromise]);
      const elapsed = Date.now() - startedAt;
      expect(result.response.stopReason).toBe('end_turn');
      expect(elapsed).toBeGreaterThanOrEqual(75);
      expect(elapsed).toBeLessThan(1_000);
      expect(childrenAtWork.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.shutdown();
    }
  });

  it('times out a stuck hasPendingReply artifact at openReplySilenceMs without resetting the deadline on unchanged polls', async () => {
    const processes = createAgentProcessService((app) =>
      app
        .onRequest(methods.agent.initialize, ({ params }) => ({
          protocolVersion: params.protocolVersion,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
          agentCapabilities: { loadSession: true },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-f3b', configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async () => ({ stopReason: 'end_turn' })),
    );

    const hasPendingReply = vi.fn(async () => true);
    const client = new AcpProcessClient(
      processes,
      { id: 'antigravity-acp', sourceId: 'antigravity-acp', command: 'agy', args: ['acp'] },
      {
        platform: 'linux',
        antigravityHooks: {
          hasPendingReply,
          timing: { terminalDebounceMs: 15, openReplySilenceMs: 80, silentCommandCapMs: 500, subagentPollIntervalMs: 12 },
        },
      },
    );

    try {
      const startedAt = Date.now();
      const turn = await client.startTurn({
        prompt: 'stuck pending reply',
        signal: new AbortController().signal,
        session: { cwd: '/workspace' },
      });
      const [result] = await Promise.all([turn.completion, collectEvents(turn.events)]);
      const elapsed = Date.now() - startedAt;
      expect(result.response.stopReason).toBe('end_turn');
      expect(elapsed).toBeGreaterThanOrEqual(65);
      expect(elapsed).toBeLessThan(1_000);
      expect(hasPendingReply.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await client.shutdown();
    }
  });
});

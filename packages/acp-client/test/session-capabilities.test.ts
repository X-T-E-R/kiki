import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { AcpProcessClient } from '../src/client';
import type { HostProcessLike } from '../src/types';

import {
  createInProcessScriptedAgent,
  type InProcessAgentScript,
} from './fixtures/in-process-scripted-agent';

function scriptedChild(): {
  child: HostProcessLike;
  toAgent: PassThrough;
  fromAgent: PassThrough;
} {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const child: HostProcessLike = {
    pid: 42,
    get exitCode() {
      return exitCode;
    },
    stdin: toAgent,
    stdout: fromAgent,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose: () => {},
  };
  return { child, toAgent, fromAgent };
}

async function openWithScriptedAgent(
  script: InProcessAgentScript,
  options: {
    additionalDirectories?: readonly string[];
    sessionRef?: unknown;
    systemPromptOverride?: string;
    sessionMeta?: Record<string, unknown>;
    contextHookHandler?: import('../src/types').AcpContextHookHandler;
    permissionHandler?: import('../src/types').AcpPermissionHandler;
    requireResume?: boolean;
    onFork?: import('../src/types').AcpOpenSessionOptions['onFork'];
  },
) {
  const { child, toAgent, fromAgent } = scriptedChild();
  const { app, history } = createInProcessScriptedAgent(script);
  const connection = app.connect(ndJsonStream(Writable.toWeb(fromAgent), Readable.toWeb(toAgent)));
  const client = new AcpProcessClient(
    { spawn: async () => child },
    { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
    { platform: 'linux', contextHookHandler: options.contextHookHandler, permissionHandler: options.permissionHandler },
  );
  try {
    const opened = await client.openSession({
      cwd: 'C:/workspace',
      additionalDirectories: options.additionalDirectories,
      sessionRef: options.sessionRef as never,
      systemPromptOverride: options.systemPromptOverride,
      sessionMeta: options.sessionMeta,
      requireResume: options.requireResume,
      onFork: options.onFork,
    });
    return { client, history, opened, connection };
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    throw error;
  }
}

describe('AcpProcessClient session capability negotiation', () => {
  it.each(['new', 'load'] as const)('preserves actual request and response metadata for %s and live reuse', async (mode) => {
    const sessionMeta = { 'kiki.permission': { requestId: 'this-open', override: { mode: 'yolo', source: 'runtime' }, restriction: undefined } };
    const wireMeta = JSON.parse(JSON.stringify(sessionMeta));
    const responseMeta = { 'kiki.permission': { sessionId: 'session-in-process', openMode: mode, applied: wireMeta['kiki.permission'] } };
    const { client, opened } = await openWithScriptedAgent({ capabilities: { loadSession: true }, sessionResponseMeta: responseMeta }, {
      sessionMeta, sessionRef: mode === 'load' ? { executorId: 'fixture', version: 1, ref: { sessionId: 'session-in-process' } } : undefined,
    });
    try {
      expect(opened.mode).toBe(mode);
      expect(opened.sessionRequestMeta).toStrictEqual(wireMeta);
      expect(opened.sessionResponseMeta).toEqual(responseMeta);
      const live = await client.openSession({ cwd: 'C:/workspace', sessionMeta: { 'kiki.permission': { requestId: 'not-sent-on-live-open' } } });
      expect(live.mode).toBe('live');
      expect(live.sessionRequestMeta).toStrictEqual(wireMeta);
      expect(live.sessionResponseMeta).toEqual(responseMeta);
    } finally { await client.shutdown(); }
  });
  it.each(['partial', 'explicit', 'explicit-null', 'other-session', 'next-turn'] as const)(
    'preserves scoped permission tool facts for %s requests', async (scenario) => {
      const script: InProcessAgentScript = {
        promptUpdates: [{ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Edit', kind: 'edit',
          status: 'pending', locations: [{ path: '/workspace/example.ts' }] }],
        permissionOptions: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
        permissionToolCall: { toolCallId: 'tool-1', title: 'Edit /workspace/example.ts',
          rawInput: { file_path: '/workspace/example.ts', old_string: 'before', new_string: 'after' },
          kind: scenario === 'explicit' ? 'read' : scenario === 'explicit-null' ? null : undefined,
          locations: scenario === 'explicit' ? [{ path: '/workspace/explicit.ts' }] : scenario === 'explicit-null' ? null : undefined },
        permissionSessionId: scenario === 'other-session' ? 'different-session' : undefined,
      };
      const requests: Parameters<import('../src/types').AcpPermissionHandler>[0][] = [];
      const { client, history } = await openWithScriptedAgent(script, {
        permissionHandler: (request) => {
          requests.push(request);
          return { outcome: 'selected', optionId: 'allow' };
        },
      });
      try {
        const run = async () => {
          const turn = await client.startTurn({ prompt: 'neutral fixture', signal: new AbortController().signal,
            session: { cwd: '/workspace' } });
          for await (const _event of turn.events) { }
          await turn.completion;
        };
        await run();
        if (scenario === 'next-turn') {
          Object.assign(script, { promptUpdates: [] });
          await run();
        }
        const request = requests.at(-1)!;
        expect(request.toolCall.rawInput).toEqual(script.permissionToolCall?.rawInput);
        expect(request.toolCall.title).toBe(script.permissionToolCall?.title);
        expect(request.toolCall.kind).toBe(scenario === 'partial' ? 'edit'
          : scenario === 'explicit' ? 'read' : scenario === 'explicit-null' ? null : undefined);
        expect(request.toolCall.locations).toEqual(scenario === 'partial' ? [{ path: '/workspace/example.ts' }]
          : scenario === 'explicit' ? [{ path: '/workspace/explicit.ts' }] : scenario === 'explicit-null' ? null : undefined);
        expect(history.permissionResponses.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      } finally { await client.shutdown(); }
    },
  );
  it('forwards current permission context on every prompt without reopening the session', async () => {
    const { client, history } = await openWithScriptedAgent({}, {});
    try {
      for (const permission of [{ version: 1, hostGate: false },
        { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' } }]) {
        const turn = await client.startTurn({ prompt: 'neutral fixture', signal: new AbortController().signal,
          session: { cwd: 'C:/workspace', sessionMeta: { 'kiki.permission': permission } } });
        for await (const _event of turn.events) { }
        await turn.completion;
      }
      expect(history.sessionNewParams).toHaveLength(1);
      expect(history.promptParams).toMatchObject([
        { _meta: { 'kiki.permission': { hostGate: false } } },
        { _meta: { 'kiki.permission': { hostGate: true, override: { mode: 'yolo', source: 'runtime' } } } },
      ]);
    } finally { await client.shutdown(); }
  });

  it('declares the boolean session config option capability it uses', async () => {
    const { client, history } = await openWithScriptedAgent({}, {});
    try {
      const initialize = history.initializeParams[0] as {
        clientCapabilities: { session?: { configOptions?: { boolean?: unknown } } };
      };
      expect(initialize.clientCapabilities.session?.configOptions?.boolean).toEqual({});
    } finally {
      await client.shutdown();
    }
  });

  it('omits additional directories when the agent does not declare support for them', async () => {
    const { client, history } = await openWithScriptedAgent(
      { capabilities: {} },
      { additionalDirectories: ['C:/shared'] },
    );
    try {
      expect(history.sessionNewParams[0]).not.toHaveProperty('additionalDirectories');
    } finally {
      await client.shutdown();
    }
  });

  it('sends additional directories when the agent declares support for them', async () => {
    const { client, history } = await openWithScriptedAgent(
      { capabilities: { sessionCapabilities: { additionalDirectories: {} } } },
      { additionalDirectories: ['C:/shared'] },
    );
    try {
      expect(history.sessionNewParams[0]).toMatchObject({
        additionalDirectories: ['C:/shared'],
      });
    } finally {
      await client.shutdown();
    }
  });

  it('treats resume:null as unsupported and falls back through the open chain', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: null } } },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
      },
    );
    try {
      expect(opened.mode).toBe('load');
      expect(history.methods).not.toContain('session/resume');
      expect(history.methods).toContain('session/load');
      expect(history.sessionNewParams).toHaveLength(0);
    } finally {
      await client.shutdown();
    }
  });

  it.each(['resume', 'load'] as const)('strict continuation uses %s with the external ID rather than creating a new session', async (mode) => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: mode === 'resume' ? { resume: {} } : {} } },
      { requireResume: true, sessionRef: { executorId: 'fixture', version: 1, ref: { sessionId: 'foreign-thread' } } },
    );
    try {
      expect(opened.mode).toBe(mode);
      expect(opened.sessionId).toBe('foreign-thread');
      expect(mode === 'resume' ? history.sessionResumeParams : history.sessionLoadParams).toEqual([
        expect.objectContaining({ sessionId: 'foreign-thread', cwd: 'C:/workspace' }),
      ]);
      expect(history.sessionNewParams).toHaveLength(0);
    } finally { await client.shutdown(); }
  });

  it.each(['unsupported', 'unknown_session'] as const)('strict continuation rejects %s instead of silently falling back to session/new', async (failure) => {
    const histories: Array<ReturnType<typeof createInProcessScriptedAgent>['history']> = [];
    const client = new AcpProcessClient({ spawn: async () => {
      const { child, toAgent, fromAgent } = scriptedChild();
      const fixture = createInProcessScriptedAgent(failure === 'unsupported' ? { capabilities: {} }
        : { resume: 'unknown_session', load: 'unknown_session' });
      histories.push(fixture.history);
      fixture.app.connect(ndJsonStream(Writable.toWeb(fromAgent), Readable.toWeb(toAgent)));
      return child;
    } }, { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 }, { platform: 'linux' });
    try {
      await expect(client.openSession({ cwd: 'C:/workspace', requireResume: true,
        sessionRef: { executorId: 'fixture', version: 1, ref: { sessionId: 'foreign-thread' } } }))
        .rejects.toMatchObject({ code: 'executor.session_open_failed' });
      expect(histories.length).toBeGreaterThan(0);
      expect(histories.every((history) => history.sessionNewParams.length === 0)).toBe(true);
    } finally { await client.shutdown(); }
  });

  it('attempts session/resume when the agent declares resume support', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: {} } } },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
      },
    );
    try {
      expect(opened.mode).toBe('resume');
      expect(history.methods).toContain('session/resume');
    } finally {
      await client.shutdown();
    }
  });

  it('admits only the known context callback for the opened remote session', async () => {
    const events: string[] = [];
    const { client, opened, connection } = await openWithScriptedAgent({}, {
      contextHookHandler: async (event) => { events.push(event); return { additionalContext: 'Fixture working notes' }; },
    });
    const input = { sessionId: opened.sessionId, hookCallbackId: 'kiki-context', hookEventName: 'stop' };
    try {
      expect(await connection.client.request('_x.ai/hooks/run', input)).toEqual({ additionalContext: 'Fixture working notes' });
      expect(await connection.client.request('_x.ai/hooks/run', { ...input, sessionId: 'another-session' })).toEqual({});
      await expect(connection.client.request('_x.ai/hooks/run', { ...input, hookCallbackId: 'unknown-hook' })).rejects.toThrow();
      await expect(connection.client.request('_x.ai/hooks/run', { ...input, hookEventName: 'pre_tool_use' })).rejects.toThrow();
      expect(events).toEqual(['Stop']);
    } finally { await client.shutdown(); }
  });

  it('attaches a system prompt override to session/new through _meta', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      {},
      { systemPromptOverride: 'Frozen profile text' },
    );
    try {
      expect(opened.mode).toBe('new');
      expect(history.sessionNewParams[0]).toMatchObject({
        _meta: { systemPromptOverride: 'Frozen profile text' },
      });
    } finally {
      await client.shutdown();
    }
  });

  it.each(['new', 'resume', 'load'] as const)('passes process-local harness metadata through session/%s', async (mode) => {
    const sessionMeta = { pluginDirs: ['/tmp/context-plugin'], claudeCode: { options: { settings: '/tmp/context-settings.json' } } };
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: mode === 'resume' ? { resume: {} } : {} } },
      { sessionMeta, ...(mode === 'new' ? { systemPromptOverride: 'Frozen profile text' } : {
        sessionRef: { executorId: 'fixture', version: 1, ref: { sessionId: 'session-in-process' } },
      }) },
    );
    try {
      expect(opened.mode).toBe(mode);
      const params = mode === 'new' ? history.sessionNewParams : mode === 'resume' ? history.sessionResumeParams : history.sessionLoadParams;
      expect(params[0]).toMatchObject({ _meta: { ...sessionMeta, ...(mode === 'new' ? { systemPromptOverride: 'Frozen profile text' } : {}) } });
      expect(sessionMeta).not.toHaveProperty('systemPromptOverride');
    } finally { await client.shutdown(); }
  });

  it('omits _meta from session/new when no override is requested', async () => {
    const { client, history } = await openWithScriptedAgent({}, {});
    try {
      expect(history.sessionNewParams[0]).not.toHaveProperty('_meta');
    } finally {
      await client.shutdown();
    }
  });

  it.each([
    ['manual', 'manual'],
    ['auto', 'auto'],
    [undefined, undefined],
  ])('returns only a witnessed session mode update (%s -> %s)', async (modeUpdate, expected) => {
    const { client, history } = await openWithScriptedAgent({ modeUpdate }, {});
    try {
      const configured = await client.configureSession({ modeId: 'manual' });
      expect(configured.currentModeId).toBe(expected);
      expect(history.methods).toContain('session/set_mode');
    } finally {
      await client.shutdown();
    }
  });

  it.each([
    [{ value: 'manual' }, 'manual'],
    [{ value: 'auto' }, 'auto'],
    [{ value: 'manual', sessionId: 'another-session' }, undefined],
  ])('accepts the current session mode witnessed through config options (%j)', async (modeConfigUpdate, expected) => {
    const { client } = await openWithScriptedAgent({ modeConfigUpdate }, {});
    try {
      const configured = await client.configureSession({ modeId: 'manual' });
      expect(configured.currentModeId).toBe(expected);
      if (expected !== undefined) expect(configured.configOptions.find(option => option.category === 'mode')?.currentValue).toBe(expected);
    } finally {
      await client.shutdown();
    }
  });

  it.each([
    [{}, 'resume'],
    [{ resume: 'method_not_found' as const }, 'load'],
    [{ resume: 'unknown_session' as const, load: 'unknown_session' as const }, 'new'],
  ] as const)('attaches the override only when the fallback open mode is %s', async (script, expectedMode) => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, ...script },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
        systemPromptOverride: 'Frozen profile text',
      },
    );
    try {
      expect(opened.mode).toBe(expectedMode);
      expect(history.sessionResumeParams[0]).not.toHaveProperty('_meta');
      if (expectedMode !== 'resume') expect(history.sessionLoadParams[0]).not.toHaveProperty('_meta');
      if (expectedMode === 'new') {
        expect(history.sessionNewParams[0]).toMatchObject({
          _meta: { systemPromptOverride: 'Frozen profile text' },
        });
      } else {
        expect(history.sessionNewParams).toHaveLength(0);
      }
    } finally {
      await client.shutdown();
    }
  });
});


describe('ACP fork isolation', () => {
  const point = { version: 1, messageId: 'kiki-message-2', messageFingerprint: `sha256:${'a'.repeat(64)}`, messageOccurrence: 2 };
  const sessionRef = { executorId: 'fixture', version: 1, ref: { sessionId: 'source-session', kikiFork: { point } } };

  it('forks at the donor AIR point, persists the new reference before resuming, and never resumes the source', async () => {
    const saved: unknown[] = [];
    const { client, history, opened } = await openWithScriptedAgent({
      capabilities: { sessionCapabilities: { fork: {}, resume: {} } },
    }, { sessionRef, onFork: async (ref) => { saved.push(ref); } });
    try {
      expect(history.methods).toEqual(['initialize', 'session/fork', 'session/resume']);
      expect(history.sessionForkParams[0]).toEqual({ sessionId: 'source-session', cwd: 'C:/workspace', _meta: { jetbrains: { air: { fork: point } } } });
      expect(history.sessionForkParams[0]).not.toHaveProperty('mcpServers');
      expect(history.sessionResumeParams[0]).toMatchObject({ sessionId: 'forked-session', mcpServers: [] });
      expect(opened.sessionRef.ref).toEqual({ sessionId: 'forked-session' });
      expect(saved).toEqual([opened.sessionRef]);
    } finally { await client.shutdown(); }
  });

  it('passes MCP servers at fork creation when the harness cannot resume the new session', async () => {
    const { client, history, opened } = await openWithScriptedAgent({ capabilities: { sessionCapabilities: { fork: {} } } }, { sessionRef });
    try {
      expect(history.methods).toEqual(['initialize', 'session/fork']);
      expect(history.sessionForkParams[0]).toMatchObject({ sessionId: 'source-session', mcpServers: [] });
      expect(opened.sessionId).toBe('forked-session');
    } finally { await client.shutdown(); }
  });

  it('opens a fresh session instead of reusing the source when fork is not advertised', async () => {
    const { client, history, opened } = await openWithScriptedAgent({ capabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }, { sessionRef });
    try {
      expect(history.methods).toEqual(['initialize', 'session/new']);
      expect(opened.mode).toBe('new');
    } finally { await client.shutdown(); }
  });

  it('persists the fork even when subsequent resume fails', async () => {
    const saved: unknown[] = [];
    await expect(openWithScriptedAgent({ capabilities: { sessionCapabilities: { fork: {}, resume: {} } }, resume: 'unknown_session' }, {
      sessionRef, onFork: async (ref) => { saved.push(ref); },
    })).rejects.toThrow();
    expect(saved).toEqual([{ executorId: 'fixture', version: 1, ref: { sessionId: 'forked-session' } }]);
  }, 15_000);
});

async function whenPrompting(methods: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!methods.includes('session/prompt')) {
    if (Date.now() > deadline) throw new Error('scripted prompt did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('AcpProcessClient steering consumption', () => {
  const steeringMeta = { steering: { supported: true } };

  async function duringPrompt(outcome: InProcessAgentScript['steeringOutcome']) {
    const opened = await openWithScriptedAgent({
      hangPrompt: true,
      initializeMeta: steeringMeta,
      steeringOutcome: outcome,
    }, {});
    const turn = await opened.client.startTurn({
      prompt: 'work',
      signal: new AbortController().signal,
      session: { cwd: 'C:/workspace' },
    });
    void turn.completion.catch(() => undefined);
    await whenPrompting(opened.history.methods);
    return { ...opened, turn };
  }

  it('does not send a steering request or start another turn when the adapter advertises unsupported', async () => {
    const { client, history } = await openWithScriptedAgent({
      hangPrompt: true,
      initializeMeta: { steering: { supported: false } },
      steeringOutcome: 'injected',
    }, {});
    const turn = await client.startTurn({
      prompt: 'work', signal: new AbortController().signal, session: { cwd: 'C:/workspace' },
    });
    void turn.completion.catch(() => undefined);
    try {
      await whenPrompting(history.methods);
      const before = [...history.methods];
      await expect(client.steer([{ type: 'text', text: 'later' }])).resolves.toBe(false);
      expect(history.methods).toEqual(before);
      expect(history.steeringParams).toEqual([]);
    } finally {
      await turn.cancel();
      await client.shutdown();
    }
  });

  it('acks an injected steering prompt', async () => {
    const { client, history, turn } = await duringPrompt('injected');
    try {
      await expect(client.steer([{ type: 'text', text: 'later' }])).resolves.toBe(true);
      expect(history.steeringParams).toEqual([expect.objectContaining({
        prompt: [{ type: 'text', text: 'later' }],
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      })]);
    } finally {
      await turn.cancel();
      await client.shutdown();
    }
  });

  it('acks a started turn once and then stops steering that session', async () => {
    const { client, history, turn } = await duringPrompt('startedNewTurn');
    try {
      await expect(client.steer([{ type: 'text', text: 'later' }])).resolves.toBe(true);
      await expect(client.steer([{ type: 'text', text: 'again' }])).resolves.toBe(false);
      expect(history.steeringParams).toHaveLength(1);
    } finally {
      await turn.cancel();
      await client.shutdown();
    }
  });

  it('reports a steering request lost when the connection closes as unknown', async () => {
    const { client } = await duringPrompt('hang');
    const pending = client.steer([{ type: 'text', text: 'later' }]);
    await client.shutdown();
    await expect(pending).resolves.toBe('unknown');
  });

  it('reports an adapter delivery-unknown steering outcome as unknown so it is not replayed', async () => {
    const { client, turn } = await duringPrompt('deliveryUnknown');
    try {
      await expect(client.steer([{ type: 'text', text: 'later' }])).resolves.toBe('unknown');
    } finally {
      await turn.cancel();
      await client.shutdown();
    }
  });

  it.each(['promptRequired', 'unknown', 'reject', 'abort'] as const)('leaves %s unconsumed', async (outcome) => {
    const { client, turn } = await duringPrompt(outcome);
    try {
      await expect(client.steer([{ type: 'text', text: 'later' }])).resolves.toBe(false);
    } finally {
      await turn.cancel();
      await client.shutdown();
    }
  });
});

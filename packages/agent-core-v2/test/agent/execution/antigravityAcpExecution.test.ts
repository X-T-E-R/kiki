import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import type {
  AcpOpenSessionOptions,
  AcpOpenSessionResult,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpSessionConfigOption,
  AcpTurnHandle,
  AcpTurnRequest,
  AcpTurnResult,
  NormalizedExecutorEvent,
} from '@kiki/acp-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { AcpAgentExecutorSession } from '#/agent/execution/acpAgentExecutorSession';
import { resolveAcpAttachments } from '#/agent/execution/externalAttachments';
import {
  ExecutorSessionUpdated,
  externalExecutorKey,
  type ExternalExecutorState,
} from '#/agent/execution/externalExecutorOps';
import { turnKey } from '#/agent/loop/turnOps';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentUsageService } from '#/agent/usage/usage';
import {
  agentExecutorBindingFingerprint,
  IAgentExecutorRegistry,
  type AgentExecutorContext,
} from '#/app/agentExecutor/agentExecutor';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHarnessMcpService } from '#/app/agentExecutor/harnessMcp';
import type { Event2 } from '#/app/event/event2';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionApprovalService, type ApprovalRequest, type ApprovalResponse } from '#/session/approval/approval';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionQuestionService } from '#/session/question/question';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { stubBootstrap } from '../../app/bootstrap/stubs';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const scratch = join(process.cwd(), '.tmp');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function createAntigravitySessionHarness(options: {
  readonly runtimeId?: string;
  readonly workDir?: string;
  readonly homeDir?: string;
  readonly permissionMode?: 'manual' | 'auto' | 'yolo';
  readonly availableModes?: readonly string[];
  readonly availableCommands?: readonly string[];
  readonly embeddedContext?: boolean;
  readonly leasedMcpServerName?: string;
  readonly history?: readonly ContextMessage[];
  readonly priorState?: ExternalExecutorState;
  readonly onStartTurn?: (
    request: AcpTurnRequest,
    helpers: {
      readonly permissionHandler: AcpPermissionHandler;
      readonly emit: (event: NormalizedExecutorEvent) => void;
    },
  ) => Promise<AcpTurnResult>;
  readonly onSteer?: (blocks: readonly unknown[]) => Promise<boolean>;
  readonly approval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
}) {
  const workDir = options.workDir ?? '/workspace';
  const runtimeId = options.runtimeId ?? 'local';
  const opens: AcpOpenSessionOptions[] = [];
  const configuredModes: string[] = [];
  const starts: AcpTurnRequest[] = [];
  const approvalRequests: ApprovalRequest[] = [];
  const usageRecords: Parameters<IAgentUsageService['record']>[] = [];
  const recordedNegotiated: unknown[] = [];
  const events: Event2[] = [];
  const retireSpy = vi.fn(async () => {});
  let externalState: ExternalExecutorState = options.priorState ?? {};
  let nextSessionCounter = 1;
  let currentSessionId = 'agy-session-1';
  let currentModeId = 'default';
  let permissionHandler!: AcpPermissionHandler;

  const initialize: AcpOpenSessionResult['initialize'] = {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: options.embeddedContext ?? true,
      },
      auth: { logout: {} },
    } as AcpOpenSessionResult['initialize']['agentCapabilities'],
    _meta: { antigravity: { systemPrompt: { append: true } } },
  };

  const sessionConfigOptions: AcpSessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-3.1-pro',
      options: [{ value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }],
    },
    {
      id: 'thought',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];

  const binding: AgentExecutorContext['binding'] = {
    profileName: 'default',
    executorId: 'antigravity-acp',
    executorProtocol: 'acp-v1',
    executorDescriptorRevision: '2026-11-24.1',
    modelAlias: 'gemini-3.1-pro',
    thinkingLevel: 'high',
    thinkingEffortExplicit: true,
    systemPrompt: 'Frozen profile',
    injectKikiMcp: options.leasedMcpServerName !== undefined,
  };
  const bindingFingerprint = agentExecutorBindingFingerprint(binding);
  if (options.priorState !== undefined && options.priorState.bindingFingerprint === undefined) {
    externalState = { ...options.priorState, bindingFingerprint };
  }

  const descriptor: AgentExecutorContext['descriptor'] = {
    id: 'antigravity-acp',
    label: 'Google Antigravity ACP',
    protocol: 'acp-v1',
    command: 'agy',
    args: ['acp'],
    homeEnv: 'GEMINI_HOME',
    homeDir: options.homeDir,
    modelBinding: 'session_config',
    modelConfigCategory: 'model',
    thoughtConfigCategory: 'thought_level',
    supportsMcp: true,
    mcpTransports: ['stdio'],
    promptDeliveries: ['append', 'preamble'],
    permission: { via: 'session_mode', manual: 'default', auto: 'auto_edit', yolo: 'yolo' },
    revision: '2026-11-24.1',
    version: '1.5.8',
  };

  const dispatcher = {
    dispatch: async (event: Event2) => {
      events.push(event);
      if (event instanceof ExecutorSessionUpdated) {
        externalState = {
          executionGeneration: event.executionGeneration,
          executorId: event.executorId,
          descriptorRevision: event.descriptorRevision,
          bindingFingerprint: event.bindingFingerprint,
          sessionRef: event.sessionRef,
          sessionEpoch: event.sessionEpoch,
          profileDeliveredSessionId: event.profileDeliveredSessionId,
          profileDelivery: event.profileDelivery,
          lastCumulativeUsage: event.lastCumulativeUsage ?? externalState.lastCumulativeUsage,
        };
      }
    },
    flush: async () => {},
  };

  const registry = {
    recordNegotiated: (_id: string, _ver: string | undefined, caps: unknown) => {
      recordedNegotiated.push(caps);
    },
    negotiated: () => recordedNegotiated.at(-1),
  };

  const services = new Map<unknown, unknown>([
    [IAgentRuntimeService, {
      acquire: () => ({
        runtime: {
          identity: { workspaceId: 'ws', runtimeId, generation: 'gen-1' },
          process: { spawn: vi.fn() },
          workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
        },
        dispose: () => {},
      }),
    }],
    [ISessionWorkspaceContext, { workDir, additionalDirs: [] }],
    [IAgentStateService, {
      get: (key: unknown) => {
        if (key === externalExecutorKey) return externalState;
        if (key === turnKey) return { nextTurnId: 1, lastEnded: undefined };
        return {};
      },
    }],
    [IEventDispatcher, dispatcher],
    [IWireService, { flush: async () => {} }],
    [IAgentContextMemoryService, {
      get: () => options.history ?? [],
      appendLoopEvent: () => {},
      appendManaged: () => {},
    }],
    [IAgentUsageService, {
      record: (...args: Parameters<IAgentUsageService['record']>) => {
        usageRecords.push(args);
      },
    }],
    [IModelCatalog, { get: () => ({ providerName: 'google' }) }],
    [ISessionContext, { sessionId: 'kiki-sess-1', isPrivate: () => false }],
    [ISessionMetadata, { updateAgent: async () => {}, setGeneratedTitleIfUncustomized: async () => {} }],
    [ISessionInteractionService, { cancelPendingForTurn: () => {} }],
    [ISessionMcpHandle, { ready: Promise.resolve(), connectionManager: { list: () => [] } }],
    [IAgentPermissionModeService, { mode: options.permissionMode ?? 'manual', externalOverride: options.permissionMode }],
    [IAgentPermissionRulesService, { rules: [] }],
    [ISessionApprovalService, {
      request: async (req: ApprovalRequest) => {
        approvalRequests.push(req);
        return options.approval?.(req) ?? { decision: 'approved', selectedOptionId: 'allow-once' };
      },
    }],
    [ISessionQuestionService, { request: vi.fn() }],
    [IBootstrapService, stubBootstrap()],
    [IAgentExecutorRegistry, registry],
    [ISessionMediaStore, {
      resolveDisplayPath: async (fileId: string) => fileId,
      read: async () => undefined,
      open: async () => undefined,
      materialize: async () => undefined,
    }],
    [IHarnessMcpService, {
      acquire: async () => ({
        server: { name: options.leasedMcpServerName ?? 'kiki-leased', command: 'node', args: [], env: [] },
        dispose: () => {},
      }),
    }],
  ]);

  const context: AgentExecutorContext = {
    agent: {
      id: 'main',
      accessor: { get: <T>(id: unknown) => services.get(id) as T },
    },
    descriptor,
    binding,
  };

  const makeOpenResult = (mode: AcpOpenSessionResult['mode']): AcpOpenSessionResult => ({
    sessionId: currentSessionId,
    mode,
    initialize,
    capabilities: initialize.agentCapabilities ?? {},
    configOptions: sessionConfigOptions,
    currentModeId,
    availableModes: options.availableModes ?? ['default', 'auto'],
    availableCommands: options.availableCommands,
    sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: currentSessionId } },
    loadReplayObserved: false,
    quarantinedUpdateCount: 0,
  });

  const session = new AcpAgentExecutorSession(context, (_ps, permHandler) => {
    permissionHandler = permHandler;
    return {
      status: () => ({ state: 'ready', sessionId: currentSessionId }),
      supportsPromptSteering: () => true,
      advertisedCommands: () => options.availableCommands ?? [],
      retireSession: retireSpy,
      openSession: async (openOpts) => {
        opens.push(openOpts);
        if (openOpts.sessionRef === undefined) {
          currentSessionId = `agy-session-${nextSessionCounter++}`;
          return makeOpenResult('new');
        }
        currentSessionId = String(openOpts.sessionRef.ref['sessionId']);
        return makeOpenResult('resume');
      },
      configureSession: async (cfg) => {
        if (cfg.modeId !== undefined) {
          configuredModes.push(cfg.modeId);
          currentModeId = cfg.modeId;
        }
        return makeOpenResult('live');
      },
      startTurn: async (req) => {
        starts.push(req);
        const queued: NormalizedExecutorEvent[] = [];
        let completion!: Promise<AcpTurnResult>;
        if (options.onStartTurn !== undefined) {
          completion = options.onStartTurn(req, {
            permissionHandler,
            emit: (event) => queued.push(event),
          });
        } else {
          completion = Promise.resolve({
            response: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            session: makeOpenResult('live'),
            stderrTail: '',
          });
        }
        return {
          events: (async function* () {
            await completion.catch(() => undefined);
            for (const item of queued) yield item;
          })(),
          completion,
          cancel: async () => true,
        } satisfies AcpTurnHandle<NormalizedExecutorEvent>;
      },
      steer: async (blocks) => options.onSteer?.(blocks) ?? true,
      cancel: async () => true,
      shutdown: async () => {},
    };
  });

  return {
    session,
    opens,
    configuredModes,
    starts,
    approvalRequests,
    usageRecords,
    recordedNegotiated,
    events,
    retireSpy,
    getState: () => externalState,
  };
}

describe('AcpAgentExecutorSession Antigravity 1.5+ flagship bridge', () => {
  it('exposes negotiated 1.5+ capabilities, bypasses 60s tool wait on prompt steering, and records per-prompt usage without differencing', async () => {
    const steeredBlocks: unknown[] = [];
    let releaseTurn!: () => void;
    const toolEmitted = new Promise<void>((resolve) => {
      void resolve;
    });
    void toolEmitted;
    let notifyRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      notifyRunning = resolve;
    });

    const harness = createAntigravitySessionHarness({
      availableCommands: ['/compact'],
      onSteer: async (blocks) => {
        steeredBlocks.push(blocks);
        releaseTurn();
        return true;
      },
      onStartTurn: async (_req, { emit }) => {
        emit({ type: 'tool.call', toolCallId: 't-run', title: 'Long command', kind: 'execute', status: 'in_progress' });
        emit({ type: 'usage', used: 9000, size: 128000 });
        notifyRunning();
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return {
          response: { stopReason: 'end_turn', usage: { inputTokens: 350, outputTokens: 60, totalTokens: 410 } },
          session: {
            sessionId: 'agy-session-1',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });

    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      await running;

      const steered = await harness.session.steer({
        role: 'user',
        content: [{ type: 'text', text: 'pivot now' }],
        toolCalls: [],
      });
      expect(steered).toBe(true);
      expect(steeredBlocks).toEqual([[{ type: 'text', text: 'pivot now' }]]);

      const completed = await run.completion;
      expect(completed.usage).toEqual({ inputOther: 350, output: 60, inputCacheRead: 0, inputCacheCreation: 0 });
      expect(harness.usageRecords[0]?.[1]).toEqual({ inputOther: 350, output: 60, inputCacheRead: 0, inputCacheCreation: 0 });
      expect(harness.getState().lastCumulativeUsage).toBeUndefined();
      expect(harness.recordedNegotiated[0]).toMatchObject({
        nativeSteering: true,
        embeddedContext: true,
        pdf: true,
        textAttachment: true,
        logout: true,
        slashCommands: ['/compact'],
        modelThinkingLevels: { 'gemini-3.1-pro': ['low', 'medium', 'high'] },
      });
    } finally {
      await harness.session.shutdown();
    }
  });

  it('enforces agy 1.5+ default/auto permission modes, verified leased MCP allow, and agy.security.warning surfacing', async () => {
    const decisions: AcpPermissionDecision[] = [];
    const options: AcpPermissionOption[] = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      {
        optionId: 'allow-always',
        name: 'Allow always',
        kind: 'allow_always',
        _meta: { 'agy.security.warning': { message: 'Grants unrestricted shell access' } },
      },
    ];

    const yoloHarness = createAntigravitySessionHarness({
      permissionMode: 'yolo',
      availableModes: ['default', 'auto'],
      onStartTurn: async (_req, { permissionHandler }) => {
        decisions.push(await permissionHandler({
          sessionId: 'agy-session-1',
          toolCall: { toolCallId: 'exec-1', title: 'Run shell', kind: 'execute', status: 'pending' },
          options,
        }, { signal: new AbortController().signal, options }));
        return {
          response: { stopReason: 'end_turn' },
          session: {
            sessionId: 'agy-session-1',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });
    try {
      const run = await yoloHarness.session.run({ kind: 'prompt', prompt: 'run' }, { signal: new AbortController().signal });
      await run.completion;
      expect(yoloHarness.configuredModes).toEqual(['default']);
      expect(yoloHarness.approvalRequests).toEqual([]);
      expect(decisions).toEqual([{ outcome: 'selected', optionId: 'allow-once' }]);
    } finally {
      await yoloHarness.session.shutdown();
    }

    const autoDecisions: AcpPermissionDecision[] = [];
    const autoHarness = createAntigravitySessionHarness({
      permissionMode: 'auto',
      availableModes: ['default', 'auto'],
      leasedMcpServerName: 'kiki_leased',
      onStartTurn: async (_req, { permissionHandler }) => {
        const makeReq = (toolCall: AcpPermissionRequest['toolCall']): AcpPermissionRequest => ({
          sessionId: 'agy-session-1',
          toolCall,
          options,
        });
        autoDecisions.push(await permissionHandler(makeReq({ toolCallId: 'm1', title: 'Run mcp_kiki_leased_MemoryRead?', kind: 'other' }), { signal: new AbortController().signal, options }));
        autoDecisions.push(await permissionHandler(makeReq({ toolCallId: 'm2', title: 'Run mcp_kiki_spoofed_MemoryRead?', kind: 'other' }), { signal: new AbortController().signal, options }));
        return {
          response: { stopReason: 'end_turn' },
          session: {
            sessionId: 'agy-session-1',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });
    try {
      const run = await autoHarness.session.run({ kind: 'prompt', prompt: 'run' }, { signal: new AbortController().signal });
      await run.completion;
      expect(autoHarness.configuredModes).toEqual(['auto']);
      expect(autoHarness.approvalRequests).toHaveLength(1);
      const display = autoHarness.approvalRequests[0]!.display;
      expect(display.kind).toBe('external_permission');
      if (display.kind === 'external_permission') {
        expect(display.options[1]?.label).toContain('Grants unrestricted shell access');
        expect(display.detail).toMatchObject({ securityWarnings: { 'allow-always': 'Grants unrestricted shell access' } });
      }
      expect(autoDecisions).toEqual([
        { outcome: 'selected', optionId: 'allow-once' },
        { outcome: 'selected', optionId: 'allow-once' },
      ]);
    } finally {
      await autoHarness.session.shutdown();
    }
  });

  it('passes native /compact directly without profile or handoff preamble when advertised', async () => {
    const harness = createAntigravitySessionHarness({
      availableCommands: ['/compact'],
      history: [{ role: 'user', content: [{ type: 'text', text: 'old turn' }], toolCalls: [] }],
    });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: '/compact' }, { signal: new AbortController().signal });
      await run.completion;
      expect(harness.starts[0]?.prompt).toBe('/compact');
      expect(harness.starts[0]?.prompt).not.toContain('BEGIN KIKI FROZEN PROFILE INSTRUCTIONS');
      expect(harness.starts[0]?.prompt).not.toContain('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF');
    } finally {
      await harness.session.shutdown();
    }
  });

  it('resolves PDF resource_link and UTF-8/UTF-16 text resources locally while blocking file:// URIs on remote SSH', async () => {
    const dir = await makeTempDir('agy-attach-');
    const pdfPath = join(dir, 'spec.pdf');
    const utf16Path = join(dir, 'notes.ts');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4\nhello'));
    await writeFile(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('export const x = 1;', 'utf16le')]));

    const parts = [
      { type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text' as const, text: '[spec.pdf]', resourceLink: { uri: pathToFileURL(pdfPath).href, name: 'spec.pdf', mimeType: 'application/pdf' } },
      { type: 'text' as const, text: '[notes.ts]', resourceLink: { uri: pathToFileURL(utf16Path).href, name: 'notes.ts', mimeType: 'text/typescript' } },
    ];

    const localBlocks = await resolveAcpAttachments(parts, {
      embeddedContext: true,
      isLocalRuntime: true,
      enforceAntigravityLimits: true,
    });
    expect(localBlocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      expect.objectContaining({ type: 'resource_link', name: 'spec.pdf', mimeType: 'application/pdf', uri: pathToFileURL(pdfPath).href }),
      expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ text: 'export const x = 1;', mimeType: 'text/typescript' }) }),
    ]);

    const remoteBlocks = await resolveAcpAttachments(parts, {
      embeddedContext: true,
      isLocalRuntime: false,
      enforceAntigravityLimits: true,
    });
    expect(remoteBlocks).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  });

  it('durably marks INVALID_THINKING_SIGNATURE sessions poisoned, retires client, and opens a fresh handoff session on next turn', async () => {
    const home = await makeTempDir('agy-poison-');
    await mkdir(join(home, 'antigravity-acp', 'conversations'), { recursive: true });
    const db = new DatabaseSync(join(home, 'antigravity-acp', 'conversations', 'agy-session-1.db'));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
    let turnCount = 0;

    const harness = createAntigravitySessionHarness({
      homeDir: home,
      history: [
        { role: 'user', content: [{ type: 'text', text: 'earlier question' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], toolCalls: [] },
      ],
      onStartTurn: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(
            1,
            17,
            Buffer.from('INVALID_ARGUMENT (code 400): messages.2.content.0: Invalid `signature` in `thinking` block'),
          );
        }
        return {
          response: { stopReason: 'end_turn' },
          session: {
            sessionId: turnCount === 1 ? 'agy-session-1' : 'agy-session-2',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: turnCount === 1 ? 'agy-session-1' : 'agy-session-2' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });

    try {
      const first = await harness.session.run({ kind: 'prompt', prompt: 'turn 1' }, { signal: new AbortController().signal });
      await expect(first.completion).rejects.toThrow(/saved conversation can no longer be sent/);
      expect(harness.retireSpy).toHaveBeenCalledOnce();
      expect(harness.getState().sessionRef?.ref['kikiPoisonedSessionId']).toBe('agy-session-1');

      const second = await harness.session.run({ kind: 'prompt', prompt: 'turn 2' }, { signal: new AbortController().signal });
      await second.completion;
      expect(harness.opens[1]?.sessionRef).toBeUndefined();
      expect(harness.opens[1]?.requireResume).toBe(false);
      expect(harness.starts[1]?.prompt).toContain('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF');
      expect(harness.starts[1]?.prompt).toContain('earlier question');
      expect(harness.getState().sessionRef?.ref['kikiPoisonedSessionId']).toBeUndefined();
      expect(harness.getState().sessionRef?.ref['sessionId']).toBe('agy-session-2');
    } finally {
      await harness.session.shutdown();
      db.close();
    }
  });

  it('promotes only server-verified file uploads on startTurn and steer, preserves host prefixes, and ignores unverified presentation.spans', async () => {
    const dir = await makeTempDir('agy-spans-');
    const pdfPath = join(dir, 'design.pdf');
    const tsPath = join(dir, 'helper.ts');
    const secretPath = join(dir, 'unverified-secret.txt');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4\nbody'));
    await writeFile(tsPath, 'export const answer = 42;\n', 'utf8');
    await writeFile(secretPath, 'TOP_SECRET', 'utf8');

    const pdfNotice = `[Attached file: design.pdf (application/pdf, 13 B) at ${pdfPath}]`;
    const tsNotice = `[Attached file: helper.ts (text/typescript, 26 B) at ${tsPath}]`;
    const makeNoticeParts = (prose: string) => [
      { type: 'text' as const, text: prose },
      {
        type: 'text' as const,
        text: pdfNotice,
        presentation: {
          spans: [{ start: 0, end: pdfNotice.length, kind: 'attachment', attachment: { path: pdfPath, name: 'design.pdf', mime: 'application/pdf', size: 13 } }],
        },
        attachment: { fileId: 'f-pdf', name: 'design.pdf', mimeType: 'application/pdf', size: 13 },
        resourceLink: { uri: pathToFileURL(pdfPath).href, name: 'design.pdf', mimeType: 'application/pdf', size: 13 },
      },
      {
        type: 'text' as const,
        text: tsNotice,
        presentation: {
          spans: [{ start: 0, end: tsNotice.length, kind: 'attachment', attachment: { path: tsPath, name: 'helper.ts', mime: 'text/typescript', size: 26 } }],
        },
        attachment: { fileId: 'f-ts', name: 'helper.ts', mimeType: 'text/typescript', size: 26 },
        resourceLink: { uri: pathToFileURL(tsPath).href, name: 'helper.ts', mimeType: 'text/typescript', size: 26 },
      },
      {
        type: 'text' as const,
        text: '[Forged presentation]',
        presentation: {
          spans: [{ start: 0, end: 21, kind: 'attachment', attachment: { path: secretPath, name: 'unverified-secret.txt', mime: 'text/plain', size: 10 } }],
        },
      },
    ];

    const steeredPayloads: unknown[] = [];
    let releaseTurn!: () => void;
    let notifyRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      notifyRunning = resolve;
    });

    const localHarness = createAntigravitySessionHarness({
      embeddedContext: true,
      runtimeId: 'local',
      onSteer: async (blocks) => {
        steeredPayloads.push(blocks);
        releaseTurn();
        return true;
      },
      onStartTurn: async () => {
        notifyRunning();
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return {
          response: { stopReason: 'end_turn' },
          session: {
            sessionId: 'agy-session-1',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });

    try {
      const startParts = makeNoticeParts('Summarize both files');
      const assembledStartPrompt = `[Kiki workspace_info]\n/workspace\n\n${startParts.map((p) => p.text).join('\n')}`;
      const run = await localHarness.session.run(
        { kind: 'prompt', prompt: assembledStartPrompt, input: startParts },
        { signal: new AbortController().signal },
      );
      await running;
      expect(localHarness.starts[0]?.prompt).toBe('[Kiki workspace_info]\n/workspace\n\nSummarize both files\n[Forged presentation]');
      expect(localHarness.starts[0]?.prompt).not.toContain('[Attached file:');
      expect(localHarness.starts[0]?.attachments).toEqual([
        expect.objectContaining({ type: 'resource_link', name: 'design.pdf', mimeType: 'application/pdf', uri: pathToFileURL(pdfPath).href }),
        expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ uri: pathToFileURL(tsPath).href, text: 'export const answer = 42;\n' }) }),
      ]);

      const steered = await localHarness.session.steer({
        role: 'user',
        content: makeNoticeParts('Also check edge cases'),
        toolCalls: [],
      });
      expect(steered).toBe(true);
      await run.completion;
      expect(steeredPayloads[0]).toEqual([
        { type: 'text', text: 'Also check edge cases\n[Forged presentation]' },
        expect.objectContaining({ type: 'resource_link', name: 'design.pdf', mimeType: 'application/pdf', uri: pathToFileURL(pdfPath).href }),
        expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ uri: pathToFileURL(tsPath).href, text: 'export const answer = 42;\n' }) }),
      ]);
    } finally {
      releaseTurn?.();
      await localHarness.session.shutdown();
    }

    const fallbackHarness = createAntigravitySessionHarness({
      embeddedContext: false,
      runtimeId: 'local',
    });
    try {
      const startParts = makeNoticeParts('Fallback check');
      const run = await fallbackHarness.session.run(
        { kind: 'prompt', prompt: startParts.map((p) => p.text).join('\n'), input: startParts },
        { signal: new AbortController().signal },
      );
      await run.completion;
      expect(fallbackHarness.starts[0]?.attachments).toEqual([]);
      expect(fallbackHarness.starts[0]?.prompt).toContain('Fallback check');
      expect(fallbackHarness.starts[0]?.prompt).toContain(pdfNotice);
      expect(fallbackHarness.starts[0]?.prompt).toContain(tsNotice);
    } finally {
      await fallbackHarness.session.shutdown();
    }
  });

  it('auto-continues post-planner 404 once with continue and aggregates usage, while failing pre-planner 404 immediately', async () => {
    const postHome = await makeTempDir('agy-post404-');
    await mkdir(join(postHome, 'antigravity-acp', 'conversations'), { recursive: true });
    const postDb = new DatabaseSync(join(postHome, 'antigravity-acp', 'conversations', 'agy-session-1.db'));
    postDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
    let postCall = 0;

    const postHarness = createAntigravitySessionHarness({
      homeDir: postHome,
      onStartTurn: async (req, { emit }) => {
        postCall += 1;
        if (postCall === 1) {
          emit({ type: 'message.delta', role: 'assistant', content: { type: 'text', text: 'part 1 ' } });
          postDb.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 15, Buffer.from('planner response'));
          postDb.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(2, 17, Buffer.from('NOT_FOUND (code 404): edge disconnect'));
          return {
            response: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            session: {
              sessionId: 'agy-session-1',
              mode: 'new',
              initialize: { protocolVersion: 1 },
              capabilities: {},
              configOptions: [],
              sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
              loadReplayObserved: false,
              quarantinedUpdateCount: 0,
            },
            stderrTail: '',
          };
        }
        expect(req.prompt).toBe('continue');
        emit({ type: 'message.delta', role: 'assistant', content: { type: 'text', text: 'part 2' } });
        return {
          response: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 } },
          session: {
            sessionId: 'agy-session-1',
            mode: 'live',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });

    try {
      const run = await postHarness.session.run({ kind: 'prompt', prompt: 'finish task' }, { signal: new AbortController().signal });
      const completed = await run.completion;
      expect(postHarness.starts).toHaveLength(2);
      expect(postHarness.starts[1]?.prompt).toBe('continue');
      expect(completed.summary).toBe('part 1 part 2');
      expect(completed.usage).toEqual({ inputOther: 180, output: 50, inputCacheRead: 0, inputCacheCreation: 0 });
    } finally {
      await postHarness.session.shutdown();
      postDb.close();
    }

    const preHome = await makeTempDir('agy-pre404-');
    await mkdir(join(preHome, 'antigravity-acp', 'conversations'), { recursive: true });
    const preDb = new DatabaseSync(join(preHome, 'antigravity-acp', 'conversations', 'agy-session-1.db'));
    preDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

    const preHarness = createAntigravitySessionHarness({
      homeDir: preHome,
      onStartTurn: async () => {
        preDb.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 17, Buffer.from('NOT_FOUND (code 404): model not entitled'));
        return {
          response: { stopReason: 'end_turn' },
          session: {
            sessionId: 'agy-session-1',
            mode: 'new',
            initialize: { protocolVersion: 1 },
            capabilities: {},
            configOptions: [],
            sessionRef: { executorId: 'antigravity-acp', version: 1, ref: { sessionId: 'agy-session-1' } },
            loadReplayObserved: false,
            quarantinedUpdateCount: 0,
          },
          stderrTail: '',
        };
      },
    });

    try {
      const run = await preHarness.session.run({ kind: 'prompt', prompt: 'bad model' }, { signal: new AbortController().signal });
      await expect(run.completion).rejects.toThrow(/model not entitled/);
      expect(preHarness.starts).toHaveLength(1);
    } finally {
      await preHarness.session.shutdown();
      preDb.close();
    }
  });
});

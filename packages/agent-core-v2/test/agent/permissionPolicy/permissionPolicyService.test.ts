import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { ILogService } from '#/_base/log/log';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IRequestAdmission } from '#/kosong/model/requestAdmission';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionApprovalService } from '#/session/approval/approval';
import { AgentToolApprovalService } from '#/agent/toolApproval/toolApprovalService';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';
import { matchesBashRuleSubject } from '#/tool/bash-rule-match';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IHostEnvironment, type IHostEnvironment as HostEnvironmentService } from '#/os/interface/hostEnvironment';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService, type PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicyService';
import {
  type DangerousBashGuard,
  PERMISSION_SECTION,
} from '#/agent/permissionRules/configSection';
import {
  IAgentPermissionRulesService,
  type IAgentPermissionRulesService as PermissionRulesServiceContract,
  type PermissionRule,
} from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { IConfigService } from '#/app/config/config';
import { IGitService } from '#/app/git/git';
import { IWorktreeService, type SessionWorktree } from '#/app/git/worktreeModel';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { findGitWorkTree } from '#/app/git/workTree';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { ToolAccesses, type ToolAccesses as ToolAccessList } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { authorizeExternalTool, externalPermissionMeta, externalToolPermission } from '#/agent/execution/externalPermission';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { normalizeAgentProfile } from '@kiki/agent-profiles/agentProfile';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { isToolActive } from '@kiki/agent-profiles/toolPolicy';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { declaredExternalToolPolicy } from '#/agent/profile/toolBinding';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { AgentPermissionGate } from '#/agent/permissionGate/permissionGateService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { stubToolExecutorEvents } from '../toolExecutor/stubs';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';

const signal = new AbortController().signal;

const hostFs = new HostFileSystem();

describe('AgentPermissionPolicyService chain', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: PermissionRule[];
  let sessionApprovalRulePatterns: string[];
  let workspace: ReturnType<typeof workspaceStub>;
  let worktreeMeta: SessionWorktree | undefined;
  let dangerousBash: DangerousBashGuard | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    rules = [];
    sessionApprovalRulePatterns = [];
    workspace = workspaceStub('/workspace');
    worktreeMeta = undefined;
    dangerousBash = undefined;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IConfigService, {
          get: ((section: string) =>
            section === PERMISSION_SECTION
              ? { dangerousBash }
              : undefined) as IConfigService['get'],
        });
        reg.define(IBashParserService, BashParserService);
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub({
          rules: () => rules,
          sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
        }));
        reg.defineInstance(ISessionWorkspaceContext, workspace.stub);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(IAgentRuntimeService, {
          _serviceBrand: undefined,
          onDidChange: () => ({ dispose: () => {} }),
          isAvailable: () => true,
          inspect() { return (this as IAgentRuntimeService).acquire().runtime; },
          acquire: () => ({
            track: (resource) => resource,
            runtime: {
              identity: { workspaceId: 'test', runtimeId: 'local', generation: 'test' },
              capabilities: new Set(),
              status: 'ready',
              onDidChangeStatus: () => ({ dispose: () => {} }),
              dispose: () => {},
              environment: { pathClass: 'posix', homeDir: '/home/example', osKind: 'linux', shellName: 'bash', shellPath: '/bin/bash' } as never,
              fs: { realpath: async (path: string) => path } as never,
              path: {
                separator: '/',
                delimiter: ':',
                isAbsolute: () => true,
                join: (...paths: readonly string[]) => join(...paths),
                relative: (from: string, to: string) => to.replace(`${from}/`, ''),
                resolve: (...paths: readonly string[]) => join(...paths),
                basename: (path: string) => basename(path),
                dirname: (path: string) => dirname(path),
              },
              workspace: { mapRoots: (roots) => roots },
            },
            dispose: () => {},
          }),
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.definePartialInstance(IGitService, { findWorkTree: async () => null });
        reg.definePartialInstance(ISessionMetadata, { read: async () => ({ id: 'session_test', createdAt: 0, updatedAt: 0, archived: false, worktree: worktreeMeta }), getAgentExecutor: async () => undefined });
        reg.defineInstance(IAgentToolExecutorService, stubToolExecutorEvents().executor);
        reg.definePartialInstance(IAgentToolApprovalService, {
          resolvePermissionResolution: async (result) => result.kind === 'approve' ? undefined
            : { permissionDecision: result.kind === 'ask' ? 'cancelled' : 'rejected', veto: { isError: true, output: 'Not approved' } },
        });
        reg.define(IAgentPermissionGate, AgentPermissionGate);
        reg.definePartialInstance(IWorktreeService, { list: async () => [] });
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  function service(): IAgentPermissionPolicyService {
    return ix.get(IAgentPermissionPolicyService);
  }

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = service();
    return svc.evaluate(policyContext(input));
  }

  function externalContext(inherit = false): AgentExecutorContext {
    return { agent: { id: 'main', accessor: ix }, descriptor: { id: 'example-acp', protocol: 'acp-v1', args: [], revision: 'r1' },
      binding: { systemPrompt: '', thinkingLevel: 'off', permissionMode: inherit ? undefined : mode }, worktree: worktreeMeta };
  }

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Glob', { path: '/workspace' }],
    ['Bash', { command: 'Get-ChildItem /workspace', cwd: '/workspace' }],
  ] as const)('authorizes external %s with the real yolo gate and preserves explicit deny', async (name, input) => {
    mode = 'yolo';
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: name, detail: input };
    expect(await authorizeExternalTool(context, { name, input }, 1, 'external-call', signal, display)).toBe('allow');
    rules.push({ decision: 'deny', scope: 'user', pattern: name });
    expect(await authorizeExternalTool(context, { name, input }, 1, 'external-call', signal, display)).toBe('deny');
    const meta = externalPermissionMeta(context, '/workspace');
    expect(meta.override).toEqual({ mode: 'yolo', source: 'profile' });
    expect(meta.policyIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(meta)).not.toContain('"pattern"');
  });

  it('projects external FetchURL subjects through the real gate without losing URL or generic rules', async () => {
    const input = { url: 'https://DOCS.Example.test.:443/reference?q=one#part' };
    const tool = externalToolPermission({ name: 'FetchURL', input })!;
    const display = { kind: 'external_permission' as const, options: [], summary: 'FetchURL', detail: input };
    const decide = () => authorizeExternalTool(externalContext(), tool, 1, 'url-read', signal, display);
    mode = 'yolo';
    expect(await decide()).toBe('allow');
    for (const scope of ['user', 'turn-override', 'project'] as const) {
      rules = [{ decision: 'allow', scope: 'user', pattern: 'FetchURL' },
        { decision: 'deny', scope, pattern: 'FetchURL(https://docs.example.test/reference*)' }];
      expect(await decide()).toBe('deny');
    }
    rules = [{ decision: 'deny', scope: 'user', pattern: 'FetchURL' },
      { decision: 'allow', scope: 'turn-override', pattern: 'FetchURL(https://docs.example.test/**)' }];
    expect(await decide()).toBe('deny');
    mode = 'manual';
    rules = [{ decision: 'ask', scope: 'user', pattern: 'FetchURL(https://docs.example.test/reference*)' }];
    expect(await decide()).toBe('cancelled');
    rules = [{ decision: 'allow', scope: 'user', pattern: 'FetchURL(https://docs.example.test/reference*)' }];
    expect(await decide()).toBe('allow');
    const inherited = externalContext(true);
    rules = [{ decision: 'ask', scope: 'turn-override', pattern: 'FetchURL(https://docs.example.test/reference*)' }];
    expect(await authorizeExternalTool(inherited, tool, 1, 'url-inherit-ask', signal, display)).toBe('cancelled');
    rules = [{ decision: 'allow', scope: 'turn-override', pattern: 'FetchURL(https://docs.example.test/reference*)' }];
    expect(await authorizeExternalTool(inherited, tool, 1, 'url-inherit-allow', signal, display)).toBe('allow');
    rules = [];
    expect(await authorizeExternalTool(inherited, tool, 1, 'url-inherit', signal, display)).toBe('inherit');
  });

  it('rejects malformed external FetchURL, forged URL aliases, cancellation and excluded tool names', async () => {
    mode = 'yolo';
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: 'URL read', detail: {} };
    for (const input of [{}, { url: 'not-a-url' }, { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' },
      { url: 'https://user:password@example.test/' }, { url: 'https://example.test/\nother' },
      { url: 'https://example.test/', source: { kind: 'url', url: 'https://other.example.test/' } }]) {
      expect(externalToolPermission({ name: 'FetchURL', input })).toBeUndefined();
      expect(await authorizeExternalTool(context, { name: 'FetchURL', input }, 1, 'bad-url', signal, display)).toBe('deny');
    }
    for (const value of [{ name: 'Bash', nativeName: 'read_url_content', input: { url: 'https://example.test/' } },
      { name: 'FetchURL', nativeName: 'execute_url', input: { url: 'https://example.test/' } },
      { name: 'FetchURL', nativeName: 'read_url_content', input: { url: 'https://example.test/', command: 'example-command' } },
      { name: 'read_url_content', input: { Url: 'https://example.test/', Action: 'execute' } }]) expect(externalToolPermission(value)).toBeUndefined();
    const tool = externalToolPermission({ name: 'FetchURL', input: { url: 'https://example.test/' } })!;
    const aborted = AbortSignal.abort();
    await expect(authorizeExternalTool(context, tool, 1, 'cancelled-url', aborted, display)).rejects.toBeDefined();
    const restricted = { ...context, binding: { ...context.binding, toolOverride: { tools: ['FetchURL'] } } };
    for (const name of ['unknown_url_tool', 'execute_url', 'Bash']) expect(await authorizeExternalTool(restricted,
      { name, input: { url: 'https://example.test/' } }, 1, 'not-url-read', signal, display)).toBe('deny');
  });

  it('carries native URL reads from the adapter into the real host gate and only grants read_url', async () => {
    mode = 'manual';
    const { AgyBridge } = await import(new URL('../../../../../scripts/external-harness/agy-cli-acp.mjs', import.meta.url).href);
    const bridge = new AgyBridge({ cliPath: process.execPath });
    const cwd = process.cwd();
    const { sessionId } = await bridge.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': {
      version: 1, hostGate: true, override: { mode: 'manual', source: 'runtime' }, policyIdentity: 'fixture-url', workspace: { cwd, additionalDirectories: [] } } } });
    const session = bridge.session(sessionId);
    session.init = { conversation_id: 'fixture-url' };
    const base = externalContext();
    const context = { ...base, binding: { ...base.binding, toolOverride: { tools: ['FetchURL'] } } };
    let decisionContext = context;
    session.active = { client: { request: async (_method: string, raw: unknown) => {
      const request = JSON.parse(JSON.stringify(raw));
      const tool = externalToolPermission(request._meta['kiki.tool'])!;
      expect(tool).toMatchObject({ name: 'FetchURL', nativeName: 'read_url_content', input: { url: 'https://docs.example.test/reference' } });
      expect(request.toolCall.rawInput).toEqual({ Url: 'https://docs.example.test/reference' });
      const decision = await authorizeExternalTool(decisionContext, tool, 1, request.toolCall.toolCallId, signal,
        { kind: 'external_permission', summary: request.toolCall.title, options: [], detail: request });
      return { outcome: decision === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision === 'allow' ? 'allow_once' : 'reject_once' } };
    } } };
    const input = { conversationId: 'fixture-url', stepIdx: 1, toolCall: { name: 'read_url_content', args: { Url: 'https://docs.example.test/reference' } } };
    try {
      expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'allow', permissionOverrides: ['read_url(docs.example.test)'] });
      expect(externalToolPermission({ name: 'read_url_content', input: input.toolCall.args })).toEqual({ name: 'FetchURL', nativeName: 'read_url_content', input: { url: input.toolCall.args.Url } });
      for (const name of ['FetchURL', 'read_url_content']) {
        rules = [{ decision: 'deny', scope: 'user', pattern: `${name}(https://docs.example.test/*)` }];
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        rules = [{ decision: 'ask', scope: 'turn-override', pattern: `${name}(https://docs.example.test/*)` }];
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        rules = [];
        decisionContext = { ...context, binding: { ...context.binding, disallowedTools: [name] } };
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        decisionContext = context;
      }
      expect(session.child).toBeUndefined();
    } finally { session.active = undefined; await bridge.close(); }
  });

  it.each(['Read', 'Write'] as const)('applies real external %s path deny to any member of a file batch under yolo', async (name) => {
    mode = 'yolo';
    const context = externalContext();
    const tool = { name, input: { paths: ['/workspace/allowed.ts', '/workspace/blocked.ts'] } };
    const display = { kind: 'external_permission' as const, options: [], summary: name, detail: tool.input };
    expect(await authorizeExternalTool(context, tool, 1, 'batch', signal, display)).toBe('allow');
    rules.push({ decision: 'deny', scope: 'user', pattern: `${name}(/workspace/blocked.ts)` });
    expect(await authorizeExternalTool(context, tool, 1, 'batch', signal, display)).toBe('deny');
  });

  it('does not let an external Write allow rule for one file approve the rest of a batch', async () => {
    mode = 'manual';
    const context = externalContext();
    const tool = { name: 'Write', input: { paths: ['/workspace/allowed.ts', '/workspace/blocked.ts'] } };
    const display = { kind: 'external_permission' as const, options: [], summary: 'Write', detail: tool.input };
    rules.push({ decision: 'allow', scope: 'user', pattern: 'Write(/workspace/allowed.ts)' });
    expect(await authorizeExternalTool(context, tool, 1, 'batch', signal, display)).toBe('cancelled');
    rules.push({ decision: 'allow', scope: 'user', pattern: 'Write(/workspace/**)' });
    expect(await authorizeExternalTool(context, tool, 1, 'batch', signal, display)).toBe('allow');
  });

  it.each([
    [{ Action: 'list' }, 'TaskList'],
    [{ Action: 'status', TaskId: 'fixture-task' }, 'TaskOutput'],
  ] as const)('admits native task read %j with the real manual gate and preserves both rule identities', async (input, name) => {
    mode = 'manual';
    const tool = externalToolPermission({ name: 'manage_task', input })!;
    expect(tool).toMatchObject({ name, nativeName: 'manage_task', input });
    expect(externalToolPermission({ name, nativeName: 'manage_task', input })).toEqual(tool);
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: 'manage_task', detail: input };
    expect(await authorizeExternalTool(context, tool, 1, 'native-task-read', signal, display)).toBe('allow');
    for (const pattern of ['manage_task', name]) {
      rules = [{ decision: 'deny', scope: 'user', pattern }];
      expect(await authorizeExternalTool(context, tool, 1, 'native-task-deny', signal, display)).toBe('deny');
      rules = [{ decision: 'ask', scope: 'user', pattern }];
      expect(await authorizeExternalTool(context, tool, 1, 'native-task-ask', signal, display)).toBe('cancelled');
      rules = [];
      const restricted = { ...context, binding: { ...context.binding, disallowedTools: [pattern] } };
      expect(await authorizeExternalTool(restricted, tool, 1, 'native-task-excluded', signal, display)).toBe('deny');
      const allowed = { ...context, binding: { ...context.binding, toolOverride: { tools: [pattern] } } };
      expect(await authorizeExternalTool(allowed, tool, 1, 'native-task-allowlist', signal, display)).toBe('allow');
    }
    const excluded = { ...context, binding: { ...context.binding, toolOverride: { tools: ['Read'] } } };
    expect(await authorizeExternalTool(excluded, tool, 1, 'read-only-not-task', signal, display)).toBe('deny');
    rules = [{ decision: 'allow', scope: 'user', pattern: 'manage_task' }, { decision: 'deny', scope: 'user', pattern: name }];
    expect(await authorizeExternalTool(context, tool, 1, 'canonical-deny-wins', signal, display)).toBe('deny');
    rules = [{ decision: 'deny', scope: 'user', pattern: 'manage_task' }, { decision: 'allow', scope: 'user', pattern: name }];
    expect(await authorizeExternalTool(context, tool, 1, 'native-deny-wins', signal, display)).toBe('deny');
    const inherited = externalContext(true);
    rules = [];
    expect(await authorizeExternalTool(inherited, tool, 1, 'native-inherit', signal, display)).toBe('inherit');
    for (const pattern of ['manage_task', name]) {
      rules = [{ decision: 'allow', scope: 'user', pattern }];
      expect(await authorizeExternalTool(inherited, tool, 1, 'explicit-inherited-allow', signal, display)).toBe('allow');
    }
  });

  it('keeps task mutations and invalid schemas on native approval and rejects forged native projections', async () => {
    mode = 'manual';
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: 'manage_task', detail: {} };
    for (const input of [{ Action: 'kill', TaskId: 'fixture-task' }, { Action: 'send_input', TaskId: 'fixture-task', Input: 'stop' },
      { Action: 'status' }, { Action: 'status', TaskId: '' }, { Action: 'list', TaskId: 3 }, { Action: 'list', Unknown: true }, { Action: 'unknown' }]) {
      const tool = externalToolPermission({ name: 'manage_task', input })!;
      expect(tool.name).toBe('manage_task');
      expect(tool.nativeName).toBeUndefined();
      expect(await authorizeExternalTool(context, tool, 1, 'native-task-not-read', signal, display)).toBe('cancelled');
      const forged = { name: 'TaskList', nativeName: 'manage_task', input };
      expect(externalToolPermission(forged)).toBeUndefined();
      expect(await authorizeExternalTool(context, forged, 1, 'forged-task-read', signal, display)).toBe('deny');
    }
    for (const forged of [{ name: 'TaskList', nativeName: 'run_command', input: { command: 'example' } },
      { name: 'TaskList', nativeName: 'manage_task', input: { Action: 'status', TaskId: 'fixture-task' } },
      { name: 'Write', nativeName: 'manage_task', input: { Action: 'list' } }]) {
      expect(externalToolPermission(forged)).toBeUndefined();
      expect(await authorizeExternalTool(context, forged, 1, 'forged-native-name', signal, display)).toBe('deny');
    }
  });

  it('round-trips AGY session/request_permission through the real gate for task reads and explicit denies', async () => {
    mode = 'manual';
    const adapterUrl = new URL('../../../../../scripts/external-harness/agy-cli-acp.mjs', import.meta.url).href;
    const { AgyBridge } = await import(adapterUrl);
    const bridge = new AgyBridge({ cliPath: process.execPath });
    const context = externalContext();
    const cwd = process.cwd();
    const permission = { version: 1, hostGate: true, override: { mode: 'manual', source: 'profile' },
      policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } };
    const { sessionId } = await bridge.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': permission } });
    const session = bridge.session(sessionId);
    session.init = { conversation_id: 'fixture-conversation' };
    session.active = { client: { request: async (method: string, rawRequest: unknown) => {
      expect(method).toBe('session/request_permission');
      const request = JSON.parse(JSON.stringify(rawRequest));
      expect(request.toolCall.title).toBe('manage_task');
      expect(request.toolCall.kind).toBe('read');
      const tool = externalToolPermission(request._meta['kiki.tool'])!;
      expect(tool.nativeName).toBe('manage_task');
      expect(tool.input).toEqual(request.toolCall.rawInput);
      const decision = await authorizeExternalTool(context, tool, 1, request.toolCall.toolCallId, signal,
        { kind: 'external_permission', summary: request.toolCall.title, options: [], detail: request });
      return { outcome: decision === 'cancelled' ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: decision === 'allow' ? 'allow_once' : decision === 'inherit' ? 'kiki.vendor_default' : 'reject_once' } };
    } } };
    try {
      for (const [args, name] of [[{ Action: 'list' }, 'TaskList'], [{ Action: 'status', TaskId: 'fixture-task' }, 'TaskOutput']] as const) {
        const input = { conversationId: 'fixture-conversation', stepIdx: 1, toolCall: { name: 'manage_task', args } };
        rules = [];
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'allow' });
        for (const pattern of ['manage_task', name]) {
          rules = [{ decision: 'deny', scope: 'user', pattern }];
          expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        }
      }
    } finally { session.active = undefined; await bridge.close(); }
  });

  it('consumes native task reads under a frozen external caller ceiling without widening either deny identity', async () => {
    mode = 'yolo';
    const fileDefinition = parseAgentFileText({ path: '/workspace/example-agent.md', source: 'explicit',
      text: '---\nname: example-agent\ndescription: Neutral task owner\nexecutor: example-acp\n---\nNeutral task owner.' });
    const boundProfile = { ...freezeBoundProfile(normalizeAgentProfile({ name: 'example-agent', executor: 'example-acp', systemPrompt: () => '' })),
      fileDefinition, fileSources: { root: fileDefinition, scopedBindings: {}, sourceDefinitions: {}, dependencyIndex: {}, diagnostics: [],
        callerCeiling: { activeToolNames: ['Read', 'Bash', 'TaskList', 'TaskOutput'],
          externalToolAllowPolicies: [['Read', 'Bash', 'TaskList', 'TaskOutput']], disallowedTools: [] } } };
    const base = externalContext(true);
    const context = { ...base, binding: { ...base.binding, boundProfile } };
    expect(boundProfile.fileDefinition.tools).toBeUndefined();
    const policy = declaredExternalToolPolicy(context.binding);
    expect(isToolActive(policy, 'manage_task')).toBe(false);
    expect(isToolActive(policy, 'TaskList')).toBe(true);
    const adapterUrl = new URL('../../../../../scripts/external-harness/agy-cli-acp.mjs', import.meta.url).href;
    const { AgyBridge } = await import(adapterUrl);
    const bridge = new AgyBridge({ cliPath: process.execPath });
    const cwd = process.cwd();
    const { sessionId } = await bridge.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': {
      version: 1, hostGate: true, policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } } } });
    const session = bridge.session(sessionId);
    session.init = { conversation_id: 'fixture-conversation' };
    let legacyProjection = false;
    let decisionContext = context;
    let lastDecision: string | undefined;
    session.active = { client: { request: async (_method: string, rawRequest: unknown) => {
      const request = JSON.parse(JSON.stringify(rawRequest));
      const metadata = request._meta['kiki.tool'];
      const tool = legacyProjection ? { name: 'manage_task', input: request.toolCall.rawInput }
        : externalToolPermission(metadata)!;
      expect(request.toolCall.kind).toBe('read');
      if (!legacyProjection) expect(metadata.nativeName).toBe('manage_task');
      lastDecision = await authorizeExternalTool(decisionContext, tool, 1, request.toolCall.toolCallId, signal,
        { kind: 'external_permission', summary: request.toolCall.title, options: [], detail: request });
      return { outcome: lastDecision === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected',
        optionId: lastDecision === 'inherit' ? 'kiki.vendor_default' : lastDecision === 'allow' ? 'allow_once' : 'reject_once' } };
    } } };
    const input = { conversationId: 'fixture-conversation', stepIdx: 1, toolCall: { name: 'manage_task', args: { Action: 'list' } } };
    try {
      legacyProjection = true;
      expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
      expect(lastDecision).toBe('deny');
      legacyProjection = false;
      expect(await bridge.requestPermission(session, input)).toEqual({ decision: 'ask' });
      expect(lastDecision).toBe('inherit');
      for (const name of ['manage_task', 'TaskList']) {
        rules = [{ decision: 'deny', scope: 'user', pattern: name }];
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        expect(lastDecision).toBe('deny');
        rules = [{ decision: 'ask', scope: 'user', pattern: name }];
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        expect(lastDecision).toBe('cancelled');
        rules = [];
        decisionContext = { ...context, binding: { ...context.binding, disallowedTools: [name] } };
        expect(await bridge.requestPermission(session, input)).toMatchObject({ decision: 'deny' });
        expect(lastDecision).toBe('deny');
        decisionContext = context;
      }
    } finally { session.active = undefined; await bridge.close(); }
  });

  it.each(['manual', 'auto', 'review', 'yolo'] as const)('keeps an external unknown tool on the existing %s policy path', async (permissionMode) => {
    mode = permissionMode;
    const tool = { name: 'VendorNewTool', input: { query: 'neutral fixture' } };
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: tool.name, detail: tool.input };
    expect(await authorizeExternalTool(context, tool, 1, 'new-tool', signal, display))
      .toBe(permissionMode === 'manual' ? 'cancelled' : 'allow');
    rules.push({ decision: 'deny', scope: 'user', pattern: tool.name });
    expect(await authorizeExternalTool(context, tool, 1, 'new-tool', signal, display)).toBe('deny');
  });

  it('preserves old explicit external binding sources but does not infer an override from ambient state', () => {
    mode = 'yolo';
    const context = externalContext(true);
    expect(externalPermissionMeta(context, '/workspace').override).toBeUndefined();
    for (const source of ['session', 'profile', 'harness-settings'] as const) {
      const execution = { version: 1 as const, generation: 1, selection: { executor: 'example-acp' },
        sources: { permission_mode: source }, effective: { permission_mode: 'manual' as const, kiki_context: [], allow_kiki_subagents: false } };
      expect(externalPermissionMeta({ ...context, binding: { ...context.binding, execution } }, '/workspace').override)
        .toEqual({ mode: 'manual', source });
    }
  });

  it.each(['manual', 'auto', 'review', 'yolo'] as const)('inherits external vendor permissions despite ambient %s and only intercepts explicit rules', async (permissionMode) => {
    mode = permissionMode;
    const context = externalContext(true);
    const tool = { name: 'VendorNewTool', input: {} };
    const display = { kind: 'external_permission' as const, options: [], summary: tool.name, detail: {} };
    expect(externalPermissionMeta(context, '/workspace')).toMatchObject({ override: undefined, hostGate: false });
    expect(await authorizeExternalTool(context, tool, 1, 'inherit', signal, display)).toBe('inherit');
    rules.push({ decision: 'deny', scope: 'user', pattern: 'Read' });
    expect(await authorizeExternalTool(context, tool, 1, 'inherit', signal, display)).toBe('inherit');
    expect(await authorizeExternalTool(context, { name: 'Read', input: { path: '/workspace/notes.md' } }, 1, 'deny', signal, display)).toBe('deny');
  });

  it.each([true, false])('does not promote native catalog ceilings into external declarations (inherit=%s)', async (inherit) => {
    mode = 'yolo';
    const base = externalContext(inherit);
    const context = { ...base, binding: { ...base.binding,
      activeToolNames: ['Read'], toolAllowPolicies: [['Read'], ['Read', 'Bash']] } };
    const tool = { name: 'manage_task', input: { Action: 'status', TaskId: 'example/task-1' } };
    const display = { kind: 'external_permission' as const, options: [], summary: tool.name, detail: tool.input };
    expect(isToolActive({ toolAllowPolicies: context.binding.toolAllowPolicies }, tool.name)).toBe(false);
    expect(await authorizeExternalTool(context, tool, 1, 'vendor-status', signal, display)).toBe(inherit ? 'inherit' : 'allow');
    expect(externalPermissionMeta(context, '/workspace').hostGate).toBe(!inherit);
    rules.push({ decision: 'deny', scope: 'user', pattern: 'manage_task' });
    expect(await authorizeExternalTool(context, tool, 1, 'real-deny', signal, display)).toBe('deny');
  });

  it('preserves and clears an explicitly declared external profile allowlist without using native catalogs', async () => {
    mode = 'yolo';
    const base = externalContext();
    const bind = (tools: readonly string[] | undefined) => ({ ...base, binding: { ...base.binding,
      toolAllowPolicies: [['Read']], boundProfile: freezeBoundProfile(normalizeAgentProfile({
        name: 'example', executor: 'example-acp', tools, systemPrompt: () => 'Example',
      })) } });
    const tool = { name: 'manage_task', input: { Action: 'status' } };
    const display = { kind: 'external_permission' as const, options: [], summary: tool.name, detail: tool.input };
    expect(await authorizeExternalTool(bind(['Read']), tool, 1, 'excluded', signal, display)).toBe('deny');
    expect(await authorizeExternalTool(bind([]), tool, 1, 'empty', signal, display)).toBe('deny');
    expect(await authorizeExternalTool(bind(['manage_task']), tool, 1, 'included', signal, display)).toBe('allow');
    expect(await authorizeExternalTool(bind(undefined), tool, 1, 'cleared', signal, display)).toBe('allow');
    expect(await authorizeExternalTool(bind(['*']), tool, 1, 'unrestricted', signal, display)).toBe('allow');
  });

  it('distinguishes a caller native profile catalog from an explicit call-level tool declaration', () => {
    const boundProfile = freezeBoundProfile(normalizeAgentProfile({ name: 'example-native', tools: ['Read', 'Bash'], systemPrompt: () => '' }));
    expect(isToolActive(declaredExternalToolPolicy({ boundProfile }), 'manage_task')).toBe(true);
    expect(isToolActive(declaredExternalToolPolicy({ boundProfile, toolOverride: { tools: ['Read'] } }), 'manage_task')).toBe(false);
    expect(isToolActive(declaredExternalToolPolicy({ boundProfile, toolOverride: { tools: ['*'] } }), 'manage_task')).toBe(true);
  });

  it('keeps external vendor inheritance while enforcing persisted worktree isolation without a mode override', async () => {
    mode = 'yolo';
    const unrestricted = externalContext(true);
    const display = { kind: 'external_permission' as const, options: [], summary: 'Write', detail: {} };
    const writeSource = { name: 'Write', input: { path: '/source/file.ts' } };
    expect(externalPermissionMeta(unrestricted, '/workspace')).toMatchObject({ override: undefined, hostGate: false });
    expect(await authorizeExternalTool(unrestricted, writeSource, 1, 'no-boundary', signal, display)).toBe('inherit');
    worktreeMeta = { worktreeId: 'wt_test', branch: 'example/test', sourceRoot: '/source', baseRef: 'HEAD' };
    const isolated = externalContext(true);
    const meta = externalPermissionMeta(isolated, '/workspace');
    expect(meta).toMatchObject({ override: undefined, hostGate: true });
    expect(meta.policyIdentity).not.toBe(externalPermissionMeta(unrestricted, '/workspace').policyIdentity);
    expect(await authorizeExternalTool(isolated, writeSource, 1, 'protected-write', signal, display)).toBe('deny');
    expect(await authorizeExternalTool(isolated, { name: 'Bash', input: { command: 'git -C /source status' } }, 1, 'source-inspection', signal, display)).toBe('inherit');
    expect(await authorizeExternalTool(isolated, { name: 'Bash', input: { command: 'git -C /source commit -m bad' } }, 1, 'protected-command', signal, display)).toBe('deny');
    expect(await authorizeExternalTool(isolated, { name: 'Write', input: { path: '/workspace/file.ts' } }, 1, 'own-write', signal, display)).toBe('inherit');
    expect(await authorizeExternalTool(isolated, { name: 'Read', input: { path: '/source/file.ts' } }, 1, 'source-read', signal, display)).toBe('inherit');
  });

  it('preserves external auto sensitive-file approval and malformed command rejection', async () => {
    mode = 'auto';
    const context = externalContext();
    const display = { kind: 'external_permission' as const, options: [], summary: 'read', detail: {} };
    expect(await authorizeExternalTool(context, { name: 'Read', input: { path: '/workspace/.env' } }, 1, 'sensitive', signal, display)).toBe('cancelled');
    expect(await authorizeExternalTool(context, { name: 'Bash', input: {} }, 1, 'missing-command', signal, display)).toBe('deny');
  });

  it.each(['manual', 'auto', 'review', 'yolo'] as const)(
    'allows AskUserQuestion in %s mode',
    async (permissionMode) => {
      mode = permissionMode;
      await expect(evaluate({
        toolName: 'AskUserQuestion',
        args: { questions: [] },
      })).resolves.toMatchObject({
        policyName: permissionMode === 'manual' ? 'default-tool-approve' : `${permissionMode === 'review' ? 'auto' : permissionMode}-mode-approve`,
        result: { kind: 'approve' },
      });
    },
  );

  it.each([
    { decision: 'deny', policyName: 'user-configured-deny', resultKind: 'deny' },
    { decision: 'ask', policyName: 'user-configured-ask', resultKind: 'ask' },
  ] as const)(
    'applies user-configured $decision rules before auto-mode approval',
    async ({ decision, policyName, resultKind }) => {
      mode = 'auto';
      rules.push({ decision, scope: 'user', pattern: 'Bash' });

      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'printf first', timeout: 60 },
      })).resolves.toMatchObject({
        policyName,
        result: { kind: resultKind },
      });
    },
  );

  it('applies auto-mode approval before user allow rules', async () => {
    mode = 'auto';
    rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash' });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('applies deny rules before yolo-mode approval', async () => {
    mode = 'yolo';
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
      },
    });
  });

  it('denies writes into the source checkout even in yolo mode', async () => {
    mode = 'yolo';
    worktreeMeta = { worktreeId: 'wt_test', branch: 'kiki/test', sourceRoot: '/source', baseRef: 'HEAD' };
    await expect(evaluate({
      toolName: 'Write', args: { path: '/source/file.ts', content: 'x' },
      accesses: ToolAccesses.writeFile('/source/file.ts'),
    })).resolves.toMatchObject({ policyName: 'worktree-isolation-deny', result: { kind: 'deny' } });
    await expect(evaluate({
      toolName: 'Bash', args: { command: 'git -C /source commit -m bad', timeout: 60 },
    })).resolves.toMatchObject({ policyName: 'worktree-isolation-deny', result: { kind: 'deny' } });
  });

  it.each(['git -C /source log -5', 'git -C /source status --short', 'cd /source && git status', 'git status'])('allows isolated checkout inspection: %s', async (command) => {
    mode = 'yolo';
    worktreeMeta = { worktreeId: 'wt_test', branch: 'kiki/test', sourceRoot: '/source', baseRef: 'HEAD' };
    await expect(evaluate({ toolName: 'Bash', args: { command, cwd: '/source' } })).resolves.toMatchObject({ result: { kind: 'approve' } });
  });

  it.each(['printf x > /source/out', 'git -C /source log >> /source/out', 'cd /source && printf x > out', 'printf x > /source/out; cd /workspace'])('denies identifiable isolated checkout redirection: %s', async (command) => {
    mode = 'yolo';
    worktreeMeta = { worktreeId: 'wt_test', branch: 'kiki/test', sourceRoot: '/source', baseRef: 'HEAD' };
    await expect(evaluate({ toolName: 'Bash', args: { command } })).resolves.toMatchObject({ policyName: 'worktree-isolation-deny', result: { kind: 'deny' } });
  });

  it('gives a Bash deny rule priority over a matching allow rule', async () => {
    rules.push(
      { decision: 'allow', scope: 'user', pattern: 'Bash(arena *)' },
      { decision: 'deny', scope: 'user', pattern: 'Bash' },
    );

    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena clue 语脉', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny' },
    });
  });

  it('requires every Bash segment to satisfy an allow rule outside auto mode', async () => {
    rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(arena *)' });

    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena status', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-allow', result: { kind: 'approve' },
    });
    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena status; ls ../state', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask', result: { kind: 'ask' },
    });
    await expect(evaluate({
      toolName: 'Bash', args: { command: 'cat ../state/.engine_key', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask', result: { kind: 'ask' },
    });
  });

  it('applies composite deny patterns in auto mode before automatic approval', async () => {
    mode = 'auto';
    rules.push(
      { decision: 'allow', scope: 'user', pattern: 'Bash(arena*)' },
      { decision: 'deny', scope: 'user', pattern: 'Bash(*;*)', reason: '禁止分号' },
      { decision: 'deny', scope: 'user', pattern: 'Bash(*&*)', reason: '禁止后台' },
      { decision: 'deny', scope: 'user', pattern: 'Bash(*|*)', reason: '禁止管道' },
      { decision: 'deny', scope: 'user', pattern: 'Bash(*$(*)', reason: '禁止命令替换' },
      { decision: 'deny', scope: 'user', pattern: 'Bash(*`*)', reason: '禁止反引号' },
    );

    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena status', timeout: 60 },
    })).resolves.toMatchObject({ policyName: 'auto-mode-approve', result: { kind: 'approve' } });
    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena status; ls ../state', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny', message: expect.stringContaining('禁止分号') },
    });
    await expect(evaluate({
      toolName: 'Bash', args: { command: 'arena $(cat k)', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny', message: expect.stringContaining('禁止命令替换') },
    });
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-ask',
      result: { kind: 'ask' },
    });
  });

  it('matches session approvals by host, cwd and complete command', async () => {
    sessionApprovalRulePatterns.push(JSON.stringify(['Bash', 'ssh:example', '/srv/project', 'printf first; printf second']));
    const args = { host: 'example', cwd: '/srv/project', command: 'printf first; printf second' };
    await expect(evaluate({ toolName: 'Bash', args })).resolves.toMatchObject({ policyName: 'session-approval-history', result: { kind: 'approve' } });
    for (const changed of [{ ...args, host: 'other' }, { ...args, cwd: '/srv/other' }, { ...args, command: 'printf first' }]) {
      await expect(evaluate({ toolName: 'Bash', args: changed })).resolves.toMatchObject({ policyName: 'fallback-ask', result: { kind: 'ask' } });
    }
  });

  it.each(['HEAD', 'refs/heads/main', 'objects/pack/example.idx'])('allows ordinary git metadata reads: %s', async (target) => {
    await expect(evaluate({ toolName: 'Read', args: { path: `/workspace/.git/${target}` } })).resolves.toMatchObject({ result: { kind: 'approve' } });
  });

  it('applies exact session approval before configured ask, but never before explicit deny', async () => {
    rules.push({ decision: 'ask', scope: 'user', pattern: 'Bash' });
    sessionApprovalRulePatterns.push(JSON.stringify(['Bash', 'local', '/workspace', 'printf first']));
    const input = { toolName: 'Bash', args: { command: 'printf first', timeout: 60 } };
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName: 'session-approval-history', result: { kind: 'approve' },
    });
    rules.push({ decision: 'deny', scope: 'user', pattern: 'Bash' });
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny' },
    });
  });

  it.each([
    { path: '/workspace/.env', policyName: 'sensitive-file-access-ask' },
    { path: '/workspace/.git/config', policyName: 'git-control-path-access-ask' },
  ])('applies $policyName before user allow rules', async ({ path, policyName }) => {
    rules.push({ decision: 'allow', scope: 'user', pattern: 'Write' });

    await expect(evaluate({
      toolName: 'Write',
      args: { path, content: 'x' },
    })).resolves.toMatchObject({
      policyName,
      result: { kind: 'ask' },
    });
  });

  it.each([
    { path: '/workspace/.env', policyName: 'sensitive-file-access-ask' },
    { path: '/workspace/.git/config', policyName: 'git-control-path-access-ask' },
  ])('applies session approval before $policyName, but asks again on a nonmatching call', async ({ path, policyName }) => {
    sessionApprovalRulePatterns.push(`Write(${path})`);
    await expect(evaluate({ toolName: 'Write', args: { path, content: 'x' } })).resolves.toMatchObject({
      policyName: 'session-approval-history', result: { kind: 'approve' },
    });
    await expect(evaluate({ toolName: 'Write', args: { path: `${path}.other`, content: 'x' } })).resolves.toMatchObject({
      policyName, result: { kind: 'ask' },
    });
  });

  it('asks before reading an alias whose resolved target is sensitive', async () => {
    await expect(evaluate({
      toolName: 'Read', args: { path: '/workspace/safe.txt' },
      accesses: ToolAccesses.readFile('/outside/.env'),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('honors matching session approval for external symlink access', async () => {
    sessionApprovalRulePatterns.push('Read(/workspace/alias.txt)');
    await expect(evaluate({ toolName: 'Read', args: { path: '/workspace/alias.txt' },
      accesses: ToolAccesses.readFile('/outside/notes.txt', true) })).resolves.toMatchObject({
      policyName: 'session-approval-history', result: { kind: 'approve' },
    });
    await expect(evaluate({ toolName: 'Read', args: { path: '/workspace/other.txt' },
      accesses: ToolAccesses.readFile('/outside/notes.txt', true) })).resolves.toMatchObject({
      policyName: 'external-link-access-ask', result: { kind: 'ask' },
    });
  });

  describe.each(['manual', 'auto', 'yolo'] as const)('protected reads in %s mode', (permissionMode) => {
    it.each([
      { path: '/workspace/.git/hooks/pre-commit', policyName: 'git-control-path-access-ask' },
      { path: '/workspace/.git/config', policyName: 'git-control-path-access-ask' },
      { path: '/workspace/.env', policyName: 'sensitive-file-access-ask' },
      { path: '/home/tester/.ssh/id_rsa', policyName: 'sensitive-file-access-ask' },
      { path: '/outside/notes.txt', policyName: 'external-link-access-ask', implicitExternal: true },
    ])('handles $path', async ({ path, policyName, implicitExternal }) => {
      mode = permissionMode;
      await expect(evaluate({ toolName: 'Read', args: { path },
        accesses: ToolAccesses.readFile(path, implicitExternal) })).resolves.toMatchObject({
        policyName: permissionMode === 'yolo' ? 'yolo-mode-approve' : policyName,
        result: { kind: permissionMode === 'yolo' ? 'approve' : 'ask' },
      });
    });

    it('handles configured ask and dangerous Bash gates', async () => {
      mode = permissionMode;
      rules.push({ decision: 'ask', scope: 'user', pattern: 'Bash' });
      await expect(evaluate({ toolName: 'Bash', args: { command: 'echo ok' } })).resolves.toMatchObject({
        policyName: permissionMode === 'yolo' ? 'yolo-mode-approve' : 'user-configured-ask',
        result: { kind: permissionMode === 'yolo' ? 'approve' : 'ask' },
      });
      rules.length = 0;
      dangerousBash = 'on';
      await expect(evaluate({ toolName: 'Bash', args: { command: 'shutdown -h now' } })).resolves.toMatchObject({
        policyName: permissionMode === 'yolo' ? 'yolo-mode-approve' : 'dangerous-bash',
        result: { kind: permissionMode === 'yolo' ? 'approve' : 'ask' },
      });
    });

    it('handles workspace-external writes and unknown tool fallback', async () => {
      mode = permissionMode;
      for (const input of [
        { toolName: 'Write', args: { path: '/outside/notes.txt', content: 'x' }, accesses: ToolAccesses.writeFile('/outside/notes.txt') },
        { toolName: 'UnknownTool', args: {} },
      ]) {
        await expect(evaluate(input)).resolves.toMatchObject({
          result: { kind: permissionMode === 'manual' ? 'ask' : 'approve' },
        });
      }
    });
  });

  it('permits sensitive reads in yolo, but explicit deny still wins', async () => {
    mode = 'yolo';
    const input = { toolName: 'Read', args: { path: '/workspace/.env' } };
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName: 'yolo-mode-approve', result: { kind: 'approve' },
    });
    rules.push({ decision: 'deny', scope: 'user', pattern: 'Read' });
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny' },
    });
  });

  it.each(['manual', 'auto', 'yolo'] as const)(
    'handles external symlink reads in %s mode',
    async (permissionMode) => {
      mode = permissionMode;
      await expect(evaluate({
        toolName: 'Read', args: { path: '/workspace/alias.txt' },
        accesses: ToolAccesses.readFile('/outside/notes.txt', true),
      })).resolves.toMatchObject({
        policyName: permissionMode === 'yolo' ? 'yolo-mode-approve' : 'external-link-access-ask',
        result: { kind: permissionMode === 'yolo' ? 'approve' : 'ask' },
      });
    },
  );

  it.each([
    { path: '/workspace/.env', policyName: 'sensitive-file-access-ask', accesses: ToolAccesses.readFile('/workspace/.env') },
    { path: '/workspace/alias.txt', policyName: 'external-link-access-ask', accesses: ToolAccesses.readFile('/outside/notes.txt', true) },
  ])('asks for $policyName in auto unless explicitly denied', async ({ path, policyName, accesses }) => {
    mode = 'auto';
    const input = { toolName: 'Read', args: { path }, accesses };
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName, result: { kind: 'ask' },
    });
    rules.push({ decision: 'deny', scope: 'user', pattern: 'Read' });
    await expect(evaluate(input)).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny' },
    });
  });

  it.each(['routine', 'dangerous', 'sensitive', 'explicit-ask', 'external'] as const)(
    'routes review-mode %s actions through the real policy and approval chain', async (kind) => {
      mode = 'review';
      ix.stub(IConfigService, { get: (() => ({ reviewer: {
        backend: 'model', model: 'review-model', allowThreshold: 0.9, denyThreshold: 0.9,
      } })) as IConfigService['get'] });
      ix.stub(ISessionContext, { sessionId: 'review-session' });
      ix.stub(IEventDispatcher, { dispatch: async () => {} });
      ix.stub(ILogService, { debug: () => {} });
      ix.stub(IAgentContextMemoryService, { get: () => [] });
      const review = vi.fn(async function* () {
        yield { type: 'finish', message: { content: [{ type: 'text', text: '{"outcome":"deny","confidence":0.99}' }] } };
      });
      ix.stub(IModelCatalog, { getRequester: () => ({ request: review }) as never });
      ix.stub(IRequestAdmission, { acquire: async () => ({ release() {} }) });
      const userApproval = vi.fn(async () => ({ decision: 'rejected' as const }));
      ix.stub(ISessionApprovalService, { request: userApproval, enqueue: (request) => ({ ...request, id: request.id! }), decide: () => {} });
      ix.set(IAgentToolApprovalService, new SyncDescriptor(AgentToolApprovalService));
      if (kind === 'explicit-ask' || kind === 'external') rules.push({ decision: 'ask', scope: 'user', pattern: 'Bash' });
      const baseContext = policyContext(kind === 'sensitive'
        ? { toolName: 'Read', args: { path: '/workspace/.env' }, accesses: ToolAccesses.readFile('/workspace/.env') }
        : { toolName: 'Bash', args: { command: kind === 'dangerous' ? 'shutdown -h now' : 'printf hi' } });
      const context: ResolvedToolExecutionHookContext = {
        ...baseContext,
        execution: { ...baseContext.execution, display: kind === 'external' ? {
          kind: 'external_permission', summary: 'Provider permission', options: [{ id: 'reject', label: 'Reject', kind: 'reject_once' }],
        } : undefined },
      };
      const decision = await ix.get(IAgentPermissionGate).authorize(context);
      if (kind === 'routine') expect(decision).toBeUndefined();
      else expect(decision?.veto?.isError).toBe(true);
      expect(review).toHaveBeenCalledTimes(kind === 'dangerous' || kind === 'sensitive' ? 1 : 0);
      expect(userApproval).toHaveBeenCalledTimes(kind === 'explicit-ask' || kind === 'external' ? 1 : 0);
    },
  );

  it('keeps protected actions on review while approving routine actions', async () => {
    mode = 'review';
    await expect(evaluate({ toolName: 'Read', args: { path: '/workspace/.env' }, accesses: ToolAccesses.readFile('/workspace/.env') })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask', result: { kind: 'ask' },
    });
    await expect(evaluate({ toolName: 'Bash', args: { command: 'printf hi' } })).resolves.toMatchObject({
      policyName: 'auto-mode-approve', result: { kind: 'approve' },
    });
    await expect(evaluate({ toolName: 'Bash', args: { command: 'shutdown -h now' } })).resolves.toMatchObject({
      policyName: 'dangerous-bash', result: { kind: 'ask' },
    });
    rules.push({ decision: 'deny', scope: 'user', pattern: 'Bash' });
    await expect(evaluate({ toolName: 'Bash', args: { command: 'printf hi' } })).resolves.toMatchObject({
      policyName: 'user-configured-deny', result: { kind: 'deny' },
    });
  });

  it.each(['EnterPlanMode', 'ExitPlanMode', 'CreateGoal'] as const)(
    'approves %s through the default tool allowlist in manual mode',
    async (toolName) => {
      await expect(evaluate({ toolName, args: {} })).resolves.toMatchObject({
        policyName: 'default-tool-approve',
        result: { kind: 'approve' },
      });
    },
  );

  it('does not intercept dangerous bash in yolo by default', async () => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('asks for dangerous bash in auto by default after auto-mode approval', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-bash',
      result: { kind: 'ask', reason: { dangerous_command: 'shutdown' } },
    });
  });

  it('still approves safe bash in auto by default', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'echo ok', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not intercept dangerous bash in auto when dangerous_bash is off', async () => {
    mode = 'auto';
    dangerousBash = 'off';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('skips dangerous bash approval in yolo even when dangerous_bash is on', async () => {
    mode = 'yolo';
    dangerousBash = 'on';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves a safe substitution heredoc when dangerous_bash is on in yolo', async () => {
    mode = 'yolo';
    dangerousBash = 'on';

    await expect(evaluate({
      toolName: 'Bash',
      args: {
        command: 'gh --body "$(cat <<\'EOF\'\nit\'s $(broken ` text\nEOF\n)"',
        timeout: 60,
      },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('keeps deny rules above dangerous bash ask', async () => {
    mode = 'auto';
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(shutdown *)',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: { kind: 'deny' },
    });
  });

  it('does not let user allow rules exempt dangerous bash in manual', async () => {
    rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'rm -rf /tmp/build', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-bash',
      result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
    });
  });

  it('exempts dangerous Bash only for the exact previously approved command', async () => {
    sessionApprovalRulePatterns.push('Bash', 'Bash(rm -rf /tmp/*)', JSON.stringify(['Bash', 'local', '/workspace', 'rm -rf /tmp/build']));
    await expect(evaluate({ toolName: 'Bash', args: { command: 'rm -rf /tmp/build', timeout: 60 } })).resolves.toMatchObject({
      policyName: 'session-approval-history', result: { kind: 'approve' },
    });
    await expect(evaluate({ toolName: 'Bash', args: { command: 'rm -rf /tmp/other', timeout: 60 } })).resolves.toMatchObject({
      policyName: 'dangerous-bash', result: { kind: 'ask' },
    });
    sessionApprovalRulePatterns.splice(2);
    await expect(evaluate({ toolName: 'Bash', args: { command: 'rm -rf /tmp/build', timeout: 60 } })).resolves.toMatchObject({
      policyName: 'dangerous-bash', result: { kind: 'ask' },
    });
  });

  it('does not ask for unanalyzable bash in auto', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: '$CMD --force', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });
});

describe('AgentPermissionPolicyService git cwd write approval', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let workspace: ReturnType<typeof workspaceStub>;
  let workspaceDir: string;
  let cleanupDirs: string[];
  let pathClass: HostEnvironmentService['pathClass'];

  beforeEach(async () => {
    disposables = new DisposableStore();
    mode = 'manual';
    pathClass = 'posix';
    workspaceDir = await mkdtemp(join(tmpdir(), 'kimi-permission-git-'));
    cleanupDirs = [workspaceDir];
    await mkdir(join(workspaceDir, '.git'), { recursive: true });
    workspace = workspaceStub(workspaceDir);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IConfigService, {
          get: (() => undefined) as IConfigService['get'],
        });
        reg.define(IBashParserService, BashParserService);
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub());
        reg.defineInstance(ISessionWorkspaceContext, workspace.stub);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(IAgentRuntimeService, {
          _serviceBrand: undefined,
          onDidChange: () => ({ dispose: () => {} }),
          isAvailable: () => true,
          inspect() { return (this as IAgentRuntimeService).acquire().runtime; },
          acquire: () => ({
            track: (resource) => resource,
            runtime: {
              identity: { workspaceId: 'test', runtimeId: 'local', generation: 'test' },
              capabilities: new Set(),
              status: 'ready',
              onDidChangeStatus: () => ({ dispose: () => {} }),
              dispose: () => {},
              environment: { pathClass, homeDir: '/home/example', osKind: 'linux', shellName: 'bash', shellPath: '/bin/bash' } as never,
              fs: { realpath: async (path: string) => path } as never,
              path: {
                separator: '/',
                delimiter: ':',
                isAbsolute: () => true,
                join: (...paths: readonly string[]) => join(...paths),
                relative: (from: string, to: string) => to.replace(`${from}/`, ''),
                resolve: (...paths: readonly string[]) => join(...paths),
                basename: (path: string) => basename(path),
                dirname: (path: string) => dirname(path),
              },
              workspace: { mapRoots: (roots) => roots },
            },
            dispose: () => {},
          }),
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.definePartialInstance(IGitService, {
          findWorkTree: (cwd: string) => findGitWorkTree(hostFs, cwd),
        });
        reg.definePartialInstance(ISessionMetadata, { read: async () => ({ id: 'session_test', createdAt: 0, updatedAt: 0, archived: false }), getAgentExecutor: async () => undefined });
        reg.definePartialInstance(IWorktreeService, { list: async () => [] });
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(async () => {
    await disposables.dispose();
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
  });

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = ix.get(IAgentPermissionPolicyService);
    return svc.evaluate(policyContext(input));
  }

  it('still asks for Bash inside a git cwd in manual mode', async () => {
    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('approves Write to a path inside the git cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves Windows git cwd writes using the runtime path class', async () => {
    pathClass = 'win32';
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve', result: { kind: 'approve' },
    });
    for (const target of [join(`${workspaceDir}-other`, 'a.ts'), 'Z:\\other\\a.ts']) {
      await expect(evaluate({ toolName: 'Write', args: { path: target, content: 'x' }, accesses: ToolAccesses.writeFile(target) })).resolves.toMatchObject({ policyName: 'fallback-ask', result: { kind: 'ask' } });
    }
  });

  it('approves Edit on an additionalDir path in manual mode', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    await expect(evaluate({
      toolName: 'Edit',
      args: { path: join(extraDir, 'src/a.ts'), old_string: 'A', new_string: 'B' },
      accesses: ToolAccesses.readWriteFile(join(extraDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not approve writing to a linked skill outside the Git workspace', async () => {
    const linkedSkillTarget = join(tmpdir(), 'installed-skill', 'SKILL.md');
    await expect(evaluate({
      toolName: 'Write', args: { path: join(workspaceDir, '.agents/skills/example/SKILL.md'), content: 'x' },
      accesses: ToolAccesses.writeFile(linkedSkillTarget),
    })).resolves.toMatchObject({ policyName: 'fallback-ask', result: { kind: 'ask' } });
  });

  it('asks for paths outside cwd and additionalDirs', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    const outsidePath = join(`${extraDir}-evil`, 'outside.ts');
    await expect(evaluate({
      toolName: 'Write',
      args: { path: outsidePath, content: 'x' },
      accesses: ToolAccesses.writeFile(outsidePath),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for git control files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.git/config')),
    })).resolves.toMatchObject({
      policyName: 'git-control-path-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for sensitive files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.env', content: 'SECRET=1' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.env')),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks before writing a sensitive target in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write', args: { path: '.env', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.env')),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('keeps git control review in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write', args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.git/config')),
    })).resolves.toMatchObject({
      policyName: 'git-control-path-access-ask', result: { kind: 'ask' },
    });
  });

  it('does not use git-cwd approval in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not approve Write when execution has no write file access', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.none(),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not approve when any write access is outside the cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: [
        { kind: 'file', operation: 'write', path: join(workspaceDir, 'src/a.ts') },
        { kind: 'file', operation: 'write', path: join(tmpdir(), 'outside.ts') },
      ],
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });
});

interface MutablePermissionRulesStubOptions {
  readonly rules?: () => readonly PermissionRule[];
  readonly sessionApprovalRulePatterns?: () => readonly string[];
}

function permissionRulesStub(
  options: MutablePermissionRulesStubOptions = {},
): Partial<PermissionRulesServiceContract> {
  const rules = options.rules ?? (() => []);
  const sessionApprovalRulePatterns = options.sessionApprovalRulePatterns ?? (() => []);
  return {
    get rules() {
      return rules();
    },
    get sessionApprovalRulePatterns() {
      return sessionApprovalRulePatterns();
    },
    addRules: () => {},
    recordApprovalResult: () => {},
  };
}

interface PolicyContextInput {
  readonly id?: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly accesses?: ToolAccessList;
}

function policyContext(input: PolicyContextInput): ResolvedToolExecutionHookContext {
  const toolCall = toolCallFor(input.id ?? `call_${input.toolName}`, input.toolName, input.args);
  const subject = ruleSubject(input.toolName, input.args);
  return {
    turnId: 0,
    signal,
    toolCall,
    toolCalls: [toolCall],
    args: input.args,
    execution: {
      description: description(input.toolName),
      display: display(input.toolName, input.args),
      accesses: input.accesses ?? accesses(input.toolName, input.args),
      shellContext: input.toolName === 'Bash' ? { runtimeId: typeof input.args['host'] === 'string' ? `ssh:${input.args['host']}` : 'local', cwd: stringArg(input.args, 'cwd', '/workspace'), pathClass: 'posix' } : undefined,
      sessionApprovalRule: input.toolName === 'Bash' ? JSON.stringify(['Bash', typeof input.args['host'] === 'string' ? `ssh:${input.args['host']}` : 'local', stringArg(input.args, 'cwd', '/workspace'), subject]) : undefined,
      approvalRule:
        subject === undefined ? input.toolName : literalRulePattern(input.toolName, subject),
      matchesRule:
        subject === undefined
          ? undefined
          : (ruleArgs, matchMode) => matchesRuleSubject(input.toolName, ruleArgs, subject, matchMode),
      execute: async () => ({ output: '' }),
    },
  };
}

function toolCallFor(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function ruleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return stringArg(args, 'path');
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function matchesRuleSubject(
  toolName: string,
  ruleArgs: string,
  subject: string,
  mode: 'all' | 'any' = 'all',
): boolean {
  switch (toolName) {
    case 'Bash':
      return matchesBashRuleSubject(ruleArgs, subject, mode);
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, subject, { cwd: '/workspace', pathClass: 'posix' });
    default:
      return matchesGlobRuleSubject(ruleArgs, subject);
  }
}

function description(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    default:
      return `Approve ${toolName}`;
  }
}

function display(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = stringArg(args, 'path', '/workspace/file.txt');
  switch (toolName) {
    case 'Bash':
      return { kind: 'command', command: stringArg(args, 'command') };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    default:
      return { kind: 'generic', summary: `Approve ${toolName}`, detail: args };
  }
}

function accesses(toolName: string, args: Record<string, unknown>): ToolAccessList {
  const path = stringArg(args, 'path');
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
      return path.length > 0 ? ToolAccesses.readFile(path) : ToolAccesses.none();
    case 'Write':
      return path.length > 0 ? ToolAccesses.writeFile(path) : ToolAccesses.none();
    case 'Edit':
      return path.length > 0 ? ToolAccesses.readWriteFile(path) : ToolAccesses.none();
    case 'Grep':
    case 'Glob':
      return path.length > 0 ? ToolAccesses.searchTree(path) : ToolAccesses.none();
    default:
      return ToolAccesses.none();
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function workspaceStub(initialWorkDir: string): {
  readonly stub: ISessionWorkspaceContext;
  addAdditionalDir(dir: string): void;
} {
  let additionalDirs: string[] = [];
  const stub: ISessionWorkspaceContext = {
    _serviceBrand: undefined,
    workDir: initialWorkDir,
    get additionalDirs() {
      return additionalDirs;
    },
    resolve: (path) => path,
    isWithin: () => true,
  };
  return {
    stub,
    addAdditionalDir: (dir) => {
      if (!additionalDirs.includes(dir)) additionalDirs = [...additionalDirs, dir];
    },
  };
}

function kaosStub(pathClass: HostEnvironmentService['pathClass'] = 'posix'): HostEnvironmentService {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass,
    homeDir: '/home/test',
    ready: Promise.resolve(),
  };
}

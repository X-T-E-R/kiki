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
import { assertExternalPermissionSupport, externalPermissionMeta } from '#/agent/execution/externalPermission';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { parseSystemMdProfile } from '@kiki/agent-profiles/systemFile';
import { ShippedAgentProfileSourceService } from '#/app/shippedAgentProfiles/shippedAgentProfileSourceService';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { ErrorCodes, isError2 } from '#/errors';
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

  it.each([false, true])('keeps plugin approval and deny rules with independent scheduling=%s', async (parallel) => {
    const name = 'plugin__fixture__generate';
    const original = policyContext({ toolName: name, args: {}, accesses: ToolAccesses.all() });
    const context = { ...original, execution: { ...original.execution, schedulingAccesses: parallel ? ToolAccesses.readAll() : undefined } };
    await expect(service().evaluate(context)).resolves.toMatchObject({ policyName: 'fallback-ask', result: { kind: 'ask' } });
    rules = [{ decision: 'allow', scope: 'user', pattern: name }];
    await expect(service().evaluate(context)).resolves.toMatchObject({ policyName: 'user-configured-allow', result: { kind: 'approve' } });
    rules = [{ decision: 'deny', scope: 'user', pattern: name }];
    await expect(service().evaluate(context)).resolves.toMatchObject({ policyName: 'user-configured-deny', result: { kind: 'deny' } });
    await expect(ix.get(IAgentPermissionGate).authorize(context)).resolves.toMatchObject({ veto: { isError: true, output: 'Not approved' } });
    expect(context.execution.accesses).toEqual(ToolAccesses.all());
  });

  function externalContext(
    binding: Partial<AgentExecutorContext['binding']> = {},
    worktree: SessionWorktree | undefined = worktreeMeta,
  ): AgentExecutorContext {
    return { agent: { id: 'main', accessor: ix }, descriptor: { id: 'example-acp', protocol: 'acp-v1', args: [], revision: 'r1' },
      binding: { systemPrompt: '', thinkingLevel: 'off', ...binding }, worktree };
  }

  function externalExecution(source: 'session' | 'harness-settings') {
    return { version: 1 as const, generation: 1, selection: { executor: 'example-acp' },
      sources: { permission_mode: source }, effective: { permission_mode: 'manual' as const, kiki_context: [], allow_kiki_subagents: false } };
  }

  function expectUnsupported(context: AgentExecutorContext, subject: string): void {
    let thrown: unknown;
    try {
      assertExternalPermissionSupport(context);
    } catch (error) {
      thrown = error;
    }
    expect(isError2(thrown)).toBe(true);
    if (!isError2(thrown)) return;
    expect(thrown.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(thrown.message).toContain(`cannot enforce ${subject} on vendor-native tools`);
    expect(thrown.details).toEqual({ executorId: 'example-acp', unsupported: [subject] });
  }

  it.each(['manual', 'auto', 'review', 'yolo'] as const)('does not infer an external override from ambient %s mode', (permissionMode) => {
    mode = permissionMode;
    expect(externalPermissionMeta(externalContext())).toEqual({ version: 2, override: undefined });
  });

  it('retains an explicit runtime permission source', () => {
    mode = 'manual';
    ix.stub(IAgentPermissionModeService, { ...stubPermissionModeService(() => mode), externalOverride: 'yolo' });
    expect(externalPermissionMeta(externalContext())).toEqual({ version: 2, override: { mode: 'yolo', source: 'runtime' } });
  });

  it.each([
    ['profile', { permissionMode: 'manual' as const }],
    ['session', { execution: externalExecution('session') }],
    ['harness-settings', { execution: externalExecution('harness-settings') }],
  ] as const)('retains an explicit %s permission source', (source, binding) => {
    expect(externalPermissionMeta(externalContext(binding))).toEqual({ version: 2, override: { mode: 'manual', source } });
  });

  it('diagnoses unsupported external restrictions before vendor startup', () => {
    const cases = [
      { subject: 'Kiki worktree write isolation', context: () => externalContext({}, {
        worktreeId: 'wt_test', branch: 'example/test', sourceRoot: '/source', baseRef: 'HEAD',
      }) },
      { subject: 'execution restriction research-readonly', context: () => externalContext({ executionRestriction: 'research-readonly' }) },
      { subject: 'tools allowlist', context: () => externalContext({ toolOverride: { tools: ['Read'] } }) },
      { subject: 'disallowed_tools', context: () => externalContext({ disallowedTools: ['Bash'] }) },
      { subject: 'permission.rules (user)', context: () => {
        rules = [{ decision: 'deny', scope: 'user', pattern: 'Bash' }];
        return externalContext();
      } },
    ] as const;
    for (const entry of cases) {
      rules = [];
      expectUnsupported(entry.context(), entry.subject);
    }
  });

  it('rejects external review even when the vendor declares a review permission value', () => {
    const base = externalContext({ permissionMode: 'review' });
    const context: AgentExecutorContext = { ...base, descriptor: { ...base.descriptor,
      permission: { via: 'config_option', configId: 'permission-mode', manual: 'manual', review: 'vendor-review', auto: 'auto', yolo: 'yolo' } } };
    expectUnsupported(context, 'review permission mode (Kiki reviewer)');
  });

  it('does not turn allow rules into external authorization', () => {
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash' }];
    const context = externalContext();
    expect(() => assertExternalPermissionSupport(context)).not.toThrow();
    expect(externalPermissionMeta(context)).toEqual({ version: 2, override: undefined });
  });

  it('does not expose ambient native tool catalogs as external declarations', () => {
    const context = externalContext({
      activeToolNames: ['Read'],
      toolAllowPolicies: [['Read']],
      toolPolicyBase: { tools: ['Read'], toolAllowPolicies: [['Read']] },
    });
    expect(() => assertExternalPermissionSupport(context)).not.toThrow();
    expect(externalPermissionMeta(context)).toEqual({ version: 2, override: undefined });
  });

  it.each(['builtin-default', 'inherited-default'] as const)('does not diagnose the %s catalog as an external tools declaration', (source) => {
    const shipped = disposables.add(new ShippedAgentProfileSourceService());
    const profile = source === 'builtin-default' ? { ...shipped.getDefault(), executor: 'example-acp' }
      : parseSystemMdProfile('---\nexecutor: example-acp\n---\nExternal instructions', '/example-home/SYSTEM.md', shipped.getDefault(), () => {});
    const boundProfile = freezeBoundProfile(profile);
    expect(boundProfile.toolsSource).toBe(source);
    expect(boundProfile.fileDefinition?.tools).toEqual(shipped.getDefault().tools);
    for (const bound of [boundProfile, JSON.parse(JSON.stringify(boundProfile))]) {
      const context = externalContext({ boundProfile: bound, activeToolNames: profile.tools });
      expect(() => { assertExternalPermissionSupport(context); }).not.toThrow();
    }
  });

  it.each(['empty', 'finite', 'same-as-default'] as const)('retains a %s explicit SYSTEM.md tools declaration', (selection) => {
    const shipped = disposables.add(new ShippedAgentProfileSourceService());
    const tools = selection === 'empty' ? [] : selection === 'finite' ? ['Read'] : shipped.getDefault().tools;
    const profile = parseSystemMdProfile(`---\nexecutor: example-acp\ntools: ${JSON.stringify(tools)}\n---\nExternal instructions`,
      '/example-home/SYSTEM.md', shipped.getDefault(), () => {});
    expect(profile.toolsSource).toBe('declared');
    const boundProfile = JSON.parse(JSON.stringify(freezeBoundProfile(profile)));
    expectUnsupported(externalContext({ boundProfile }), 'tools allowlist');
  });

  it('does not infer implicit provenance for a legacy snapshot from catalog equality', () => {
    const shipped = disposables.add(new ShippedAgentProfileSourceService());
    const boundProfile = freezeBoundProfile({ ...shipped.getDefault(), executor: 'example-acp', toolsSource: undefined });
    expectUnsupported(externalContext({ boundProfile }), 'tools allowlist');
  });

  it.each(['deny', 'ask'] as const)('retains an explicit %s rule with an implicit external catalog', (decision) => {
    const shipped = disposables.add(new ShippedAgentProfileSourceService());
    const boundProfile = freezeBoundProfile({ ...shipped.getDefault(), executor: 'example-acp' });
    rules = [{ decision, scope: 'project', pattern: 'Bash' }];
    expectUnsupported(externalContext({ boundProfile }), 'permission.rules (project)');
  });

  it.each([
    ['undeclared', {}],
    ['wildcard', { toolOverride: { tools: ['*'] } }],
  ] as const)('allows %s external tools without a native restriction', (_name, binding) => {
    expect(() => assertExternalPermissionSupport(externalContext(binding))).not.toThrow();
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

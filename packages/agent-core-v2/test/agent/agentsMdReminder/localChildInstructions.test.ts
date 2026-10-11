import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { expect, it, vi } from 'vitest';
import { appServices, agentService, sessionService, testAgent, execEnvServices, homeDirServices, hostEnvironmentServices } from '../../harness';
import { Event } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IFlagService } from '#/app/flag/flag';
import { IAgentRuntimeService, AgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { IAgentProfileService } from '#/agent/profile/profile';
import { dynamicPromptKey } from '#/agent/profile/dynamicPrompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { LocalRuntime } from '#/runtime/localRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { ILogService } from '#/_base/log/log';
import { stubFlag } from '../../app/flag/stubs';
import { runWillBeginStepHooks } from '../loop/stubs';

it('discloses local directory instructions for main and a lifecycle-created child with native SSH disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiki-local-instructions-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const nested = join(cwd, 'packages', 'example');
  await mkdir(home, { recursive: true });
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(cwd, 'AGENTS.md'), 'Workspace instructions');
  await writeFile(join(nested, 'AGENTS.md'), 'Nested instructions');
  const target = join(nested, 'example.txt');
  await writeFile(target, 'Local tool content');
  const fs = new HostFileSystem();
  const environment = {
    _serviceBrand: undefined, homeDir: home,
    pathClass: process.platform === 'win32' ? 'win32' : 'posix',
  } as IHostEnvironment;
  const runtime = new LocalRuntime('test-workspace', environment, fs, undefined, undefined, undefined);
  const registry = new RuntimeRegistry('test-workspace');
  registry.register(runtime);
  const flags = stubFlag(false);
  const flagRead = vi.spyOn(flags, 'enabled');
  const acquisitions = vi.fn<IRuntimeResolver['acquire']>((binding, required) => registry.acquire(binding, required));
  const agent = testAgent(
    { cwd }, homeDirServices(home), hostEnvironmentServices(home, environment.pathClass),
    execEnvServices({ hostFs: fs }),
    appServices((reg) => {
      reg.defineInstance(IFlagService, flags);
      reg.defineInstance(IRuntimeResolver, { _serviceBrand: undefined, inspect: binding => registry.inspect(binding), acquire: acquisitions });
      reg.definePartialInstance(IWorkspaceInstanceManager, { onDidChange: Event.None as IWorkspaceInstanceManager['onDidChange'], get: () => undefined });
    }),
    agentService(IAgentRuntimeBindingSeed, { _serviceBrand: undefined, binding: { workspaceId: 'test-workspace', runtimeId: 'local' } }),
    agentService(IAgentRuntimeService, new SyncDescriptor(AgentRuntimeService)),
    sessionService(ISessionStateService, new SyncDescriptor(SessionStateService)),
    sessionService(ISessionMetadata, new SyncDescriptor(SessionMetadata)),
    sessionService(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService)),
  );
  try {
    await agent.ready;
    const lifecycle = agent.get(IAgentLifecycleService);
    const child = await lifecycle.create({ agentId: 'child', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'agent', model: 'mock-model', thinking: 'off' } });
    expect(child.accessor.get(IAgentRuntimeService)).not.toBe(agent.get(IAgentRuntimeService));
    expect(child.accessor.get(IAgentRuntimeBindingService).current).toEqual({ workspaceId: 'test-workspace', runtimeId: 'local' });
    const mainProfile = agent.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService).data();
    for (const accessor of [{ get: agent.get.bind(agent) }, child.accessor]) {
      const service = accessor.get(IAgentRuntimeService);
      const executor = accessor.get(IAgentToolExecutorService);
      const toolCall = { type: 'function' as const, id: 'local-read', name: 'Read', arguments: JSON.stringify({ path: target }) };
      const results: ToolExecutionResult[] = [];
      for await (const result of executor.execute([toolCall], { turnId: 1, signal: new AbortController().signal })) results.push(result);
      expect(results).toHaveLength(1);
      expect(results[0]!.result.isError).not.toBe(true);
      expect(JSON.stringify(results[0]!.result)).toContain('Local tool content');
      flagRead.mockClear();
      const providerError = vi.spyOn(accessor.get(ILogService), 'error');
      await runWillBeginStepHooks(accessor.get(IAgentLoopService));
      const messages = accessor.get(IAgentContextMemoryService).get();
      const instruction = messages.find(message => message.origin?.kind === 'injection' && message.origin.variant === 'agents_md');
      expect.soft(instruction).toBeDefined();
      expect.soft(JSON.stringify(instruction) ?? '').toContain('Nested instructions');
      expect.soft(JSON.stringify(instruction) ?? '').toContain('Host: local');
      expect.soft(providerError).not.toHaveBeenCalledWith('context provider failed; skipping it', expect.objectContaining({ name: 'agents_md' }));
      expect(service.inspect()).toBe(runtime);
      expect.soft(flagRead).not.toHaveBeenCalledWith('native_ssh');
      providerError.mockRestore();
    }
    expect(acquisitions.mock.calls.every(([binding]) => binding.runtimeId === 'local')).toBe(true);
    expect(agent.get(IAgentProfileService).data()).toEqual(mainProfile);
    expect(child.accessor.get(IAgentProfileService).data()).toEqual(childProfile);
    expect(child.accessor.get(IAgentStateService).get(dynamicPromptKey)?.context.agentsMd).toContain('Workspace instructions');
    await lifecycle.remove('child');
  } finally {
    await agent.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 30_000);

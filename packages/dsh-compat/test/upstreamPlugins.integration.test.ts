import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDshCompatEnvironment,
  createNodeHostPorts,
  defineTool,
  type DshCompatEnvironment,
  type DshLiveAgentFacade,
  type DshSubprocessHandle,
  type HostExtensionPortRegistryLike,
} from '../src/index';

const UPSTREAM_PACKAGES = 'C:/Programs/AI/EasyAgent/sources/dsh-core/checkout/packages';
const LSP_SERVER = fileURLToPath(new URL('./fixtures/lspServer.mjs', import.meta.url));
type ApprovedWrapper = Parameters<HostExtensionPortRegistryLike['registerApprovedToolExecutionWrapper']>[1];
type PostPolicy = Parameters<HostExtensionPortRegistryLike['registerToolPostExecutePolicy']>[1];
type PreStepPolicy = Parameters<HostExtensionPortRegistryLike['registerPreStepPolicy']>[1];
type PrePolicy = Parameters<HostExtensionPortRegistryLike['registerToolPreExecutePolicy']>[1];

function captureExtensionSlots() {
  let approvedWrapper: ApprovedWrapper;
  let postPolicy: PostPolicy;
  let preStepPolicy: PreStepPolicy;
  let prePolicy: PrePolicy;
  const registry: HostExtensionPortRegistryLike = {
    registerPromptSection: () => ({ dispose() {} }),
    registerStepContextReminder: () => ({ dispose() {} }),
    registerToolPreExecutePolicy(_id, handler) {
      prePolicy = handler;
      return { dispose() {} };
    },
    registerApprovedToolExecutionWrapper(_id, handler) {
      approvedWrapper = handler;
      return { dispose() {} };
    },
    registerToolPostExecutePolicy(_id, handler) {
      postPolicy = handler;
      return { dispose() {} };
    },
    registerPreStepPolicy(_id, handler) {
      preStepPolicy = handler;
      return { dispose() {} };
    },
  };
  return {
    registry,
    get approvedWrapper() { return approvedWrapper; },
    get postPolicy() { return postPolicy; },
    get preStepPolicy() { return preStepPolicy; },
    get prePolicy() { return prePolicy; },
  };
}

function acquireAgent(env: DshCompatEnvironment, id = 'example-agent'): DshLiveAgentFacade {
  return env.acquireAgent({
    id,
    sessionId: 'example-session',
    generation: 1,
    scopeKey: { tier: 'agent', sessionId: 'example-session', agentId: id },
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('unmodified official DSH plugins on the in-process capability bridge', () => {
  const environments: DshCompatEnvironment[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (environments.length > 0) await environments.pop()!.dispose();
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function environment(options: Parameters<typeof createDshCompatEnvironment>[0] = {}) {
    const env = createDshCompatEnvironment({
      ...options,
      moduleHooks: { pluginRoots: [UPSTREAM_PACKAGES] },
    });
    environments.push(env);
    return env;
  }

  it('loads lsp-stdio + tool-lsp, queries UTF-16 definition/references/hover, and drains the child on Fiber unload', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-real-lsp-'));
    tempDirs.push(workspace);
    const source = [
      'export function alpha() { return 42; }',
      "const face = '😀'; alpha();",
      'alpha();',
    ].join('\n');
    const cursor = source.split('\n')[1].indexOf('alpha') + 1;
    writeFileSync(join(workspace, 'sample.ts'), source);
    const pidFile = join(workspace, 'lsp.pid.json');
    const exitFile = join(workspace, 'lsp.exit.json');
    const ports = createNodeHostPorts({ workspaceRoot: workspace });
    const children: DshSubprocessHandle[] = [];
    const env = environment({
      workspaceRoot: workspace,
      hostPorts: {
        ...ports,
        subprocess: {
          resolveExecutable: (...args) => ports.subprocess.resolveExecutable(...args),
          spawn(spec) {
            const child = ports.subprocess.spawn(spec);
            children.push(child);
            return child;
          },
        },
      },
    });
    const agent = acquireAgent(env);
    const provider = await env.importAndMountPlugin(`${UPSTREAM_PACKAGES}/lsp/lsp-stdio/src/index.ts`, {
      servers: {
        fixture: {
          command: process.execPath,
          args: [LSP_SERVER],
          env: { DSH_TEST_PID_FILE: pidFile, DSH_TEST_EXIT_FILE: exitFile },
          extensionToLanguage: { '.ts': 'typescript' },
          shutdownTimeoutMs: 1000,
          killGraceMs: 500,
        },
      },
    });
    const tool = await env.importAndMountPlugin(`${UPSTREAM_PACKAGES}/lsp/tool-lsp/src/index.ts`, {});
    const query = (operation: string) => env.tools.execute({
      callId: `lsp-${operation}`,
      name: 'lsp',
      arguments: { operation, file_path: 'sample.ts', line: 2, character: cursor },
      agent,
      signal: new AbortController().signal,
    });
    const definition = await query('goToDefinition');
    expect(definition).toMatchObject({
      isError: false,
      value: { kind: 'locations', locations: [{ range: { start: { line: 0, character: 16 } } }] },
      content: [{ type: 'text', text: 'sample.ts:1:17' }],
    });
    const references = await query('findReferences');
    expect(references).toMatchObject({ isError: false });
    expect(references.content).toEqual([{
      type: 'text',
      text: `sample.ts:1:17\nsample.ts:2:${cursor}\nsample.ts:3:1`,
    }]);
    const hover = await query('hover');
    expect(hover).toMatchObject({
      isError: false,
      value: { kind: 'hover', hover: { range: { start: { line: 1, character: cursor - 1 } } } },
      content: [{ type: 'text', text: '`alpha` is an exported function.\n\n```typescript\nexport function alpha()\n```' }],
    });
    expect(env.tools.presentCall('lsp', { operation: 'hover', file_path: 'sample.ts', line: 2, character: cursor }, agent))
      .toMatchObject({ card: 'generic', kind: 'search', title: `LSP hover sample.ts:2:${cursor}` });
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    expect(children).toHaveLength(1);
    expect(children[0].pid).toBe(pid);
    expect(isRunning(pid)).toBe(true);

    await provider.dispose();
    expect(await children[0].done).toEqual({ exitCode: 0, signal: null });
    expect(JSON.parse(readFileSync(exitFile, 'utf8'))).toMatchObject({ pid, reason: 'exit' });
    expect(isRunning(pid)).toBe(false);
    const afterUnload = await query('hover');
    expect(afterUnload.isError).toBe(true);
    await tool.dispose();
    expect(env.tools.schemas(agent)).toEqual([]);
    expect((await env.systemPrompt.render({ agent })).promptText).toBe('');
  });

  it('runs the real timeout-policy through E8 overrideSignal, waits for quiescence, and returns TOOL_TIMEOUT without aborting the caller', async () => {
    const env = environment({ nativeTools: () => [{ name: 'slow_native', timeoutMs: 25 }] });
    const agent = acquireAgent(env);
    const plugin = await env.importAndMountPlugin(`${UPSTREAM_PACKAGES}/guard/timeout-policy/src/index.ts`);
    const slots = captureExtensionSlots();
    env.bindExtensionSlots({ registry: slots.registry, resolveAgent: () => agent });
    const upstream = new AbortController();
    const observedAbort = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let drained = false;
    let settled = false;
    let effectiveSignal: AbortSignal | undefined;
    const pending = slots.approvedWrapper({
      sessionId: agent.sessionId,
      agentId: agent.id,
      turnId: 1,
      toolCallId: 'slow-native-call',
      toolName: 'slow_native',
      approvedArgs: {},
      declaredTimeoutMs: 25,
      execContext: { signal: upstream.signal },
    }, async (overrideSignal) => {
      effectiveSignal = overrideSignal;
      expect(overrideSignal).toBeDefined();
      expect(overrideSignal).not.toBe(upstream.signal);
      expect(env.requireInitiator()).toBe(agent);
      overrideSignal!.addEventListener('abort', () => { observedAbort.resolve(); }, { once: true });
      await observedAbort.promise;
      await release.promise;
      drained = true;
      return { output: 'body finished after cancellation' };
    }).then(result => {
      settled = true;
      return result;
    });
    await observedAbort.promise;
    expect(effectiveSignal!.aborted).toBe(true);
    expect(effectiveSignal!.reason).toMatchObject({ code: 'TOOL_TIMEOUT', timeoutMs: 25 });
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    release.resolve();
    expect(await pending).toEqual({ isError: true, output: 'Error: tool call timed out after 25ms' });
    expect(drained).toBe(true);
    expect(upstream.signal.aborted).toBe(false);

    env.tools.register(defineTool({
      name: 'slow_plugin',
      description: 'Cooperative timeout integration probe',
      parameters: {},
      timeoutMs: 25,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        await new Promise<void>(resolve => {
          exec.signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
        return 'cancelled';
      },
    }));
    const result = await env.tools.execute({
      callId: 'slow-plugin-call', name: 'slow_plugin', arguments: {}, agent, signal: upstream.signal,
    });
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'TOOL_TIMEOUT' } } });
    await plugin.dispose();
    expect(await slots.approvedWrapper({
      sessionId: agent.sessionId, agentId: agent.id, turnId: 1, toolCallId: 'after-unload',
      toolName: 'slow_native', approvedArgs: {}, execContext: { signal: upstream.signal },
    }, async () => ({ output: 'unwrapped' }))).toEqual({ output: 'unwrapped' });
  });

  it('runs the real repeat-tool-reminder through E8/E7 with denied calls, stable multi-step identity, sibling isolation, and user reset', async () => {
    const env = environment();
    const plugin = await env.importAndMountPlugin(`${UPSTREAM_PACKAGES}/guard/repeat-tool-reminder/src/index.ts`, {});
    const alpha = acquireAgent(env, 'alpha');
    const beta = acquireAgent(env, 'beta');
    const slots = captureExtensionSlots();
    env.bindExtensionSlots({
      registry: slots.registry,
      resolveAgent: (_sessionId, id) => {
        const facade = acquireAgent(env, id);
        expect(facade).toBe(id === 'alpha' ? alpha : beta);
        return facade;
      },
    });
    let attempt = 0;
    const defaultArgs = { query: 'alpha', limit: 2 };
    const post = (id: string, wasDenied = false, args = defaultArgs) => slots.postPolicy({
      sessionId: alpha.sessionId, agentId: id, turnId: 1, toolCallId: `call-${++attempt}`,
      toolName: 'search', args, wasDenied,
      result: wasDenied ? { output: 'denied by host', isError: true } : { output: 'found' },
      signal: new AbortController().signal,
    });
    const step = (messages: Parameters<PreStepPolicy>[0]['newMessagesSinceLastStep']) => slots.preStepPolicy({
      sessionId: alpha.sessionId, agentId: alpha.id, turnId: 2, step: 0,
      firstStepOfTurn: true, modelAlias: 'example-model', newMessagesSinceLastStep: messages,
    }, new AbortController().signal);

    expect(await post('alpha')).toBeUndefined();
    expect(await post('alpha', true, { limit: 2, query: 'alpha' })).toBeUndefined();
    expect(await post('beta')).toBeUndefined();
    const third = await post('alpha');
    expect(third).toEqual({ oneOffSystemReminder: {
      variant: 'repeat-tool-reminder',
      text: 'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.',
    } });
    expect(await step([{ role: 'user', content: 'runtime context', origin: { kind: 'injection', variant: 'example-state' } }]))
      .toEqual({ action: 'continue_normal' });
    expect(await post('alpha')).toBeUndefined();
    expect(await post('alpha', true)).toMatchObject({ oneOffSystemReminder: {
      variant: 'repeat-tool-reminder',
      text: expect.stringContaining('- consecutive_calls: 5\n- arguments: {"limit":2,"query":"alpha"}'),
    } });
    expect(await post('beta')).toBeUndefined();
    expect(await post('beta')).toEqual(third);

    expect(await step([{ role: 'user', content: 'Try a new approach', origin: { kind: 'user' } }]))
      .toEqual({ action: 'continue_normal' });
    expect(await post('alpha')).toBeUndefined();
    expect(await post('alpha')).toBeUndefined();
    expect(await post('alpha')).toEqual(third);
    await plugin.dispose();
    for (let i = 0; i < 3; i += 1) expect(await post('alpha')).toBeUndefined();
  });

  it('executes bridged plugin bodies inside the E8 pipeline with each real repeat guard observing a call exactly once', async () => {
    const env = environment();
    const agent = acquireAgent(env);
    await env.importAndMountPlugin(`${UPSTREAM_PACKAGES}/guard/repeat-tool-reminder/src/index.ts`, {});
    env.tools.register(defineTool({
      name: 'echo', description: 'Host approved tool body', parameters: { query: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { return args.query; },
    }));
    const [definition] = env.tools.bridgedDefinitions(agent);
    const slots = captureExtensionSlots();
    env.bindExtensionSlots({ registry: slots.registry, resolveAgent: () => agent });
    for (let count = 1; count <= 5; count += 1) {
      const args = { query: 'same' };
      const signal = new AbortController().signal;
      const context = { sessionId: agent.sessionId, agentId: agent.id, turnId: 1,
        toolCallId: `host-${count}`, toolName: 'echo', args, signal };
      expect(await slots.prePolicy(context)).toEqual({ decision: 'pass' });
      const result = await slots.approvedWrapper({
        ...context, approvedArgs: args, execContext: { signal },
      }, async overrideSignal => ({
        output: await definition.execute(args, { agent, toolCallId: context.toolCallId, signal: overrideSignal! }) as string,
      }));
      expect(result).toEqual({ output: 'same' });
      const post = await slots.postPolicy({ ...context, result });
      if (count === 3 || count === 5) {
        expect(post?.oneOffSystemReminder?.variant).toBe('repeat-tool-reminder');
        if (count === 5) expect(post?.oneOffSystemReminder?.text).toContain('consecutive_calls: 5');
      } else {
        expect(post).toBeUndefined();
      }
    }
  });

  it('waits for active E8 bodies to drain before environment disposal releases services', async () => {
    const env = environment();
    const agent = acquireAgent(env);
    const slots = captureExtensionSlots();
    env.bindExtensionSlots({ registry: slots.registry, resolveAgent: () => agent });
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let drained = false;
    const pending = slots.approvedWrapper({
      sessionId: agent.sessionId, agentId: agent.id, turnId: 1,
      toolCallId: 'disposal-probe', toolName: 'native', approvedArgs: {},
      execContext: { signal: new AbortController().signal },
    }, async signal => {
      signal!.addEventListener('abort', () => { aborted.resolve(); }, { once: true });
      entered.resolve();
      await release.promise;
      drained = true;
      return { output: 'drained' };
    });
    await entered.promise;
    let disposed = false;
    const closing = env.dispose();
    const disposal = closing.then(() => { disposed = true; });
    await aborted.promise;
    const joined = env.dispose();
    expect(joined).toBe(closing);
    expect(disposed).toBe(false);
    expect(drained).toBe(false);
    expect(env.ctx.get('fs')).toBeDefined();
    release.resolve();
    await pending;
    await disposal;
    expect(drained).toBe(true);
    expect(agent.revoked).toBe(true);
    expect(env.ctx.get('fs')).toBeUndefined();
  });
});

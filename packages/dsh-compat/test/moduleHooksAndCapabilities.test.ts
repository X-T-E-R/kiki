import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  canonicalCordisAbi,
  createDshCompatEnvironment,
  createNodeHostPorts,
  defineTool,
  DshCompatError,
  dshBlocksToHostOutput,
  importDshPluginModule,
  inspectDshPluginSource,
  installDshModuleHooks,
  normalizeFsRootPath,
  schemasteryNamespace,
  type DshCompatEnvironment,
  type HostExtensionPortRegistryLike,
  type InstalledDshModuleHooks,
} from '../src/index';

const UPSTREAM_CHECKOUT_ROOT = 'C:/Programs/AI/EasyAgent/sources/dsh-core/checkout';
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

describe('dsh-compat module hooks, diagnostics, and capability bridge', () => {
  const tempDirs: string[] = [];
  const activeHooks: InstalledDshModuleHooks[] = [];
  const activeEnvs: DshCompatEnvironment[] = [];

  afterEach(async () => {
    while (activeEnvs.length > 0) {
      await activeEnvs.pop()!.dispose();
    }
    while (activeHooks.length > 0) {
      activeHooks.pop()!.dispose();
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('normalizes Windows drive-letter casing, slashes, and symlinks and locks Cordis/Scope/Schemastery to one ABI instance', async () => {
    const realRoot = makeTempDir('dsh-compat-real-');
    const pluginFile = join(realRoot, 'samplePlugin.mjs');
    writeFileSync(
      pluginFile,
      [
        "import * as cordis from '@deepseek-ai/cordis';",
        "import * as cosmokit from '@deepseek-ai/cosmokit';",
        "import Schema from '@deepseek-ai/schemastery';",
        "import * as scope from '@deepseek-ai/dsh-scope';",
        'export { cordis, cosmokit, Schema, scope };',
      ].join('\n'),
    );

    const linkParent = makeTempDir('dsh-compat-link-');
    const symlinkRoot = join(linkParent, 'linked-plugin-root');
    symlinkSync(realRoot, symlinkRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const flippedCaseRoot = realRoot.replace(/^[A-Za-z]:/, (drive) =>
      drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase(),
    ).replaceAll('\\', '/');

    expect(normalizeFsRootPath(flippedCaseRoot)).toBe(normalizeFsRootPath(symlinkRoot));

    const hooks = installDshModuleHooks({
      pluginRoots: [flippedCaseRoot],
    });
    activeHooks.push(hooks);

    const loadedViaSymlink = await importDshPluginModule<{
      cordis: typeof canonicalCordisAbi.cordisNamespace;
      cosmokit: typeof canonicalCordisAbi.cosmokitNamespace;
      Schema: typeof schemasteryNamespace.default;
      scope: {
        createScope: typeof canonicalCordisAbi.scopeNamespace.createScope;
        scopeOf: typeof canonicalCordisAbi.scopeNamespace.scopeOf;
        scopeTarget: typeof canonicalCordisAbi.scopeNamespace.scopeTarget;
      };
    }>(join(symlinkRoot, 'samplePlugin.mjs'));

    expect(loadedViaSymlink.cordis.Context).toBe(canonicalCordisAbi.cordisNamespace.Context);
    expect(loadedViaSymlink.cordis.Service).toBe(canonicalCordisAbi.cordisNamespace.Service);
    expect(loadedViaSymlink.cosmokit.defineProperty).toBe(canonicalCordisAbi.cosmokitNamespace.defineProperty);
    expect(loadedViaSymlink.Schema).toBe(canonicalCordisAbi.schemasteryNamespace.default);

    const rootCtx = new canonicalCordisAbi.cordisNamespace.Context();
    const sessionAlphaKey = { tier: 'session' as const, sessionId: 'sess-alpha' };
    const sessionBetaKey = { tier: 'session' as const, sessionId: 'sess-beta' };
    const scopedAlpha = canonicalCordisAbi.scopeNamespace.createScope(rootCtx as never, sessionAlphaKey);
    const scopedBeta = canonicalCordisAbi.scopeNamespace.createScope(rootCtx as never, sessionBetaKey);
    expect(loadedViaSymlink.scope.scopeOf(scopedAlpha.ctx)).toBe(sessionAlphaKey);

    const hits: string[] = [];
    (scopedAlpha.ctx as unknown as { on(name: string, fn: () => void): void }).on('custom/ping', () => {
      hits.push('alpha');
    });
    (scopedBeta.ctx as unknown as { on(name: string, fn: () => void): void }).on('custom/ping', () => {
      hits.push('beta');
    });
    const scopedCarrier = loadedViaSymlink.scope.scopeTarget({ marker: 1 }, sessionAlphaKey);
    (rootCtx as unknown as { emit(thisArg: object, name: string): void }).emit(scopedCarrier, 'custom/ping');
    expect(hits).toEqual(['alpha']);

    await scopedAlpha.dispose();
    await scopedBeta.dispose();
  });

  it('supports redirectPackages overrides for plugin roots', async () => {
    const dir = makeTempDir('dsh-compat-redirect-');
    const customTarget = join(dir, 'customTarget.mjs');
    const consumer = join(dir, 'consumer.mjs');
    writeFileSync(customTarget, 'export const redirectedToken = "ok-redirected";\n');
    writeFileSync(consumer, 'export { redirectedToken } from "example-redirected-pkg";\n');

    const hooks = installDshModuleHooks({
      pluginRoots: [dir],
      redirectPackages: {
        'example-redirected-pkg': customTarget,
      },
    });
    activeHooks.push(hooks);

    const mod = await importDshPluginModule<{ redirectedToken: string }>(consumer);
    expect(mod.redirectedToken).toBe('ok-redirected');
  });

  it('emits deterministic DshCompatError and DshCompatLoadDiagnostic for missing external dependencies and unsupported seams', async () => {
    const hooks = installDshModuleHooks({
      pluginRoots: [UPSTREAM_CHECKOUT_ROOT],
    });
    activeHooks.push(hooks);

    await expect(
      importDshPluginModule(`${UPSTREAM_CHECKOUT_ROOT}/packages/mcp/mcp-client/src/index.ts`),
    ).rejects.toMatchObject({
      name: 'DshCompatError',
      code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
      serviceName: '@modelcontextprotocol/client',
      diagnostic: {
        code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
        kind: 'missing_external_dependency',
        specifier: '@modelcontextprotocol/client',
        serviceName: '@modelcontextprotocol/client',
      },
    });
    expect(hooks.diagnostics.some(d => d.specifier === '@modelcontextprotocol/client')).toBe(true);

    hooks.clearDiagnostics();
    await expect(
      importDshPluginModule(`${UPSTREAM_CHECKOUT_ROOT}/packages/compaction/compaction-basic/src/index.ts`),
    ).rejects.toMatchObject({
      name: 'DshCompatError',
      code: 'DSH_COMPAT_SESSION_SURFACE_UNSUPPORTED',
      diagnostic: {
        code: 'DSH_COMPAT_SESSION_SURFACE_UNSUPPORTED',
        kind: 'unsupported_seam',
      },
    });

    hooks.clearDiagnostics();
    await expect(
      importDshPluginModule(`${UPSTREAM_CHECKOUT_ROOT}/packages/subagent/tool-subagent/src/index.ts`),
    ).rejects.toMatchObject({
      name: 'DshCompatError',
      code: 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
      diagnostic: {
        code: 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
        kind: 'unsupported_seam',
      },
    });

    const tempPluginDir = makeTempDir('dsh-compat-unsupported-');
    const sandboxEntry = join(tempPluginDir, 'sandboxPlugin.mjs');
    writeFileSync(sandboxEntry, "import '@deepseek-ai/dsh-sandbox-local';\nexport const name = 'bad';\n");
    const dbEntry = join(tempPluginDir, 'dbPlugin.mjs');
    writeFileSync(dbEntry, "import '@deepseek-ai/dsh-database';\nexport const name = 'bad-db';\n");

    const extraHooks = installDshModuleHooks({ pluginRoots: [tempPluginDir] });
    activeHooks.push(extraHooks);

    await expect(importDshPluginModule(sandboxEntry)).rejects.toMatchObject({
      code: 'DSH_COMPAT_SANDBOX_POLICY_UNSUPPORTED',
    });
    await expect(importDshPluginModule(dbEntry)).rejects.toMatchObject({
      code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
      serviceName: 'dsh.api/database',
    });

    const env = createDshCompatEnvironment();
    activeEnvs.push(env);
    const badInjectReport = env.inspectPlugin(
      {
        name: 'ui-and-api-plugin',
        inject: ['client', 'api'],
        apply() {},
      },
      { name: '@deepseek-ai/dsh-client-demo', version: '0.1.0' },
    );
    expect(badInjectReport.compatible).toBe(false);
    expect(badInjectReport.mode).toBe('rejected');
    expect(badInjectReport.diagnostics.map(d => d.code)).toContain('DSH_COMPAT_CLIENT_UI_BUNDLE_UNSUPPORTED');
    expect(badInjectReport.diagnostics.map(d => d.code)).toContain('DSH_COMPAT_MISSING_REQUIRED_SERVICE');

    const sourceReport = inspectDshPluginSource(
      "import { x } from '@deepseek-ai/dsh-session-projection';\nimport '@deepseek-ai/dsh-subagent';",
      { name: 'inline-plugin' },
    );
    expect(sourceReport.diagnostics.map(d => d.code)).toEqual([
      'DSH_COMPAT_SESSION_PROJECTION_UNSUPPORTED',
      'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
    ]);
  });

  it('maintains stable === live agent identity, AsyncLocalStorage initiator propagation across await, and revocation fences', async () => {
    const env = createDshCompatEnvironment();
    activeEnvs.push(env);

    const scopeKey = { tier: 'agent' as const, sessionId: 's1', agentId: 'a1' };
    const first = env.acquireAgent({
      id: 'a1',
      sessionId: 's1',
      generation: 1,
      scopeKey,
      requestHeader: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    });
    const secondSameGen = env.acquireAgent({
      id: 'a1',
      sessionId: 's1',
      generation: 1,
      scopeKey,
    });
    const nextGen = env.acquireAgent({
      id: 'a1',
      sessionId: 's1',
      generation: 2,
      scopeKey,
    });

    expect(first).toBe(secondSameGen);
    expect(nextGen).not.toBe(first);
    expect(first.session.requestHeader()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });

    const observed = await env.withAgentInitiator(first, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return env.requireInitiator();
    });
    expect(observed).toBe(first);
    expect(env.currentInitiator()).toBeUndefined();

    env.revokeAgent(first);
    expect(first.revoked).toBe(true);
    await expect(env.withAgentInitiator(first, () => 'nope')).rejects.toThrow(/revoked/);
  });

  it('bridges defineTool across Zod v4, Schemastery, and upstream ParameterSchemaSpec with deep-frozen args, systemPrompt scoping, and host services cleanup', async () => {
    const storageDir = makeTempDir('dsh-compat-attachments-');
    const typertListeners = new Set<(value: unknown) => void>();
    const env = createDshCompatEnvironment({
      workspaceRoot: storageDir,
      hostPorts: {
        ...createNodeHostPorts({ workspaceRoot: storageDir }),
        typert: {
          mode: 'in-process',
          async call({ service, method, args }) {
            return { service, method, args };
          },
          subscribe({ listener }) {
            typertListeners.add(listener);
            return () => {
              typertListeners.delete(listener);
            };
          },
        },
      },
    });
    activeEnvs.push(env);

    const agent = env.acquireAgent({
      id: 'agent-main',
      sessionId: 'sess-main',
      generation: 1,
      scopeKey: { tier: 'agent', sessionId: 'sess-main', agentId: 'agent-main' },
    });

    const zodTool = defineTool({
      name: 'zod_echo',
      description: 'Validates input via Zod v4 StandardSchema',
      parameters: z.object({
        query: z.string(),
        limit: z.number().int().optional(),
        nested: z.object({ tag: z.string() }),
      }),
      output: {
        schema: z.object({ summary: z.string() }),
        render: (_args, value) => [{ type: 'text', text: `Zod:${(value as { summary: string }).summary}` }],
      },
      async execute(args, exec) {
        expect(Object.isFrozen(args)).toBe(true);
        expect(Object.isFrozen(args.nested)).toBe(true);
        expect(exec.agent).toBe(agent);
        expect(env.requireInitiator()).toBe(agent);
        return { summary: `${args.query}:${args.nested.tag}:${args.limit ?? 0}` };
      },
    });

    const Schema = schemasteryNamespace.default;
    const schemasteryTool = defineTool({
      name: 'schemastery_sum',
      description: 'Validates input via Schemastery',
      parameters: Schema.object({
        a: Schema.number().required(),
        b: Schema.number().default(10),
      }),
      output: {
        schema: { type: 'number' },
        render: (_args, value) => [{ type: 'text', text: `Sum=${String(value)}` }],
      },
      async execute(args) {
        const typed = args as { a: number; b?: number };
        return typed.a + (typed.b ?? 10);
      },
    });

    const multimodalTool = defineTool({
      name: 'capture_chart',
      description: 'Stores a PNG image via ctx.attachments and returns multimodal blocks',
      parameters: {
        title: { type: 'string', description: 'Chart title', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            image: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
        },
        render(_args, value) {
          const v = value as {
            title: string;
            image: {
              attachmentId: never;
              mediaType: 'image/png';
              bytes: number;
              width: number;
              height: number;
              name?: string;
            };
          };
          return [
            { type: 'text', text: `Captured ${v.title}` },
            { type: 'image', attachment: v.image },
            {
              type: 'resource_link',
              uri: 'file:///workspace/chart-report.md',
              name: 'chart-report.md',
              mimeType: 'text/markdown',
            },
          ];
        },
      },
      async execute(args) {
        const [saved] = await env.ctx.attachments.saveImages([{
          data: ONE_BY_ONE_PNG,
          mediaType: 'image/png',
          name: 'chart.png',
        }]);
        expect(saved.width).toBe(1);
        expect(saved.height).toBe(1);
        return { title: args.title, image: saved };
      },
    });

    const pluginHandle = await env.mountPlugin({
      name: 'local-capability-bundle',
      inject: ['tools', 'systemPrompt', 'settings', 'typert'],
      apply(ctx: DshCompatEnvironment['ctx']) {
        ctx.tools.register(zodTool);
        ctx.tools.register(schemasteryTool);
        ctx.tools.register(multimodalTool);
        ctx.systemPrompt.variable('env_mode', () => `mode:${env.currentInitiator()?.id ?? 'none'}`);
        ctx.systemPrompt.section({
          name: 'core-guidance',
          order: 10,
          text: 'Guidance({{env_mode}})',
        });
        ctx.effect(() =>
          env.systemPrompt.section({
            id: 'late-guidance',
            order: 20,
            render: vars => `SecondSection(${vars['env_mode']})`,
          }),
        );
        ctx.effect(() =>
          env.systemPrompt.context({
            id: 'dynamic-reminder',
            collect: async current => `ReminderFor:${current.sessionId}`,
          }),
        );
      },
    });

    expect(env.tools.schemas(agent).map(s => s.name)).toEqual([
      'zod_echo',
      'schemastery_sum',
      'capture_chart',
    ]);

    const zodRes = await env.tools.execute({
      callId: 'call-1',
      name: 'zod_echo',
      arguments: { query: 'hello', limit: 3, nested: { tag: 'v4' } },
      agent,
      signal: new AbortController().signal,
    });
    expect(zodRes.isError).toBe(false);
    expect(zodRes.content).toEqual([{ type: 'text', text: 'Zod:hello:v4:3' }]);

    const badZodRes = await env.tools.execute({
      callId: 'call-bad',
      name: 'zod_echo',
      arguments: { query: 123 },
      agent,
      signal: new AbortController().signal,
    });
    expect(badZodRes.isError).toBe(true);
    if (badZodRes.isError) {
      expect(badZodRes.error.info?.code).toBe('INVALID_ARGS');
    }

    const sumRes = await env.tools.execute({
      callId: 'call-2',
      name: 'schemastery_sum',
      arguments: { a: 7 },
      agent,
      signal: new AbortController().signal,
    });
    expect(sumRes.isError).toBe(false);
    expect(sumRes.content).toEqual([{ type: 'text', text: 'Sum=17' }]);

    const chartBridged = env.tools.bridgedDefinitions(agent).find(d => d.name === 'capture_chart')!;
    const chartValue = await chartBridged.execute(
      { title: 'Latency' },
      { agent, toolCallId: 'call-3', signal: new AbortController().signal },
    );
    const renderedBlocks = chartBridged.renderOutput!({ title: 'Latency' }, chartValue);
    expect(Array.isArray(renderedBlocks)).toBe(true);

    const chartExec = await env.tools.execute({
      callId: 'call-4',
      name: 'capture_chart',
      arguments: { title: 'Throughput' },
      agent,
      signal: new AbortController().signal,
    });
    expect(chartExec.isError).toBe(false);
    const hostParts = dshBlocksToHostOutput(chartExec.content, env.hostServices.attachmentStore);
    expect(Array.isArray(hostParts)).toBe(true);
    if (Array.isArray(hostParts)) {
      expect(hostParts).toHaveLength(3);
      expect(hostParts[0]).toEqual({ type: 'text', text: 'Captured Throughput' });
      expect(hostParts[1]).toMatchObject({
        type: 'image_url',
        imageUrl: {
          url: `data:image/png;base64,${ONE_BY_ONE_PNG.toString('base64')}`,
          mimeType: 'image/png',
          size: ONE_BY_ONE_PNG.byteLength,
          name: 'chart.png',
        },
      });
      expect(hostParts[2]).toMatchObject({
        type: 'text',
        resourceLink: {
          uri: 'file:///workspace/chart-report.md',
          name: 'chart-report.md',
          mimeType: 'text/markdown',
        },
      });
    }

    let promptSectionHandler: Parameters<HostExtensionPortRegistryLike['registerPromptSection']>[0] | undefined;
    let stepReminderHandler: Parameters<HostExtensionPortRegistryLike['registerStepContextReminder']>[0] | undefined;
    const mockRegistry: HostExtensionPortRegistryLike = {
      registerPromptSection(c) {
        promptSectionHandler = c;
        return { dispose() { promptSectionHandler = undefined; } };
      },
      registerStepContextReminder(c) {
        stepReminderHandler = c;
        return { dispose() { stepReminderHandler = undefined; } };
      },
      registerPreStepPolicy: () => ({ dispose() {} }),
      registerToolPreExecutePolicy: () => ({ dispose() {} }),
      registerApprovedToolExecutionWrapper: () => ({ dispose() {} }),
      registerToolPostExecutePolicy: () => ({ dispose() {} }),
    };
    const unbind = env.bindExtensionSlots({
      registry: mockRegistry,
      resolveAgent: () => agent,
    });

    const renderedPrompt = await promptSectionHandler!.render({
      sessionId: agent.sessionId,
      agentId: agent.id,
    });
    expect(renderedPrompt).toBe('Guidance(mode:agent-main)\n\nSecondSection(mode:agent-main)');

    const renderedReminder = await stepReminderHandler!.collect({
      sessionId: agent.sessionId,
      agentId: agent.id,
      turnId: 1,
      step: 0,
      isNewTurn: true,
      signal: new AbortController().signal,
    });
    expect(renderedReminder).toBe('ReminderFor:sess-main');

    await pluginHandle.dispose();
    expect(env.tools.schemas(agent)).toEqual([]);
    const afterUnloadPrompt = await promptSectionHandler!.render({
      sessionId: agent.sessionId,
      agentId: agent.id,
    });
    expect(afterUnloadPrompt).toBeUndefined();
    unbind();
    expect(promptSectionHandler).toBeUndefined();

    await expect(
      env.ctx.attachments.saveImages([{
        data: Buffer.from('not-an-image'),
        mediaType: 'image/png',
      }]),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('withdraws only its own services and can remount on the same external Cordis context', async () => {
    const context = new canonicalCordisAbi.cordisNamespace.Context();
    const hostService = { marker: 'host-owned' };
    context.provide('external', hostService);
    const first = createDshCompatEnvironment({ context });
    activeEnvs.push(first);
    await first.ready;
    expect(context.get('tools')).toBeDefined();
    await first.dispose();
    for (const service of ['agents', 'tools', 'systemPrompt', 'lsp', 'attachments', 'settings']) {
      expect(context.get(service as 'tools')).toBeUndefined();
    }
    expect(context.get('external' as 'tools')).toEqual(hostService);
    const second = createDshCompatEnvironment({ context });
    activeEnvs.push(second);
    await second.ready;
    expect(context.get('tools')).toBeDefined();
  });

  it('rejects DSHCompatError on incompatible mountPlugin calls unless explicitly bypassed', async () => {
    const env = createDshCompatEnvironment();
    activeEnvs.push(env);

    await expect(
      env.mountPlugin({
        name: 'requires-database',
        inject: ['database'],
        apply() {},
      }),
    ).rejects.toBeInstanceOf(DshCompatError);
  });
});

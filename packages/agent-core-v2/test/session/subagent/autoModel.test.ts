import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAgentProfile } from '@kiki/agent-profiles/agentProfile';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { IModelService } from '#/kosong/model/model';
import { IModelCatalog } from '#/kosong/model/catalog';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { SubagentConfigSchema } from '#/session/subagent/configSection';
import { autoModelCandidates, weightedAutoModel, requireAutoModelChoice } from '#/session/subagent/autoModel';
import { resolveAutoModelScript, runAutoModelScript } from '#/session/subagent/autoModelScript';
import { resolveAutoModelPlugin, runAutoModelPlugin } from '#/session/subagent/autoModelPlugin';
import { IPluginHostService } from '#/app/plugin/pluginHostService';

const candidates = [
  { alias: 'fast', thinking_effort: 'low' },
  { alias: 'deep', when: 'Complex work', thinking_effort: 'high' },
];
const request = { description: 'Private description', prompt: 'Private prompt', candidates };
const services: TestInstantiationService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

function script(code: string, timeout = 2) {
  return { script: 'owner', scripts: [{ id: 'owner', command: process.execPath, args: ['-e', code], workspaces: [process.cwd()], timeout }] };
}

describe('first-dispatch model selectors', () => {
  it('selects by nonnegative relative weights and rejects an empty weighted pool', () => {
    expect(weightedAutoModel(candidates, { fast: 0, deep: 2 })).toEqual(candidates[1]);
    expect(weightedAutoModel([{ alias: 'constructor', thinking_effort: 'off' }])).toEqual({ alias: 'constructor', thinking_effort: 'off' });
    expect(() => weightedAutoModel(candidates, { fast: 0, deep: 0 })).toThrow(/positively weighted/);
    expect(() => weightedAutoModel([])).toThrow(/positively weighted/);
    expect(SubagentConfigSchema.safeParse({ autoModel: { weights: { fast: -1 } } }).success).toBe(false);
    expect(SubagentConfigSchema.safeParse({ autoModel: { script: 'owner', plugin: { id: 'example', tool: 'Pick' } } }).success).toBe(false);
  });

  it('accepts only an exact eligible alias and cannot override caller effort', () => {
    expect(requireAutoModelChoice({ model_alias: 'deep' }, candidates)).toEqual(candidates[1]);
    for (const output of [null, [], 'deep', {}, { model_alias: 'auto' }, { model_alias: 'outside' },
      { model_alias: 'deep', effort: 'low' }, { model_alias: 'deep', command: 'ignored' }]) {
      expect(() => requireAutoModelChoice(output, candidates)).toThrow();
    }
  });

  it('filters provider defaults and effective hard effort constraints before dispatch', () => {
    const ix = new TestInstantiationService();
    services.push(ix);
    ix.stub(IConfigService, { get: <T>() => undefined as T });
    ix.stub(IModelService, { list: () => ({ fast: {}, deep: {}, missing: {} }), resolveId: (id) => id });
    ix.stub(IModelCatalog, { get: (id) => ({ id, name: id, aliases: [], protocol: 'openai', headers: {},
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true }, maxContextSize: 1000, supportEfforts: ['low', 'high'],
      defaultEffort: id === 'missing' ? undefined : 'high', alwaysThinking: false, providerName: 'example',
      imagePolicy: { acceptedTypes: new Set(['image/png']), convertUnsupported: 'off' }, authProvider: { getAuth: async () => undefined },
    }) });
    ix.stub(IAgentExecutorRegistry, {});
    const input = { config: ix.get(IConfigService), models: ix.get(IModelService), modelCatalog: ix.get(IModelCatalog), executors: ix.get(IAgentExecutorRegistry) };
    const profile = normalizeAgentProfile({ name: 'helper', modelAlias: 'fast', allowedEfforts: ['high'],
      modelProfiles: [{ alias: 'deep', when: 'Complex work', thinkingEffort: 'low' }], systemPrompt: () => '' });
    expect(autoModelCandidates(profile, undefined, input)).toEqual([{ alias: 'fast', when: undefined, thinking_effort: 'high' }]);
    expect(autoModelCandidates(profile, 'high', input).map((candidate) => candidate.alias)).toEqual(['fast', 'deep', 'missing']);
    expect(autoModelCandidates(profile, 'low', input)).toEqual([]);
  });

  it('rechecks normalized external identities and keeps explicit effort', () => {
    const ix = new TestInstantiationService();
    services.push(ix);
    ix.stub(IConfigService, { get: <T>() => undefined as T });
    ix.stub(IModelService, { resolveId: (id) => id });
    ix.stub(IModelCatalog, {});
    ix.stub(IAgentExecutorRegistry, {
      resolve: () => ({ descriptor: { id: 'example-executor', protocol: 'acp-v1', args: [], revision: 'one' }, options: {} }),
      validateBinding: (_id, _options, binding) => ({ ok: true, binding: { modelAlias: binding.modelAlias === 'bad' ? 'outside' : binding.modelAlias,
        thinkingEffort: binding.modelAlias === 'changed' ? 'low' : binding.thinkingEffort } }),
    });
    const input = { config: ix.get(IConfigService), models: ix.get(IModelService), modelCatalog: ix.get(IModelCatalog), executors: ix.get(IAgentExecutorRegistry) };
    const profile = normalizeAgentProfile({ name: 'helper', executor: 'example-executor', allowedModels: ['good', 'bad', 'changed'], systemPrompt: () => '' });
    expect(autoModelCandidates(profile, 'high', input)).toEqual([{ alias: 'good', when: undefined, thinking_effort: 'high' }]);
    expect(autoModelCandidates(profile, undefined, input)).toEqual([{ alias: 'changed', when: undefined, thinking_effort: 'low' }]);
  });

  it.each([
    ['process.stdout.write("not-json")', /invalid JSON/],
    ['process.stdout.write("x".repeat(8193))', /exceeded 8192 bytes/],
    ['process.exit(7)', /exited unsuccessfully/],
    ['setInterval(() => {}, 100)', /timed out/],
  ] as const)('reports a script failure without an alternate selection: %s', async (code, message) => {
    const host = new HostProcessService();
    try {
      const destination = resolveAutoModelScript(script(code, 1), process.cwd());
      await expect(runAutoModelScript(host, destination, request, new AbortController().signal)).rejects.toThrow(message);
    } finally {
      await host.dispose();
    }
  });

  it('does not resolve a script registered for another workspace', () => {
    expect(() => resolveAutoModelScript(script(''), `${process.cwd()}/not-approved`)).toThrow(/not registered/);
  });

  it('does not return or log plugin exceptions containing dispatch text', async () => {
    const ix = new TestInstantiationService();
    services.push(ix);
    const definition = { schemaVersion: 1 as const, name: 'Pick', description: 'Pick', accesses: [{ kind: 'all' as const }], disclosure: 'deferred' as const };
    ix.stub(IPluginHostService, { list: async () => [{ pluginId: 'example', definition }], execute: async () => { throw new Error(request.prompt); } });
    const host = ix.get(IPluginHostService);
    const destination = await resolveAutoModelPlugin(host, { id: 'example', tool: 'Pick' });
    const failure = await runAutoModelPlugin(host, destination, request,
      new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'config.invalid', message: 'Model selector plugin execution failed.' });
    expect(JSON.stringify(failure)).not.toContain(request.prompt);
    expect((failure as Error).cause).toBeUndefined();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Event } from '#/_base/event';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { renderPromptTemplateResult } from '@kiki/agent-profiles/profileShared';
import { appService, createTestAgent, homeDirServices, sessionService } from '../../harness';

export async function coldPromptFixture(position: 'sub' | 'independent', binding: Pick<ProfileData, 'executorId' | 'modelAlias'>, registry: IAgentExecutorRegistry) {
  const home = await mkdtemp(join(tmpdir(), 'cold-external-prompt-'));
  const definition = normalizeAgentProfile({ name: 'fixture-role', executor: binding.executorId, renderSystemPrompt: (context) => renderPromptTemplateResult('Role ${guidance}', context, { skillActive: false }) });
  const catalog: ISessionAgentProfileCatalog = {
    _serviceBrand: undefined, ready: Promise.resolve(), onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: () => definition, getDefault: () => definition, list: () => [definition], listRoutes: () => [], routeDiagnostics: () => [],
    resolveSelection: () => ({ profile: definition, baseProfile: definition, route: undefined }), inspect: () => undefined, load: async () => {}, reload: async () => {},
  };
  const create = (guidance: string) => createTestAgent(homeDirServices(home), appService(IAgentExecutorRegistry, { ...registry, validateBinding: (_id, _options, selected) => ({ ok: true, binding: selected }) }), sessionService(ISessionAgentProfileCatalog, catalog), {
    initialConfig: { prompt: { overrides: { fields: { 'system.shared': `SHARED_${guidance}` } }, variables: { guidance } } },
  });
  const original = create('OLD');
  let before: ProfileData;
  try {
    const profile = original.get(IAgentProfileService);
    await profile.bind({ profile: definition.name, model: binding.modelAlias, delegationPosition: position });
    before = JSON.parse(JSON.stringify(profile.data())) as ProfileData;
  } finally { await original.dispose(); }
  const restored = create('NEW');
  const profile = restored.get(IAgentProfileService);
  profile.applyBindingSnapshot(before);
  return { profile, before, dispose: async () => { await restored.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } };
}

import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyLease } from '#/app/agentProfileCatalog/applySubagentLease';
import { promptConfigurationChannels } from '#/agent/profile/promptDiagnostics';
import { freezeBoundProfile, recoverLegacyPromptFields } from '#/agent/profile/boundProfile';
import { resolveProfilePromptFields } from '#/agent/profile/promptFieldSnapshot';
import { IConfigService } from '#/app/config/config';
import { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import { IModelService } from '#/kosong/model/model';
import { createTestAgent } from '../../harness';

const role = normalizeAgentProfile({ name: 'helper', description: 'Helper', systemPrompt: () => 'ROLE', modelProfiles: [{ alias: 'fast', promptMode: 'append', prompt: 'ROLE MODEL' }] });

function channels(mode: 'preserve' | 'replace', promptMode: 'append') {
  const profile = applyLease(role, { name: 'helper', modelPrompts: mode, modelProfiles: [{ alias: 'fast', promptMode, prompt: 'LEASE MODEL' }] });
  return promptConfigurationChannels({ profile, alias: 'fast', position: 'sub', fields: { values: {}, fields: [] }, resolveId: (alias) => alias, overrideDeclarations: [], leaseMode: mode });
}

describe('prompt source diagnostics', () => {
  it('recovers legacy inline fields from the saved role and caller lease instead of changed configuration', async () => {
    const agent = createTestAgent();
    try {
      const profile = applyLease(normalizeAgentProfile({ ...role,
        promptOverrides: { fields: { 'system.shared': 'SAVED SHARED' } },
      }), { name: role.name, modelProfiles: [{ alias: 'mock-model', promptOverrides: { fields: { 'tool.read.description': 'SAVED READ' } } }] });
      const fields = await resolveProfilePromptFields(profile, 'mock-model', 'sub', agent.get(IConfigService), agent.get(IModelService), agent.get(IPromptFieldRegistry));
      const diagnostics = { identity: { profile: role.name, model_alias: 'mock-model', delegation_position: 'sub' as const, executor: 'native' }, apply_on: 'next-binding-or-context-rebuild' as const,
        channels: promptConfigurationChannels({ profile, alias: 'mock-model', position: 'sub', fields, resolveId: (id) => id, overrideDeclarations: [] }) };
      expect(recoverLegacyPromptFields(freezeBoundProfile(profile), diagnostics, 'mock-model', (id) => id)?.values).toEqual({ 'system.shared': 'SAVED SHARED', 'tool.read.description': 'SAVED READ' });
      const unknown = { ...diagnostics, channels: diagnostics.channels.map((channel) => ({ ...channel, sources: channel.sources.map((source) => ({ ...source, surface: 'global' })) })) };
      expect(recoverLegacyPromptFields(freezeBoundProfile(profile), unknown, 'mock-model', (id) => id)).toBeUndefined();
    } finally { await agent.dispose(); }
  });
  it('identifies preserved role and lease sources in their application order', () => {
    expect(channels('preserve', 'append').filter((channel) => channel.channel === 'model_profile')).toMatchObject([
      { state: 'effective', reason: expect.stringContaining('preserves'), sources: [{ surface: 'profile-model', order: 0 }] },
      { state: 'effective', sources: [{ surface: 'caller-lease-model', order: 1 }] },
    ]);
  });

  it('reports the original role source as shadowed when the lease explicitly replaces prompt sources', () => {
    expect(channels('replace', 'append').filter((channel) => channel.channel === 'model_profile')).toMatchObject([
      { state: 'shadowed', reason: expect.stringContaining('explicitly replaces'), sources: [{ surface: 'profile-model' }] },
      { state: 'effective', sources: [{ surface: 'caller-lease-model' }] },
    ]);
  });

  it.each(['preserve', 'replace'] as const)('keeps actual role and caller lease provenance on resolved fields under %s', async (mode) => {
    const agent = createTestAgent();
    try {
      const original = normalizeAgentProfile({ ...role, sourcePath: '/role.md', modelProfiles: [{ alias: 'mock-model', promptOverrides: { fields: { 'system.shared': 'ROLE FIELD' } } }] });
      const profile = applyLease(original, { name: original.name, modelPrompts: mode, modelProfiles: [{ alias: 'mock-model', promptOverrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] });
      const fields = await resolveProfilePromptFields(profile, 'mock-model', 'sub', agent.get(IConfigService), agent.get(IModelService), agent.get(IPromptFieldRegistry));
      expect(fields.values['system.shared']).toBe('LEASE FIELD');
      const sources = fields.fields.find((field) => field.id === 'system.shared')?.sources;
      expect(sources?.map((source) => source.surface)).toEqual(mode === 'preserve' ? ['profile-model', 'caller-lease-model'] : ['caller-lease-model']);
      if (mode === 'preserve') expect(sources?.[0]?.path).toBe('/role.md');
      expect(sources?.at(-1)?.path).toBeUndefined();
      expect(sources?.map((source) => source.declarationIndex)).toEqual(mode === 'preserve' ? [0, 1] : [0]);
    } finally { await agent.dispose(); }
  });

  it('keeps native replacement shadowing and per-layer Recipe field provenance without hiding model-profile prompts', async () => {
    const agent = createTestAgent();
    try {
      agent.kimiConfig = { ...agent.kimiConfig, models: { ...agent.kimiConfig.models, 'mock-model': { ...agent.kimiConfig.models!['mock-model']!, cognition: { overlayMode: 'replace', overlay: 'cognition/overlay.md' } } } };
      agent.get(IModelService).loadAll({ 'mock-model': { ...agent.get(IModelService).get('mock-model'), cognition: agent.kimiConfig.models!['mock-model']!.cognition } }, 'mock-model');
      expect(agent.get(IModelService).get('mock-model')?.cognition?.overlayMode).toBe('replace');
      const resolved = { revision: 'package-revision', model: {}, model_origins: {}, dependencies: [], origins: [], branches: { main: { fields: { 'system.language': 'RECIPE LANGUAGE', 'system.shared': 'RECIPE SHARED' } }, sub: { fields: {} }, independent: { fields: {} } } };
      const recipe = { ...resolved, layers: [{ surface: 'profile' as const, installation_id: 'profile-package', resolved }] };
      const profile = normalizeAgentProfile({ ...role, modelProfiles: [{ alias: 'mock-model', promptMode: 'append', prompt: 'MODEL PROFILE BODY' }] });
      const fields = await resolveProfilePromptFields(profile, 'mock-model', 'main', agent.get(IConfigService), agent.get(IModelService), agent.get(IPromptFieldRegistry), recipe);
      expect(fields.fields.find((field) => field.id === 'system.language')).toMatchObject({ status: 'shadowed', sources: [{ surface: 'recipe', path: 'profile:profile-package@package-revision' }] });
      expect(fields.values['system.shared']).toBe('RECIPE SHARED');
      const diagnostics = promptConfigurationChannels({ profile, alias: 'mock-model', position: 'main', cognition: agent.kimiConfig.models!['mock-model']!.cognition, recipe: { installation_id: 'profile-package', resolved: recipe }, fields, resolveId: (id) => id, overrideDeclarations: [] });
      expect(diagnostics.find((channel) => channel.id === 'cognition.overlay')?.state).toBe('effective');
      expect(diagnostics.find((channel) => channel.channel === 'model_profile')?.reason).toContain('cognition overlay');
      expect(diagnostics.some((channel) => channel.reason_code === 'recipe-selected')).toBe(false);
    } finally { await agent.dispose(); }
  });

  it('does not attribute legacy inherited inline declarations to one unproven profile path', async () => {
    const agent = createTestAgent();
    try {
      const profile = normalizeAgentProfile({ ...role, sourcePath: '/higher.md', promptOverrideLayers: [{ fields: { 'system.shared': 'LOWER' } }, { fields: { 'system.shared': 'HIGHER' } }] });
      const fields = await resolveProfilePromptFields(profile, 'mock-model', 'sub', agent.get(IConfigService), agent.get(IModelService), agent.get(IPromptFieldRegistry));
      expect(fields.values['system.shared']).toBe('HIGHER');
      expect(fields.fields.find((field) => field.id === 'system.shared')?.sources).toMatchObject([{ surface: 'profile', declarationIndex: 0, path: undefined }, { surface: 'profile', declarationIndex: 1, path: undefined }]);
    } finally { await agent.dispose(); }
  });
});

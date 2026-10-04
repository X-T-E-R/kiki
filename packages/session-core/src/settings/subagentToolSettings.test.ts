import { describe, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse, NamedAgentProfile, ToolDescriptor } from '@kiki/protocol';
import {
  saveSubagentProfileToolSettings,
  searchSubagentToolCatalog,
  subagentProfileToolDraft,
  subagentProfileToolFields,
  subagentProfileToolPatch,
  subagentSessionToolStates,
} from './subagentToolSettings';

const profile: NamedAgentProfile = {
  name: 'example-reader', source: 'user', source_file: '/fixture/agents/example-reader.md',
  workspace_id: 'fixture-workspace', main: false, disabled: false, routes: [],
  tools: ['Bash', 'Read'], disallowed_tools: ['Write'],
};
const tools: ToolDescriptor[] = [
  { name: 'Bash', description: 'Execute shell commands', source: 'builtin', input_schema: null, active: true },
  { name: 'ExamplePlugin', description: 'Plugin action', source: 'plugin', input_schema: null },
  { name: 'mcp__fixture__lookup', description: 'Lookup documents', source: 'mcp', mcp_server_id: 'fixture', input_schema: null },
];

describe('subagent profile tool settings', () => {
  it('searches names, purpose, plugin and MCP origins without manufacturing inventory', () => {
    expect(searchSubagentToolCatalog(tools, 'bash').map((tool) => tool.name)).toEqual(['Bash']);
    expect(searchSubagentToolCatalog(tools, 'shell commands')[0]?.name).toBe('Bash');
    expect(searchSubagentToolCatalog(tools, 'plugin')[0]?.source).toBe('plugin');
    expect(searchSubagentToolCatalog(tools, 'fixture lookup', 'mcp')[0]?.name).toBe('mcp__fixture__lookup');
    expect(searchSubagentToolCatalog(tools, '', 'mcp')).toHaveLength(1);
    expect(searchSubagentToolCatalog([], 'Bash')).toEqual([]);
  });

  it('distinguishes absent, deny-all, and explicit profile fields', () => {
    expect(subagentProfileToolDraft({})).toEqual({ tools: null, disallowedTools: null });
    expect(subagentProfileToolDraft({ tools: [] })).toEqual({ tools: [], disallowedTools: null });
    expect(subagentProfileToolPatch(profile, { tools: [], disallowedTools: ['Write'] })).toEqual({
      scope: 'user', workspace_id: 'fixture-workspace', source_file: profile.source_file,
      tools: [], disallowed_tools: undefined,
    });
    expect(subagentProfileToolPatch(profile, { tools: null, disallowedTools: null })).toMatchObject({
      tools: null, disallowed_tools: null,
    });
    expect(subagentProfileToolPatch(profile, subagentProfileToolDraft(profile))).toBeUndefined();
    expect(() => subagentProfileToolPatch(profile, { tools: [' '], disallowedTools: null })).toThrow('must not be blank');
  });

  it('keeps editability, exact source, workspace and external field semantics separate', () => {
    const external = { ...profile, executor: 'external-example', executor_fields: {
      tools: { state: 'mapped' as const, reason: 'Translated to executor tool filter' },
      disallowed_tools: { state: 'ignored' as const, reason: 'Not supported by executor' },
    } };
    expect(subagentProfileToolFields(external)).toMatchObject([
      { field: 'tools', editable: true, applicability: 'mapped', sourceFile: profile.source_file },
      { field: 'disallowed_tools', editable: true, applicability: 'ignored', reason: 'Not supported by executor' },
    ]);
    expect(subagentProfileToolFields({ ...external, executor_fields: undefined })[0]?.applicability).toBe('unknown');
    expect(subagentProfileToolFields({ ...profile, source: 'builtin', source_file: undefined })[0]?.editable).toBe(false);
    expect(() => subagentProfileToolPatch({ ...profile, source: 'plugin' }, { tools: [], disallowedTools: null })).toThrow('no writable file');
    expect(subagentProfileToolPatch({ ...profile, source: 'workspace' }, { tools: [], disallowedTools: null }, { workspaceId: 'selected' })).toMatchObject({
      scope: 'project', workspace_id: 'selected', source_file: profile.source_file,
    });
  });

  it('PATCHes only edited fields, then re-reads the exact profile rather than accepting an echo or namesake', async () => {
    const updated = { ...profile, tools: ['Read'], disallowed_tools: ['Write', 'Bash'] };
    const client = {
      updateNamedAgentProfile: vi.fn().mockResolvedValue(profile),
      listNamedAgentProfiles: vi.fn().mockResolvedValue({ complete: true, items: [
        { ...updated, source_file: '/fixture/other/example-reader.md', tools: ['Bash'] }, updated,
      ] }),
    };
    expect(await saveSubagentProfileToolSettings(client, profile, subagentProfileToolDraft(updated))).toEqual(updated);
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('example-reader', {
      scope: 'user', workspace_id: 'fixture-workspace', source_file: profile.source_file,
      tools: ['Read'], disallowed_tools: ['Write', 'Bash'],
    });
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'fixture-workspace' });
    expect(client.updateNamedAgentProfile.mock.invocationCallOrder[0]).toBeLessThan(client.listNamedAgentProfiles.mock.invocationCallOrder[0]!);
  });

  it('does not turn a failed save, incomplete reload or missing exact file into a successful result', async () => {
    const client = {
      updateNamedAgentProfile: vi.fn().mockRejectedValue(new Error('write failed')),
      listNamedAgentProfiles: vi.fn(),
    };
    const draft = { tools: ['Read'], disallowedTools: ['Bash'] };
    await expect(saveSubagentProfileToolSettings(client, profile, draft)).rejects.toThrow('write failed');
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalled();
    expect(draft).toEqual({ tools: ['Read'], disallowedTools: ['Bash'] });
    client.updateNamedAgentProfile.mockResolvedValue(profile);
    client.listNamedAgentProfiles.mockResolvedValue({ complete: false, items: [profile] });
    await expect(saveSubagentProfileToolSettings(client, profile, draft)).rejects.toThrow('reload is incomplete');
    client.listNamedAgentProfiles.mockResolvedValue({ complete: true, items: [{ ...profile, source_file: '/other.md' }] });
    await expect(saveSubagentProfileToolSettings(client, profile, draft)).rejects.toThrow('file is missing');
  });

  it('only reads runtime states from the selected live agent panel, never a draft or main-tool catalog', () => {
    const panel: AgentCapabilitiesResponse = {
      context: 'draft', owner: { profile: profile.name }, available: true, targets: [],
      tools: [{ name: 'Bash', source: 'builtin', category: 'shell', state: 'disabled', unavailable_reason_code: 'draft_policy_disabled' }],
    };
    expect(subagentSessionToolStates(panel, undefined)).toBeUndefined();
    expect(subagentSessionToolStates(panel, 'child')).toBeUndefined();
    const live = { ...panel, context: 'live' as const, live: true, owner: { agent_id: 'child' } };
    expect(subagentSessionToolStates(live, 'main')).toBeUndefined();
    expect(subagentSessionToolStates({ ...live, live: false }, 'child')).toBeUndefined();
    expect(subagentSessionToolStates({ ...live, profile: { name: profile.name, executor: 'external-example' } }, 'child')).toBeUndefined();
    expect(subagentSessionToolStates(live, 'child')?.[0]?.state).toBe('disabled');
  });
});

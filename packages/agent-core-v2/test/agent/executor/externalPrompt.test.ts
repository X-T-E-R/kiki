import { describe, expect, it } from 'vitest';

import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { renderExternalPrompt, renderExternalPromptBlocks } from '#/agent/profile/externalPrompt';

const profile = (executorPrompt?: AgentProfile['executorPrompt']): AgentProfile => ({
  name: 'assistant', executor: 'codex-app-server', executorPrompt,
  systemPrompt: () => 'Profile body',
  renderSystemPrompt: () => ({ text: 'Profile body', environment: { cwd: '', date: { disclosed: false } } }),
});

const fields = {
  values: { 'system.active': 'Active field' },
  fields: [
    { id: 'system.active', value: 'Active field', status: 'effective' as const, sources: [] },
    { id: 'system.shadowed', value: 'Shadowed field', status: 'shadowed' as const, sources: [] },
  ],
};

const context = {
  agentsMd: 'Workspace instructions', memory: 'Saved memory',
  skills: 'Skill list', cwd: 'C:/workspace', cwdListing: 'src/',
};

describe('external prompt blocks', () => {
  it('defaults to the already-rendered profile body without shared blocks', () => {
    expect(renderExternalPrompt(profile(), context, fields, 'Route body')).toBe('Route body');
  });

  it('includes only selected effective fields and context blocks', () => {
    const result = renderExternalPrompt(profile({
      include: ['agents_md', 'system.*'], append: 'Engine appendix',
    }), context, fields, 'Route body');
    expect(result).toContain('Route body\n\nEngine appendix');
    expect(result).toContain('## agents_md\n\nWorkspace instructions');
    expect(result).toContain('## system.active\n\nActive field');
    expect(result).not.toContain('Shadowed field');
    expect(result).not.toContain('Saved memory');
    expect(result).not.toContain('Skill list');
  });

  it('applies the per-engine body and block override', () => {
    const result = renderExternalPrompt(profile({
      include: ['agents_md'], body: 'Default body',
      per_engine: { 'codex-app-server': { body: 'Codex body', include: ['memory_snapshot'] } },
    }), context, fields, 'Route body');
    expect(result).toBe('Codex body\n\n## memory_snapshot\n\nSaved memory');
    const blocks = renderExternalPromptBlocks(profile({
      include: ['agents_md'], body: 'Default body',
      per_engine: { 'codex-app-server': { body: 'Codex body', include: ['memory_snapshot'] } },
    }), context, fields, 'Route body');
    expect(blocks).toEqual([
      { id: 'body', text: 'Codex body' },
      { id: 'memory_snapshot', text: '## memory_snapshot\n\nSaved memory' },
    ]);
    expect(blocks.map((block) => block.text).join('\n\n')).toBe(result);
  });
});

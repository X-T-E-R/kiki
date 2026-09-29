import { resolveExecutorPrompt } from '@kiki/agent-profiles/executorPrompt';
import { renderPromptTemplateResult } from '@kiki/agent-profiles/profileShared';
import type { AgentProfile, AgentProfileContext } from '@kiki/agent-profiles/agentProfile';
import type { ResolvedPromptFieldOverrides } from '#/app/promptField/promptFieldRegistry';

export interface ExternalPromptBlock {
  readonly id: string;
  readonly text: string;
}

export function renderExternalPromptBlocks(
  profile: AgentProfile,
  context: AgentProfileContext,
  fields: ResolvedPromptFieldOverrides,
  fallback: string,
): ExternalPromptBlock[] {
  const config = resolveExecutorPrompt(profile.executorPrompt, profile.executor ?? 'native');
  const render = (text: string): string => renderPromptTemplateResult(text, context, {
    skillActive: context.skillActive === true,
  }).text;
  const blocks: ExternalPromptBlock[] = [{ id: 'body', text: config.body === undefined ? fallback : render(config.body) }];
  if (config.append !== undefined) blocks.push({ id: 'append', text: render(config.append) });
  const selected = new Set(config.include);
  const contextBlocks: Record<string, string | undefined> = {
    agents_md: context.agentsMd,
    memory_snapshot: context.memory,
    skill_catalog: context.skills,
    workspace_info: [context.cwd, context.cwdListing, context.additionalDirsInfo].filter(Boolean).join('\n'),
  };
  for (const id of ['agents_md', 'memory_snapshot', 'skill_catalog', 'workspace_info']) {
    if (selected.has(id) && contextBlocks[id]) blocks.push({ id, text: `## ${id}\n\n${contextBlocks[id]}` });
  }
  for (const field of fields.fields) {
    if ((selected.has(field.id) || selected.has(`${field.id.split('.')[0]}.*`))
      && field.status === 'effective'
      && field.value.length > 0) {
      blocks.push({ id: field.id, text: `## ${field.id}\n\n${field.value}` });
    }
  }
  return blocks.filter((block) => block.text.length > 0);
}

export function renderExternalPrompt(
  profile: AgentProfile,
  context: AgentProfileContext,
  fields: ResolvedPromptFieldOverrides,
  fallback: string,
): string {
  return renderExternalPromptBlocks(profile, context, fields, fallback).map((block) => block.text).join('\n\n');
}

import { useState } from 'react';
import type { AgentCapabilitiesQuery, AgentPromptDiagnostics } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { useAgentPanelCatalog } from './useAgentPanelCatalog';
import { PromptEffectiveDrawer } from './PromptEffectiveDrawer';

function profileRecipeName(prompt: AgentPromptDiagnostics | undefined): string | undefined {
  const reference = prompt?.recipe_model_binding?.references?.find((entry) => entry.surface === 'profile');
  if (reference === undefined) return undefined;
  return reference.name?.trim() || `${reference.installation_id}@${reference.revision}`;
}

export function RecipeBindingStatus({ sessionId, agentId, sourceRevision = '' }: {
  sessionId?: string;
  agentId?: string;
  sourceRevision?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const query: AgentCapabilitiesQuery | undefined = sessionId === undefined || agentId === undefined
    ? undefined
    : { session_id: sessionId, agent_id: agentId };
  const result = useAgentPanelCatalog(query, query !== undefined, sourceRevision);
  const name = profileRecipeName(result.data?.prompt);
  if (name === undefined || query === undefined) return null;
  return <>
    <button type="button" data-recipe-binding-status aria-label={t('composer.recipeBindingAria', { name })}
      title={t('composer.recipeBindingTitle', { name })} onClick={() => { setOpen(true); }}
      className="flex h-7 min-w-0 max-w-40 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none">
      <span className="shrink-0 text-ink-faint @max-[42rem]/toolbar:sr-only">{t('composer.recipeBindingLabel')}</span>
      <span className="min-w-0 truncate font-medium text-ink">{name}</span>
    </button>
    {open ? <PromptEffectiveDrawer sessionId={query.session_id} agentId={query.agent_id} onClose={() => { setOpen(false); }} /> : null}
  </>;
}

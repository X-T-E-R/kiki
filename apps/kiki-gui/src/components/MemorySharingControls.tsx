import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { PersonaSnapshot } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { Toggle } from './controls';
import { invalidatePersonas, personaQueryKey } from './persona/usePersonas';

/** Edit the persona's existing shared-memory policy, preserving its revision and other fields. */
export function MemorySharingControls({ snapshot }: { readonly snapshot: PersonaSnapshot }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const shared = snapshot.definition.memory?.shared ?? ['global', 'workspace'];
  const change = useMutation({
    mutationFn: (next: ('global' | 'workspace')[]) => client.putPersona({
      ...snapshot,
      definition: { ...snapshot.definition, memory: { shared: next } },
    }),
    onSuccess: async (next) => {
      queryClient.setQueryData(personaQueryKey(next.definition.id), next);
      await invalidatePersonas(queryClient, next.definition.id);
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: personaQueryKey(snapshot.definition.id) }); },
  });
  return (
    <div data-memory-sharing className="px-4 pt-1 pb-3 lg:px-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[12px] text-ink-soft">{t('memory.sharing.label', { name: snapshot.definition.name })}</span>
        {(['global', 'workspace'] as const).map((scope) => (
          <Toggle key={scope} id={`memory-share-${scope}`} label={t(`memory.scopeTag.${scope}`)} checked={shared.includes(scope)} disabled={change.isPending}
            onChange={(enabled) => { change.mutate(enabled ? [...shared, scope] : shared.filter((item) => item !== scope)); }} />
        ))}
      </div>
      {change.isError ? <p role="alert" className="mt-2 text-[12px] text-danger">{t('memory.toggleFailed', { detail: errorText(locale, change.error) })}</p> : null}
    </div>
  );
}

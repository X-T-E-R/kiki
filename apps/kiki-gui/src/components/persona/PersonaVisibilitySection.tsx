/**
 * PersonaVisibilitySection — 置顶 / 在侧栏隐藏, written straight to the persona's
 * own state (`PATCH /api/personas/{id}/state`).
 *
 * These are two single values with no draft semantics, so each switch saves
 * itself: a failed write keeps the stored value on screen and says why, and
 * nothing here reports success it did not get.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { PersonaState, PersonaSummary } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine, SavedTick, Toggle, type Feedback } from '../controls';
import { SettingField } from '../settings/fields';
import { useSavedTick } from '../settings/useSavedTick';
import { useConnection } from '../../state/connection';
import { invalidatePersonas } from './usePersonas';

type VisibilityKey = 'pinned' | 'hidden';

export function PersonaVisibilitySection({ persona }: { readonly persona: PersonaSummary }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [saved, markSaved] = useSavedTick();

  const update = useMutation({
    mutationFn: (patch: { pinned?: boolean; hidden?: boolean }): Promise<PersonaState> => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error(t('persona.conversationsUnavailable'));
      return rest.personas.updateState(persona.id, patch);
    },
    onSuccess: async (state) => {
      markSaved();
      // The roster and the sidebar read the same list; both refresh together.
      queryClient.setQueryData<readonly PersonaSummary[]>(['personas', { includeArchived: true }], (current) =>
        current?.map((item) => (item.id === persona.id ? { ...item, pinned: state.pinned, hidden: state.hidden } : item)));
      await invalidatePersonas(queryClient, persona.id);
    },
  });

  const feedback: Feedback = update.isError
    ? { tone: 'error', text: t('persona.visibilityFailed', { detail: errorText(locale, update.error) }) }
    : null;

  const row = (key: VisibilityKey, label: string, help: string) => (
    <SettingField label={label} layout="row" help={help}>
      <Toggle
        id={`persona-${key}-${persona.id}`}
        layout="bare"
        label={label}
        checked={persona[key] === true}
        disabled={update.isPending}
        onChange={(next) => { update.mutate({ [key]: next }); }}
      />
    </SettingField>
  );

  return (
    <div data-persona-visibility-section className="space-y-1">
      {row('pinned', t('persona.pin'), t('persona.pinHint'))}
      {row('hidden', t('persona.hide'), t('persona.hideHint'))}
      <div className="pt-1"><SavedTick show={saved && !update.isPending && !update.isError} /></div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

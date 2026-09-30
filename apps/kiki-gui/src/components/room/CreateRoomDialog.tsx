/**
 * CreateRoomDialog — name, 2–6 members, host (the first picked by default)
 * and the working directory the member sessions start in.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PersonaSummary } from '@kiki/protocol';
import { sortWorkspacesByPinnedThenRecency } from '@kiki/session-core/sessions';

import { useI18n } from '../../i18n';
import { ROOMS_QUERY_KEY, useBotRoomApi } from '../../lib/botRooms';
import { useConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { PersonaAvatar, personaAvatarOf } from '../persona/PersonaAvatar';
import { sortPersonas, usePersonaList } from '../persona/usePersonas';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6;

export function CreateRoomDialog({ onClose }: { readonly onClose: () => void }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const api = useBotRoomApi();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const personasQuery = usePersonaList();
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const personas = useMemo(() => sortPersonas((personasQuery.data ?? []).filter((item) => !item.archived)), [personasQuery.data]);
  const workspaces = useMemo(() => sortWorkspacesByPinnedThenRecency(workspacesQuery.data?.items ?? []), [workspacesQuery.data]);

  const [name, setName] = useState('');
  const [members, setMembers] = useState<readonly string[]>([]);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState(false);
  const workspaceRoot = workspace ?? workspaces[0]?.root;
  const effectiveHost = host !== undefined && members.includes(host) ? host : members[0];

  const create = useMutation({
    mutationFn: () => api.createRoom({
      name: name.trim(),
      members: members.map((personaId) => ({ personaId })),
      host: effectiveHost,
      workspace: workspaceRoot ?? '',
    }),
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onClose();
      navigate(`/rooms/${encodeURIComponent(room.id)}`);
    },
  });

  const toggle = (persona: PersonaSummary) => {
    setMembers((current) => current.includes(persona.id)
      ? current.filter((id) => id !== persona.id)
      : current.length >= MAX_MEMBERS ? current : [...current, persona.id]);
  };
  const nameMissing = name.trim() === '';
  const ready = !nameMissing && members.length >= MIN_MEMBERS && workspaceRoot !== undefined && !create.isPending;
  const submit = () => {
    setTouched(true);
    if (ready) create.mutate();
  };

  return (
    <Dialog onClose={() => { if (!create.isPending) onClose(); }} ariaLabel={t('room.new')} overlayId="create-room-dialog">
      <form data-create-room onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2 className="font-display text-[18px] font-semibold text-ink">{t('room.new')}</h2>

        <label className="mt-4 block">
          <span className="text-[12.5px] font-medium text-ink-soft">{t('room.name')}</span>
          <input data-autofocus value={name} maxLength={200}
            placeholder={t('room.namePlaceholder')}
            aria-invalid={touched && nameMissing}
            onChange={(event) => { setName(event.target.value); }}
            className={`${INPUT} mt-1.5 text-[13px]`} />
          {touched && nameMissing ? <span className="mt-1 block text-[12px] text-danger">{t('room.nameRequired')}</span> : null}
        </label>

        <fieldset className="mt-4">
          <legend className="flex w-full items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-ink-soft">{t('room.members')}</span>
            <span className="text-[12px] text-ink-faint tabular-nums">{members.length}/{MAX_MEMBERS}</span>
          </legend>
          <p className="mt-0.5 text-[12px] text-ink-faint">{t('room.membersHint')}</p>
          {personas.length === 0 && !personasQuery.isLoading ? (
            <p className="mt-2 text-[12.5px] text-ink-soft">{t('room.noPersonas')}</p>
          ) : (
            <ul className="mt-2 max-h-56 space-y-px overflow-y-auto rounded-lg border border-hairline p-1">
              {personas.map((persona) => {
                const index = members.indexOf(persona.id);
                const checked = index >= 0;
                const full = !checked && members.length >= MAX_MEMBERS;
                return (
                  <li key={persona.id}>
                    <label data-room-member-option={persona.id}
                      className={`flex min-h-10 items-center gap-2.5 rounded-md px-2 ${checked ? 'bg-selected' : 'hover:bg-ink/[0.04]'} ${full ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                      <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
                        checked={checked} disabled={full} onChange={() => { toggle(persona); }} />
                      <PersonaAvatar persona={personaAvatarOf(persona)} size={24} decorative />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{persona.name}</span>
                        {persona.title !== undefined || persona.job !== undefined ? (
                          <span className="block truncate text-[12px] text-ink-faint">{persona.title ?? persona.job}</span>
                        ) : null}
                      </span>
                      {checked && persona.id === effectiveHost ? (
                        <span className="shrink-0 rounded-full bg-selected px-1.5 text-[11px] leading-[18px] text-selected-ink">{t('room.hostTag')}</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {touched && members.length < MIN_MEMBERS ? <p className="mt-1 text-[12px] text-danger">{t('room.memberCount')}</p> : null}
        </fieldset>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[12.5px] font-medium text-ink-soft">{t('room.host')}</span>
            <select value={effectiveHost ?? ''} disabled={members.length === 0}
              onChange={(event) => { setHost(event.target.value); }}
              className={`${INPUT} mt-1.5 text-[13px]`}>
              {members.map((id) => (
                <option key={id} value={id}>{personas.find((item) => item.id === id)?.name ?? id}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12.5px] font-medium text-ink-soft">{t('room.workspace')}</span>
            <select value={workspaceRoot ?? ''} disabled={workspaces.length === 0}
              onChange={(event) => { setWorkspace(event.target.value); }}
              className={`${INPUT} mt-1.5 text-[13px]`}>
              {workspaces.map((item) => <option key={item.id} value={item.root}>{item.name}</option>)}
            </select>
          </label>
        </div>

        {create.isError ? (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12.5px] text-danger">
            <Icon name="warning" size={14} />
            <span>{t('room.createFailed', { detail: create.error instanceof Error ? create.error.message : String(create.error) })}</span>
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button" className={SECONDARY_BUTTON} disabled={create.isPending} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-create-room-submit className={PRIMARY_BUTTON} disabled={create.isPending}>{t('room.new')}</button>
        </div>
      </form>
    </Dialog>
  );
}

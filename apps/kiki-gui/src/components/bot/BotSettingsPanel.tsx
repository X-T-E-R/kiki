/**
 * BotSettingsPanel — the right rail's Bot page for a Bot's home session.
 * It reads the persona (identity, how it works) and edits only what belongs
 * to the Bot itself: sidebar pin / hide. The persona definition stays on the
 * Personas page, one editor for one document.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { BotSummary, Session } from '@kiki/protocol';
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { BOTS_QUERY_KEY, useBotRoomApi } from '../../lib/botRooms';
import { useLayoutPreferences, usePaneResize } from '../../lib/layoutHooks';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { INSPECTOR_LINK, InspectorRow, InspectorSection } from '../agent-panel/InspectorSection';
import { Toggle } from '../controls';
import { Icon } from '../icons';
import { PersonaAvatar } from '../persona/PersonaAvatar';
import { personaQueryKey } from '../persona/usePersonas';

export function BotSettingsPanel({
  className,
  personaId,
  session,
  onClose,
}: {
  readonly className?: string;
  readonly personaId: string;
  readonly session: Session | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const api = useBotRoomApi();
  const queryClient = useQueryClient();
  const personaQuery = useQuery({
    queryKey: personaQueryKey(personaId),
    queryFn: () => client.getPersona(personaId),
  });
  const botsQuery = useQuery({ queryKey: BOTS_QUERY_KEY, queryFn: () => api.listBots() });
  const bot = botsQuery.data?.find((item) => item.personaId === personaId);

  const update = useMutation({
    mutationFn: (input: { pinned?: boolean; hidden?: boolean }) => api.updateBot(personaId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: BOTS_QUERY_KEY });
      const previous = queryClient.getQueryData<readonly BotSummary[]>(BOTS_QUERY_KEY);
      queryClient.setQueryData<readonly BotSummary[]>(BOTS_QUERY_KEY, (items) =>
        items?.map((item) => (item.personaId === personaId ? { ...item, ...input } : item)));
      return { previous };
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(BOTS_QUERY_KEY, context?.previous);
      pushToast({ tone: 'error', text: t('bot.updateFailed', { detail: error instanceof Error ? error.message : String(error) }) });
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY }); },
  });

  const layoutPrefs = useLayoutPreferences();
  const [width, setWidth] = useState(layoutPrefs.railWidth);
  useEffect(() => { setWidth(layoutPrefs.railWidth); }, [layoutPrefs.railWidth]);
  const { startResize, reset } = usePaneResize({
    value: width,
    min: RAIL_MIN_WIDTH,
    max: RAIL_MAX_WIDTH,
    direction: -1,
    onChange: (value, final) => {
      setWidth(value);
      if (final) writeLayoutPreferences({ railWidth: value });
    },
    onReset: () => {
      setWidth(RAIL_DEFAULT_WIDTH);
      writeLayoutPreferences({ railWidth: RAIL_DEFAULT_WIDTH });
    },
  });

  const definition = personaQuery.data?.definition;
  const face = session?.agent_config.persona ?? { id: personaId, name: definition?.name ?? bot?.name ?? personaId };
  const name = definition?.name ?? bot?.name ?? face.name;
  const delivery = session?.delivery ?? definition?.delivery ?? 'message';

  return (
    <div className="app-rail-shell">
      <div
        data-rail-resizer
        className="app-rail__resizer hidden lg:block"
        aria-hidden
        title={t('rail.resizeAria')}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
      <aside
        className={className ?? 'app-rail'}
        style={{ '--kiki-rail-width': `${width}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-bot-settings
        aria-label={t('bot.settings')}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <div className="flex h-12 items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{t('bot.settings')}</h2>
            <button type="button" onClick={onClose} data-rail-close
              title={t('sv.hidePanel')} aria-label={t('sv.hidePanel')}
              className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="space-y-5 pt-1">
            <InspectorSection title={t('bot.section.identity')} collapsible={false}>
              <div className="flex items-start gap-3 py-1">
                <PersonaAvatar persona={face} size={40} decorative />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">{name}</p>
                  {definition?.title !== undefined ? <p className="truncate text-[12.5px] text-ink-soft">{definition.title}</p> : null}
                  {definition?.job !== undefined ? <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-faint">{definition.job}</p> : null}
                </div>
              </div>
              {definition !== undefined ? (
                <p data-bot-description className="mt-2 line-clamp-4 whitespace-pre-line text-[12.5px] leading-5 text-ink-soft">
                  {definition.description}
                </p>
              ) : personaQuery.isError ? (
                <p className="mt-2 text-[12.5px] text-danger">{personaQuery.error instanceof Error ? personaQuery.error.message : String(personaQuery.error)}</p>
              ) : (
                <div className="mt-2 h-10 animate-pulse rounded-md bg-ink/[0.04] motion-reduce:animate-none" aria-hidden />
              )}
              <Link to={`/personas?persona=${encodeURIComponent(personaId)}`} className={`${INSPECTOR_LINK} mt-1`}>
                {t('bot.editPersona')}
              </Link>
            </InspectorSection>

            <InspectorSection title={t('bot.section.work')} collapsible={false}>
              <dl>
                <InspectorRow label={t('persona.profile')}>{definition?.profile ?? session?.agent_config.profile ?? t('bot.profileDefault')}</InspectorRow>
                <InspectorRow label={t('persona.model')} title={session?.agent_config.model}>
                  {definition?.modelAlias ?? t('bot.modelFollow')}
                </InspectorRow>
                <InspectorRow label={t('persona.effort')}>{definition?.thinkingEffort ?? t('persona.effortFollow')}</InspectorRow>
                <InspectorRow label={t('room.workspace')} title={definition?.homeWorkspace} mono={definition?.homeWorkspace !== undefined}>
                  {definition?.homeWorkspace ?? t('bot.workspaceDefault')}
                </InspectorRow>
                <InspectorRow label={t('message.deliveryLabel')}>
                  {delivery === 'message' ? t('message.messageDelivery') : t('message.replyDelivery')}
                </InspectorRow>
              </dl>
            </InspectorSection>

            <InspectorSection title={t('bot.section.visibility')} collapsible={false}>
              <div className="space-y-1">
                <Toggle layout="row" label={t('bot.pin')} checked={bot?.pinned ?? false}
                  disabled={bot === undefined} onChange={(pinned) => { update.mutate({ pinned }); }} />
                <Toggle layout="row" label={t('bot.hide')} checked={bot?.hidden ?? false}
                  disabled={bot === undefined} onChange={(hidden) => { update.mutate({ hidden }); }} />
                {bot?.hidden === true ? <p className="text-[12px] text-ink-faint">{t('bot.hiddenNotice')}</p> : null}
              </div>
            </InspectorSection>

            <div className="space-y-1 border-t border-hairline pt-4">
              <p className="text-[12px] leading-5 text-ink-faint">{t('bot.routinesHint')}</p>
              <div className="flex flex-col items-start">
                <Link to="/cron" className={INSPECTOR_LINK}>{t('nav.cron')}</Link>
                <Link to={`/memory?persona=${encodeURIComponent(personaId)}`} className={INSPECTOR_LINK}>{t('bot.openMemory')}</Link>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

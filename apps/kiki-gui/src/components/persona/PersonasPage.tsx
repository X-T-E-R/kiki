/**
 * /personas — who talks to you. A persona is a global identity asset (name,
 * face, description, long-lived rules) that references a profile for how it
 * works; it carries no permissions of its own.
 *
 * List → detail, like /memory: a roster on the left (face, name, title, job),
 * the editor on the right. Below `md` one pane shows at a time. The roster's
 * selection and the "new" draft ride `?persona=` / `?new=1` so the composer's
 * "Manage personas" link and the memory page can deep-link here.
 *
 * Edits never touch running sessions: the binding freezes the persona at
 * creation, so the editor says so once, next to the save bar, instead of
 * after every save.
 *
 * Import is two-step on purpose (design §10): the card's full text is shown
 * unfolded before anything is written, because it becomes system prompt.
 *
 * The whole page writes to the connected server, so it declares that once
 * here: the five editor cards then keep their scope for assistive tech only
 * instead of repeating the same line under every heading.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { PersonaSummary } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { useAskKiki, useAskKikiWorkspace, AskKikiButton } from '../askKiki';
import { Icon } from '../icons';
import { PageHeader } from '../PageChrome';
import { Toggle } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { errorText } from '@kiki/session-core/i18n';
import { segmentClass } from '../WorkspaceScopeControl';
import { SettingsPageScopeContext } from '../settings/SectionCard';
import { PersonaAvatar, personaAvatarOf } from './PersonaAvatar';
import { PersonaEditor } from './PersonaEditor';
import { PersonaImportDialog } from './PersonaImportDialog';
import { PersonaConversationsSection } from './PersonaConversationsSection';
import { matchesPersona, sortPersonas, usePersonaList } from './usePersonas';

export function PersonasPage({ onToggleSidebar }: { readonly onToggleSidebar: () => void }) {
  const { t, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const listQuery = usePersonaList({ includeArchived: true });
  const { ask, busy: askingKiki } = useAskKiki();
  // Personas are server-scoped, but the conversation still runs somewhere: the
  // same workspace a plain New conversation here would use.
  const kikiWorkspace = useAskKikiWorkspace();

  const selectedId = params.get('persona') ?? undefined;
  const creating = params.get('new') === '1';
  const viewMode = params.get('view') === 'conversations' ? 'conversations' : 'settings';

  const { client } = useConnection();
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 60_000,
  });

  const all = useMemo(() => sortPersonas(listQuery.data ?? []), [listQuery.data]);
  const visible = all.filter((item) => (showArchived || !item.archived || item.id === selectedId) && matchesPersona(item, search));
  const archivedCount = all.filter((item) => item.archived).length;
  const selected = all.find((item) => item.id === selectedId);

  const select = (id: string | undefined, options: { readonly creating?: boolean; readonly view?: 'conversations' | 'settings' } = {}) => {
    const next = new URLSearchParams(params);
    next.delete('persona');
    next.delete('new');
    if (id !== undefined) next.set('persona', id);
    if (options.creating === true) next.set('new', '1');
    if (options.view) next.set('view', options.view);
    else next.delete('view');
    setParams(next);
  };

  // A deep link to a persona that is gone (deleted elsewhere) drops back to the roster.
  useEffect(() => {
    if (listQuery.isSuccess && selectedId !== undefined && selected === undefined) select(undefined);
  }, [listQuery.isSuccess, selectedId, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const detailOpen = creating || selected !== undefined;

  return (
    <div data-personas-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('persona.title')} onToggleSidebar={onToggleSidebar}>
        <button type="button" data-persona-import onClick={() => { setImporting(true); }} className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}>
          {t('persona.import')}
        </button>
        <AskKikiButton
          label={t('persona.askKiki')}
          labelAria={t('persona.askKikiAria')}
          busy={askingKiki}
          // Disabled until the workspace list answers: pressing it blind would
          // land the session in a fresh folder the user never asked for.
          disabled={!kikiWorkspace.resolved}
          testId="data-persona-ask-kiki"
          onAsk={() => { void ask({ skill: 'kiki-persona', promptKey: 'persona.askKiki.prompt', location: kikiWorkspace.location }); }}
        />
        <button type="button" data-persona-new onClick={() => { select(undefined, { creating: true }); }} className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}>
          {t('persona.new')}
        </button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-10 lg:px-6">
        <div className="mx-auto max-w-[1040px]">
          <p className={`mb-5 max-w-[62ch] text-[13px] leading-relaxed text-ink-soft ${detailOpen ? 'max-md:hidden' : ''}`}>{t('persona.lede')}</p>
          {listQuery.isPending ? (
            <p role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('persona.loading')}
            </p>
          ) : listQuery.isError ? (
            <div data-persona-error className="rounded-xl border border-danger/30 bg-danger/5 p-4">
              <p className="text-[13px] font-medium text-danger">{t('persona.loadFailed')}</p>
              <p className="mt-1 font-mono text-[11px] text-danger">{errorText(locale, listQuery.error)}</p>
              <button type="button" onClick={() => { void listQuery.refetch(); }} className="mt-2 text-[12px] font-medium text-danger underline">
                {t('common.retry')}
              </button>
            </div>
          ) : all.length === 0 && !creating ? (
            /* The page header already carries the handoff, so the empty state
               offers only the two actions that act here. */
            <PersonasEmpty onCreate={() => { select(undefined, { creating: true }); }} onImport={() => { setImporting(true); }} />
          ) : (
            <SettingsPageScopeContext.Provider value="server">
            <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(248px,0.8fr)_minmax(0,1.7fr)]" data-persona-list-detail>
              <div className={`min-w-0 ${detailOpen ? 'max-md:hidden' : ''}`}>
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <input
                    type="search"
                    data-persona-search
                    value={search}
                    onChange={(event) => { setSearch(event.target.value); }}
                    placeholder={t('persona.searchPlaceholder')}
                    aria-label={t('persona.searchAria')}
                    className="h-8 w-full rounded-md border border-hairline bg-paper px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent pointer-coarse:h-11"
                  />
                  {archivedCount > 0 ? <Toggle label={t('persona.showArchived')} checked={showArchived} onChange={setShowArchived} /> : null}
                </div>
                {visible.length === 0 ? (
                  <p className="py-6 text-[13px] text-ink-soft">{t('persona.noMatches', { query: search.trim() })}</p>
                ) : (
                  <ul aria-label={t('persona.listAria')} data-persona-list className="-mx-2 flex min-w-0 flex-col gap-0.5">
                    {visible.map((persona) => (
                      <li key={persona.id}>
                        <PersonaRow persona={persona} active={persona.id === selectedId && !creating} onOpen={() => { select(persona.id); }} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className={`min-w-0 md:border-l md:border-hairline md:pl-6 ${detailOpen ? '' : 'max-md:hidden'}`}>
                {detailOpen ? (
                  <button type="button" data-persona-back onClick={() => { select(undefined); }} className="mb-3 inline-flex min-h-8 items-center gap-1 text-[13px] text-ink-soft hover:text-ink md:hidden pointer-coarse:min-h-11">
                    <Icon name="arrowLeft" size={14} />
                    {t('persona.back')}
                  </button>
                ) : null}
                {creating ? (
                  <PersonaEditor key="new" personaId={undefined} takenIds={new Set(all.map((item) => item.id))} onSaved={(id) => { select(id); }} onClosed={() => { select(undefined); }} />
                ) : selected !== undefined ? (
                  <div className="space-y-5">
                    {/* Segmented Control for [对话 | 设置] */}
                    <div className="flex items-center justify-between border-b border-hairline pb-3">
                      <div role="tablist" aria-label={t('persona.viewModeAria', { defaultValue: '视图选择' })} className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={viewMode === 'conversations'}
                          onClick={() => select(selected.id, { view: 'conversations' })}
                          className={segmentClass(viewMode === 'conversations', 'h-7 px-3 text-[13px] pointer-coarse:h-10')}
                        >
                          {t('persona.tabConversations', { defaultValue: '全部对话' })}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={viewMode === 'settings'}
                          onClick={() => select(selected.id, { view: 'settings' })}
                          className={segmentClass(viewMode === 'settings', 'h-7 px-3 text-[13px] pointer-coarse:h-10')}
                        >
                          {t('persona.tabSettings', { defaultValue: '角色设置' })}
                        </button>
                      </div>
                    </div>

                    {viewMode === 'conversations' ? (
                      <PersonaConversationsSection
                        persona={selected}
                        workspaceOptions={workspacesQuery.data?.items ?? []}
                      />
                    ) : (
                      <PersonaEditor
                        key={selected.id}
                        personaId={selected.id}
                        summary={selected}
                        takenIds={new Set(all.map((item) => item.id))}
                        onSaved={(id) => { select(id, { view: 'settings' }); }}
                        onClosed={() => { select(undefined); }}
                      />
                    )}
                  </div>
                ) : (
                  <p className="py-8 text-[13px] text-ink-faint">{t('persona.detailNone')}</p>
                )}
              </div>
            </div>
            </SettingsPageScopeContext.Provider>
          )}
        </div>
      </div>
      {importing ? (
        <PersonaImportDialog
          takenIds={new Set(all.map((item) => item.id))}
          onClose={() => { setImporting(false); }}
          onImported={(id) => { setImporting(false); select(id); }}
        />
      ) : null}
    </div>
  );
}

/**
 * One roster row: the face carries identity, the name reads first, the title
 * sits beside it as a quiet label, and the job is the one line that says what
 * this persona is for — the same line rooms will use to pick a speaker.
 */
function PersonaRow({ persona, active, onOpen }: { readonly persona: PersonaSummary; readonly active: boolean; readonly onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-persona-row={persona.id}
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
      className={`flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-14 ${
        active ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
      }`}
    >
      <PersonaAvatar persona={personaAvatarOf(persona)} size={36} decorative className={persona.archived ? 'opacity-60' : ''} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 truncate text-[13.5px] ${active ? 'font-medium text-ink' : persona.archived ? 'text-ink-soft' : 'text-ink'}`}>{persona.name}</span>
          {persona.title !== undefined ? <span className="min-w-0 shrink-[2] truncate text-[12px] text-section-ink">{persona.title}</span> : null}
          {persona.archived ? <span className="shrink-0 text-[11px] text-ink-faint">{t('persona.archivedTag')}</span> : null}
        </span>
        {persona.job !== undefined ? <span className="truncate text-[12px] leading-4 text-ink-faint">{persona.job}</span> : null}
      </span>
    </button>
  );
}

function PersonasEmpty({ onCreate, onImport }: {
  readonly onCreate: () => void;
  readonly onImport: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-persona-empty className="py-10">
      {/* Three blank faces, one lit: what the roster will look like. */}
      <div aria-hidden className="flex items-center gap-2">
        {['a', 'b', 'c'].map((key, index) => (
          <span key={key} className={`h-9 w-9 rounded-[10px] ring-1 ring-inset ring-hairline-strong ${index === 1 ? 'bg-ink/[0.06]' : 'bg-panel'}`} />
        ))}
      </div>
      <p className="mt-4 font-display text-[18px] text-ink">{t('persona.empty')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onCreate} className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}>{t('persona.new')}</button>
        <button type="button" onClick={onImport} className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}>{t('persona.import')}</button>
      </div>
    </div>
  );
}

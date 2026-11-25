import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PersonaDefinition, PersonaSummary } from '@kiki/protocol';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { PersonaAvatar, personaAvatarOf } from '../../components/persona/PersonaAvatar';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import type { MobileAssistantBinding } from '../mobileAssistantStore';

export const DEFAULT_ASSISTANT_ID = 'kiki';

// The default assistant's persona prompt. Model-facing text, so it stays in
// one language and asks the model to follow the user's.
const KIKI_DESCRIPTION =
  'You are Kiki, a warm, quick and practical personal assistant who lives on this computer. ' +
  'Reply in the language the user writes in. Keep answers short and concrete, ask one question when something is unclear, ' +
  'and use the tools on this computer to get real work done when it helps.';

export interface AssistantComputer {
  readonly spaceKey: string;
  readonly name: string;
  readonly detail?: string;
}

interface AssistantSetupViewProps {
  readonly computers: readonly AssistantComputer[];
  readonly spaceKey: string | undefined;
  readonly onSelectSpace: (spaceKey: string) => void;
  readonly resolveClient: (spaceKey: string) => KikiClient;
  /** Persona to preselect (the current binding when switching). */
  readonly initialPersonaId?: string;
  readonly variant: 'page' | 'sheet';
  readonly onStarted: (binding: MobileAssistantBinding) => void;
  readonly onPairComputer: () => void;
}

/** Personas this computer can open as an assistant (archived ones stay out of the picker). */
function activePersonas(all: readonly PersonaSummary[]): readonly PersonaSummary[] {
  return all.filter((persona) => !persona.archived && persona.hidden !== true);
}

export function AssistantSetupView({
  computers,
  spaceKey,
  onSelectSpace,
  resolveClient,
  initialPersonaId,
  variant,
  onStarted,
  onPairComputer,
}: AssistantSetupViewProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const computer = computers.find((entry) => entry.spaceKey === spaceKey) ?? computers[0];
  const targetKey = computer?.spaceKey;
  const client = targetKey !== undefined ? resolveClient(targetKey) : undefined;

  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>(initialPersonaId);
  const [creatingDefault, setCreatingDefault] = useState(false);
  const [modelAlias, setModelAlias] = useState<string | undefined>(undefined);
  const [computerSheetOpen, setComputerSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const personasQuery = useQuery({
    queryKey: ['mobile-personas', targetKey, client?.baseUrl, 'with-archived'],
    enabled: client !== undefined,
    staleTime: 30_000,
    queryFn: () => client!.listPersonas({ includeArchived: true }),
  });
  const personas = useMemo(() => activePersonas(personasQuery.data ?? []), [personasQuery.data]);
  const showDefaultSetup = personasQuery.isSuccess && (personas.length === 0 || creatingDefault);

  const modelsQuery = useQuery({
    queryKey: ['mobile-models', targetKey, client?.baseUrl],
    enabled: client !== undefined && (modelSheetOpen || showDefaultSetup),
    staleTime: 60_000,
    queryFn: async () => (await client!.listModels()).items.filter((model) => model.enabled !== false),
  });

  // A different computer brings its own personas and models.
  useEffect(() => {
    setCreatingDefault(false);
    setModelAlias(undefined);
    setSelectedPersonaId(initialPersonaId);
  }, [targetKey, initialPersonaId]);

  const chosenPersona =
    personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0];
  const hasDefaultAssistant = personas.some((persona) => persona.id === DEFAULT_ASSISTANT_ID);
  const defaultAssistantStored = personasQuery.data?.some((persona) => persona.id === DEFAULT_ASSISTANT_ID) === true;
  const modelLabel =
    modelAlias === undefined
      ? t('mobile.assistant.modelDefault')
      : modelsQuery.data?.find((model) => model.id === modelAlias)?.display_name || modelAlias;

  const start = async () => {
    if (client === undefined || targetKey === undefined || starting) return;
    setStarting(true);
    try {
      let personaId: string;
      if (showDefaultSetup) {
        personaId = DEFAULT_ASSISTANT_ID;
        const all = await client.listPersonas({ includeArchived: true });
        const existing = all.find((persona) => persona.id === DEFAULT_ASSISTANT_ID);
        if (existing !== undefined) {
          // Restoring keeps the saved definition; only what this screen offers changes.
          if (existing.archived) await client.archivePersona(DEFAULT_ASSISTANT_ID, false);
          if (existing.hidden === true) await client.updatePersona(DEFAULT_ASSISTANT_ID, { hidden: false });
          if (modelAlias !== undefined) {
            const snapshot = await client.getPersona(DEFAULT_ASSISTANT_ID);
            if (snapshot.definition.modelAlias !== modelAlias) {
              await client.putPersona({
                definition: { ...snapshot.definition, modelAlias },
                revision: snapshot.revision,
                ...(snapshot.examples !== undefined ? { examples: snapshot.examples } : {}),
              });
            }
          }
        } else {
          // No `profile`: the computer's default main profile applies.
          const definition: PersonaDefinition = {
            id: DEFAULT_ASSISTANT_ID,
            name: 'Kiki',
            description: KIKI_DESCRIPTION,
            greeting: t('mobile.assistant.kikiGreeting'),
            delivery: 'message',
            ...(modelAlias !== undefined ? { modelAlias } : {}),
          };
          await client.putPersona({ definition });
        }
      } else {
        if (chosenPersona === undefined) return;
        personaId = chosenPersona.id;
      }
      const home = await client.ensurePersonaHome(personaId);
      void queryClient.invalidateQueries({ queryKey: ['mobile-personas'] });
      onStarted({ spaceKey: targetKey, personaId, sessionId: home.homeSessionId });
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setStarting(false);
    }
  };

  const rowClass =
    'flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.03] active:bg-ink/[0.05]';

  const computerRow =
    computer !== undefined ? (
      <button
        type="button"
        data-mobile-setup-computer
        disabled={computers.length < 2}
        onClick={() => { setComputerSheetOpen(true); }}
        className={`${rowClass} disabled:hover:bg-transparent`}
      >
        <span className="text-[14.5px] text-ink-soft">{t('mobile.assistant.computerLabel')}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[14.5px] font-normal text-ink">
          <span className="truncate">{computer.name}</span>
          {computers.length > 1 ? <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" /> : null}
        </span>
      </button>
    ) : null;

  const isPage = variant === 'page';
  const title =
    computer === undefined
      ? t('mobile.assistant.connectTitle')
      : showDefaultSetup
        ? t('mobile.assistant.meetKiki')
        : t('mobile.assistant.pickTitle');

  return (
    <div
      data-mobile-assistant-setup={computer === undefined ? 'no-computer' : showDefaultSetup ? 'default' : 'pick'}
      className={isPage ? 'flex min-h-0 flex-1 flex-col' : 'flex flex-col'}
    >
      <div className={isPage ? 'min-h-0 flex-1 overflow-y-auto px-5' : 'px-4'}>
        <div className={`mx-auto flex w-full max-w-[440px] flex-col ${isPage ? 'min-h-full justify-center gap-8 py-8 [@media(max-height:480px)]:gap-5 [@media(max-height:480px)]:py-4' : 'gap-5 pb-2 pt-1'}`}>
          <div className={`flex flex-col ${isPage ? 'items-center text-center' : ''} gap-4`}>
            {isPage ? (
              <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent-soft text-accent-ink [@media(max-height:480px)]:hidden" aria-hidden="true">
                <Icon name="profileMain" size={16} className="h-6 w-6" />
              </span>
            ) : null}
            <h1 className={isPage ? 'font-display text-[30px] font-bold leading-[1.15] text-ink' : 'text-[16px] font-bold text-ink'}>
              {title}
            </h1>
          </div>

          {computer === undefined ? null : !personasQuery.isSuccess ? (
            <div className="h-[104px] animate-pulse rounded-2xl bg-ink/[0.04]" aria-hidden="true" />
          ) : showDefaultSetup ? (
            <div className="divide-y divide-hairline/70 overflow-hidden rounded-2xl border border-hairline/90 bg-panel">
              {computerRow}
              <button
                type="button"
                data-mobile-setup-model
                onClick={() => { setModelSheetOpen(true); }}
                className={rowClass}
              >
                <span className="text-[14.5px] text-ink-soft">{t('mobile.assistant.modelLabel')}</span>
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[14.5px] font-normal text-ink">
                  <span className="truncate">{modelLabel}</span>
                  <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
                </span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {computers.length > 1 ? (
                <div className="overflow-hidden rounded-2xl border border-hairline/90 bg-panel">{computerRow}</div>
              ) : null}
              <div role="radiogroup" aria-label={t('mobile.assistant.pickTitle')} className="divide-y divide-hairline/70 overflow-hidden rounded-2xl border border-hairline/90 bg-panel">
                {personas.map((persona) => {
                  const selected = chosenPersona?.id === persona.id;
                  return (
                    <button
                      key={persona.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-mobile-setup-persona={persona.id}
                      onClick={() => { setSelectedPersonaId(persona.id); }}
                      className={rowClass}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <PersonaAvatar persona={personaAvatarOf({ id: persona.id, name: persona.name })} size={36} />
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-normal text-ink">{persona.name}</span>
                          {persona.title?.trim() || persona.job?.trim() ? (
                            <span className="block truncate text-[12.5px] text-ink-faint">
                              {persona.title?.trim() || persona.job?.trim()}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                          selected ? 'border-ink bg-ink text-paper' : 'border-hairline-strong'
                        }`}
                      >
                        {selected ? <Icon name="check" size={12} /> : null}
                      </span>
                    </button>
                  );
                })}
                {hasDefaultAssistant ? null : (
                  <button
                    type="button"
                    data-mobile-setup-create-default
                    onClick={() => { setCreatingDefault(true); }}
                    className={`${rowClass} justify-start text-ink-soft`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center text-ink-faint">
                      <Icon name="plus" size={16} />
                    </span>
                    <span className="text-[14.5px] font-normal">{defaultAssistantStored ? t('mobile.assistant.restoreKiki') : t('mobile.assistant.createKiki')}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          <div className={`flex flex-col gap-2 ${isPage ? 'pb-[calc(84px+var(--kiki-safe-bottom-inset))]' : 'pb-1'}`}>
            {computer === undefined ? (
              <button
                type="button"
                data-mobile-setup-pair
                onClick={onPairComputer}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink px-6 text-[15px] font-normal text-paper transition-opacity active:opacity-85"
              >
                <Icon name="plus" size={14} />
                <span>{t('mobile.assistant.pairComputer')}</span>
              </button>
            ) : (
              <button
                type="button"
                data-mobile-setup-start
                disabled={starting || !personasQuery.isSuccess}
                onClick={() => { void start(); }}
                className="flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[15px] font-normal text-paper transition-opacity active:opacity-85 disabled:opacity-50"
              >
                {showDefaultSetup ? t('mobile.assistant.startKiki') : t('mobile.assistant.startChat')}
              </button>
            )}
            {creatingDefault && personas.length > 0 ? (
              <button
                type="button"
                data-mobile-setup-back
                onClick={() => { setCreatingDefault(false); }}
                className="flex min-h-11 w-full items-center justify-center rounded-full px-6 text-[14.5px] font-normal text-ink-soft transition-colors hover:bg-ink/[0.04]"
              >
                {t('mobile.assistant.backToList')}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {computerSheetOpen ? (
        <ActionSheet
          role="menu"
          ariaLabel={t('mobile.assistant.chooseComputer')}
          overlayId="mobile-setup-computer"
          onClose={() => { setComputerSheetOpen(false); }}
          sheetClassName="rounded-t-[24px]!"
        >
          <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
          <p className="px-4 pb-1 text-[13px] font-normal text-ink-faint">{t('mobile.assistant.chooseComputer')}</p>
          {computers.map((entry) => (
            <button
              key={entry.spaceKey}
              type="button"
              role="menuitemradio"
              aria-checked={entry.spaceKey === targetKey}
              onClick={() => {
                onSelectSpace(entry.spaceKey);
                setComputerSheetOpen(false);
              }}
              className="flex w-full items-center justify-between text-left text-ink hover:bg-ink/[0.04]"
            >
              <span className="min-w-0">
                <span className="block truncate">{entry.name}</span>
                {entry.detail !== undefined ? <span className="block truncate text-[12.5px] text-ink-faint">{entry.detail}</span> : null}
              </span>
              {entry.spaceKey === targetKey ? <Icon name="check" size={16} className="shrink-0" /> : null}
            </button>
          ))}
        </ActionSheet>
      ) : null}

      {modelSheetOpen ? (
        <ActionSheet
          role="menu"
          ariaLabel={t('mobile.assistant.modelLabel')}
          overlayId="mobile-setup-model"
          onClose={() => { setModelSheetOpen(false); }}
          sheetClassName="rounded-t-[24px]!"
        >
          <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
          <p className="px-4 pb-1 text-[13px] font-normal text-ink-faint">{t('mobile.assistant.modelLabel')}</p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={modelAlias === undefined}
            onClick={() => {
              setModelAlias(undefined);
              setModelSheetOpen(false);
            }}
            className="flex w-full items-center justify-between text-left text-ink hover:bg-ink/[0.04]"
          >
            <span>{t('mobile.assistant.modelDefault')}</span>
            {modelAlias === undefined ? <Icon name="check" size={16} /> : null}
          </button>
          {modelsQuery.isLoading ? (
            <p className="px-4 py-3 text-[13px] text-ink-faint">{t('mobile.chat.modelLoading')}</p>
          ) : (
            (modelsQuery.data ?? []).map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={modelAlias === model.id}
                onClick={() => {
                  setModelAlias(model.id);
                  setModelSheetOpen(false);
                }}
                className="flex w-full items-center justify-between text-left text-ink hover:bg-ink/[0.04]"
              >
                <span className="min-w-0 truncate">{model.display_name || model.id}</span>
                {modelAlias === model.id ? <Icon name="check" size={16} className="shrink-0" /> : null}
              </button>
            ))
          )}
        </ActionSheet>
      ) : null}
    </div>
  );
}

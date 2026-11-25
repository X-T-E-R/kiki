import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { UnifiedInboxItem } from '@kiki/session-core/sessions';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { PersonaAvatar, personaAvatarOf } from '../../components/persona/PersonaAvatar';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { MobileChatScreen } from '../chat/MobileChatScreen';
import { AssistantSetupView, type AssistantComputer } from '../components/AssistantSetupView';
import { NeedsYouSheet, NeedsYouStrip } from '../components/NeedsYouStrip';
import { spaceKeyToScope } from '../../lib/useMultiSpaceSessions';
import { assistantScopeTarget, useMobileAssistant, writeMobileAssistant, type MobileAssistantBinding } from '../mobileAssistantStore';

interface AssistantTabProps {
  /** Concrete space from the current scope, or undefined for All spaces. */
  readonly scopeSpaceKey: string | undefined;
  readonly computers: readonly AssistantComputer[];
  readonly resolveClient: (spaceKey: string) => KikiClient;
  readonly resolveSpaceName: (spaceKey: string) => string;
  readonly needsYouItems: readonly UnifiedInboxItem[];
  readonly onOpenItem: (item: UnifiedInboxItem) => void;
  readonly onRefresh: () => void;
  readonly onPairComputer: () => void;
  readonly onOpenWorkbench: (spaceKey: string, sessionId: string) => void;
  readonly onOpenProviderSettings?: (spaceKey: string) => void;
  readonly onOpenVoiceForChat: (onResult: (text: string) => void) => void;
  /** Moves the global space scope (a `spaceScope` token). */
  readonly onScopeChange: (scope: string) => void;
}

/**
 * Tab 1: the resident assistant chat itself. With no binding yet it is the
 * one-screen setup; afterwards the chat, with cross-space decisions folded
 * into a single strip under the header.
 */
export function AssistantTab({
  scopeSpaceKey,
  computers,
  resolveClient,
  resolveSpaceName,
  needsYouItems,
  onOpenItem,
  onRefresh,
  onPairComputer,
  onOpenWorkbench,
  onOpenProviderSettings,
  onOpenVoiceForChat,
  onScopeChange,
}: AssistantTabProps) {
  const { t } = useI18n();
  const recent = useMobileAssistant(undefined);
  const preferredKey = scopeSpaceKey ?? recent?.spaceKey ?? computers[0]?.spaceKey;
  const binding = useMobileAssistant(preferredKey);
  // A computer picked in setup only counts while the scope it was picked under is current.
  const [setupChoice, setSetupChoice] = useState<{ readonly base: string | undefined; readonly spaceKey: string } | undefined>(undefined);
  const setupSpaceKey = setupChoice !== undefined && setupChoice.base === preferredKey ? setupChoice.spaceKey : undefined;
  const setSetupSpaceKey = (spaceKey: string) => { setSetupChoice({ base: preferredKey, spaceKey }); };
  const startAssistant = (next: MobileAssistantBinding) => {
    writeMobileAssistant(next);
    const target = assistantScopeTarget(scopeSpaceKey, next.spaceKey);
    if (target !== undefined) onScopeChange(spaceKeyToScope(target));
  };
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [needsYouOpen, setNeedsYouOpen] = useState(false);

  const bindingClient = binding !== undefined ? resolveClient(binding.spaceKey) : undefined;
  const personasQuery = useQuery({
    queryKey: ['mobile-personas', binding?.spaceKey, bindingClient?.baseUrl, 'with-archived'],
    enabled: bindingClient !== undefined,
    staleTime: 30_000,
    queryFn: () => bindingClient!.listPersonas({ includeArchived: true }),
  });
  const boundPersona = personasQuery.data?.find((persona) => persona.id === binding?.personaId);

  const needsYouSheet = needsYouOpen ? (
    <NeedsYouSheet
      items={needsYouItems}
      resolveClient={resolveClient}
      onClose={() => { setNeedsYouOpen(false); }}
      onOpenItem={onOpenItem}
      onResolved={onRefresh}
    />
  ) : null;

  if (binding === undefined || bindingClient === undefined) {
    return (
      <div data-mobile-screen="assistant-setup" className="flex min-h-0 flex-1 flex-col">
        <NeedsYouStrip count={needsYouItems.length} onOpen={() => { setNeedsYouOpen(true); }} />
        <AssistantSetupView
          variant="page"
          computers={computers}
          spaceKey={setupSpaceKey ?? preferredKey}
          onSelectSpace={setSetupSpaceKey}
          resolveClient={resolveClient}
          onStarted={startAssistant}
          onPairComputer={onPairComputer}
        />
        {needsYouSheet}
      </div>
    );
  }

  const spaceName = resolveSpaceName(binding.spaceKey);
  const personaName = boundPersona?.name ?? binding.personaId;

  return (
    <>
      <MobileChatScreen
        key={`${binding.spaceKey}::${binding.sessionId}`}
        variant="root"
        spaceKey={binding.spaceKey}
        spaceName={spaceName}
        sessionId={binding.sessionId}
        client={bindingClient}
        leading={
          <button
            type="button"
            data-mobile-assistant-switch
            aria-label={t('mobile.assistant.switch')}
            onClick={() => {
              setSetupChoice(undefined);
              setSwitcherOpen(true);
            }}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full py-1 pl-1.5 pr-3 text-left transition-colors hover:bg-ink/[0.04]"
          >
            <PersonaAvatar persona={personaAvatarOf({ id: binding.personaId, name: personaName })} size={34} />
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-[15px] font-semibold leading-tight text-ink">
                <span className="truncate">{personaName}</span>
                <Icon name="chevron" size={12} className="shrink-0 rotate-90 text-ink-faint" />
              </span>
              <span className="mt-0.5 block truncate text-[12px] leading-none text-ink-faint">{spaceName}</span>
            </span>
          </button>
        }
        belowHeader={<NeedsYouStrip count={needsYouItems.length} onOpen={() => { setNeedsYouOpen(true); }} />}
        onOpenWorkbench={() => { onOpenWorkbench(binding.spaceKey, binding.sessionId); }}
        onOpenProviderSettings={onOpenProviderSettings === undefined ? undefined : () => { onOpenProviderSettings(binding.spaceKey); }}
        onOpenVoiceForChat={onOpenVoiceForChat}
        personaNameHint={boundPersona?.name}
      />

      {switcherOpen ? (
        <ActionSheet
          role="dialog"
          ariaLabel={t('mobile.assistant.switch')}
          overlayId="mobile-assistant-switch"
          dataAttribute="data-mobile-assistant-switch-sheet"
          onClose={() => { setSwitcherOpen(false); }}
          sheetClassName="rounded-t-[24px]!"
        >
          <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
          <AssistantSetupView
            variant="sheet"
            computers={computers}
            spaceKey={setupSpaceKey ?? binding.spaceKey}
            onSelectSpace={setSetupSpaceKey}
            resolveClient={resolveClient}
            initialPersonaId={(setupSpaceKey ?? binding.spaceKey) === binding.spaceKey ? binding.personaId : undefined}
            onStarted={(next) => {
              startAssistant(next);
              setSwitcherOpen(false);
            }}
            onPairComputer={() => {
              setSwitcherOpen(false);
              onPairComputer();
            }}
          />
        </ActionSheet>
      ) : null}

      {needsYouSheet}
    </>
  );
}

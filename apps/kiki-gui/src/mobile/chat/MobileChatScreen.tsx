import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAIN_AGENT_ID, personaGreeting, type UserBlock } from '@kiki/session-core/session';
import { pushToast } from '../../lib/toasts';

import { Icon } from '../../components/icons';
import {
  ModelSwitchActionsContext,
  type ModelSwitchNoticeActions,
} from '../../components/model-switch/ModelSwitchNotice';
import { canFaithfullyRetryUserBlock } from '../../components/timeline/TurnTailSurface';
import { ToastAnchor } from '../../components/Toasts';
import { useI18n } from '../../i18n';
import { isSessionNotFoundMessage, type KikiClient } from '../../lib/client';
import { LiftTheHoodSheet, type HoodTab } from './LiftTheHoodSheet';
import { MobileComposer } from './MobileComposer';
import { MobileTranscript } from './MobileTranscript';
import { useMobileSessionStream } from './useMobileSessionStream';

interface MobileChatScreenProps {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly sessionId: string;
  readonly client: KikiClient;
  /**
   * `push`: a pushed thread with a back arrow and edge swipe.
   * `root`: the Assistant tab's resident chat, which sits above the tab bar.
   */
  readonly variant?: 'push' | 'root';
  /** Replaces the back arrow and title (root variant: the assistant switcher). */
  readonly leading?: ReactNode;
  /** A strip rendered under the header (root variant: cross-space decisions). */
  readonly belowHeader?: ReactNode;
  readonly onBack?: () => void;
  readonly onOpenWorkbench: () => void;
  readonly onOpenProviderSettings?: () => void;
  readonly onOpenVoiceForChat: (onResult: (text: string) => void) => void;
  /** Persona name known before the session snapshot loads (composer placeholder). */
  readonly personaNameHint?: string;
}

export function MobileChatScreen({
  spaceKey,
  spaceName,
  sessionId,
  client,
  variant = 'push',
  leading,
  belowHeader,
  onBack,
  onOpenWorkbench,
  onOpenProviderSettings,
  onOpenVoiceForChat,
  personaNameHint,
}: MobileChatScreenProps) {
  const { t, locale } = useI18n();
  const stream = useMobileSessionStream(client, spaceKey, sessionId);
  const [hoodOpen, setHoodOpen] = useState(false);
  const [hoodTab, setHoodTab] = useState<HoodTab>('info');
  const [hoodChangeId, setHoodChangeId] = useState<string | undefined>(undefined);
  const [hoodModels, setHoodModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [planMode, setPlanMode] = useState(false);
  const [recoveringInterruption, setRecoveringInterruption] = useState(false);
  const [pendingSwitchOperationId, setPendingSwitchOperationId] = useState<string | undefined>(undefined);
  const [restoreDraft, setRestoreDraft] = useState<{ readonly text: string; readonly nonce: number } | undefined>(undefined);
  const isRoot = variant === 'root';

  // Smooth touch left-edge swipe-back gesture (zero document reload).
  const [swipeX, setSwipeX] = useState(0);
  const edgeSwipeRef = useRef<{ readonly startX: number; readonly startY: number; active: boolean } | null>(null);

  const openHood = (tab: HoodTab, changeId?: string, models = false) => {
    setHoodTab(tab);
    setHoodChangeId(changeId);
    setHoodModels(models);
    setHoodOpen(true);
  };

  const session = stream.state.session;
  const persona = session?.agent_config?.persona;
  const messageMode = session?.delivery === 'message';
  const hasUserTurn = useMemo(() => stream.state.blocks.some((block) => block.kind === 'user'), [stream.state.blocks]);

  // The persona's local greeting opens an empty home chat at zero token cost.
  const personaQuery = useQuery({
    queryKey: ['mobile-persona', spaceKey, client.baseUrl, persona?.id],
    enabled: persona?.id !== undefined && stream.state.loaded && !hasUserTurn,
    staleTime: 5 * 60_000,
    queryFn: async () => (await client.getPersona(persona!.id)).definition,
  });
  const greeting = useMemo(() => {
    const definition = personaQuery.data;
    if (definition === undefined || hasUserTurn) return undefined;
    return personaGreeting({ id: definition.id, name: definition.name, greeting: definition.greeting });
  }, [hasUserTurn, personaQuery.data]);

  const title = session?.title?.trim() || persona?.name || t('mobile.chats.title');
  const runningTasksCount = stream.state.tasks.filter((task) => task.status === 'running').length;
  const subStatus = stream.state.busy ? `${spaceName} · ${t('mobile.chat.thinking')}` : spaceName;
  const loadError =
    stream.state.loadError ??
    (!stream.state.loaded && stream.state.resyncFailed ? stream.state.resyncError?.message : undefined);
  const canRetryLoad =
    loadError !== undefined &&
    !isSessionNotFoundMessage(loadError) &&
    (stream.state.loadError !== undefined || stream.state.resyncError?.retryable !== false);

  const modelsQuery = useQuery({
    queryKey: ['mobile-models-catalog', spaceKey, client.baseUrl],
    enabled: typeof client.listModels === 'function',
    staleTime: 60_000,
    queryFn: async () => (await client.listModels()).items,
  });

  const send = useCallback(
    (text: string, timing?: Parameters<typeof stream.sendPrompt>[0]['timing']) =>
      stream.sendPrompt({
        text,
        model: selectedModel,
        planMode,
        timing,
        ...(greeting !== undefined ? { personaGreetingReply: true } : {}),
      }),
    [greeting, planMode, selectedModel, stream],
  );

  const handleContinueFailedTurn = useCallback(() => {
    if (stream.state.busy) return;
    void send(locale === 'zh' ? '继续' : 'Continue');
  }, [locale, send, stream.state.busy]);

  const handleRestoreDraft = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setRestoreDraft((prev) => ({ text: trimmed, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const handleRetryFailedTurn = useCallback((failedUserBlock: UserBlock | undefined) => {
    if (stream.state.busy || failedUserBlock === undefined) return;
    if (failedUserBlock.userMessageId !== undefined) {
      void stream.regenerateMessage(failedUserBlock.userMessageId);
      return;
    }
    if (!canFaithfullyRetryUserBlock(failedUserBlock, false)) {
      handleRestoreDraft(failedUserBlock.text);
      return;
    }
    const text = failedUserBlock.text.trim();
    if (text === '') return;
    void send(text);
  }, [handleRestoreDraft, send, stream]);

  const handleOpenProviderSettings = useCallback(() => {
    if (onOpenProviderSettings !== undefined) {
      onOpenProviderSettings();
      return;
    }
    onOpenWorkbench();
  }, [onOpenProviderSettings, onOpenWorkbench]);

  const runModelSwitchAction = useCallback(
    (
      operationId: string,
      run: () => Promise<unknown>,
      failureKey: 'modelSwitch.cancelFailed' | 'modelSwitch.recoverFailed',
    ) => {
      setPendingSwitchOperationId(operationId);
      void run()
        .then(() => {
          void stream.resync();
        })
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t(failureKey, {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        })
        .finally(() => {
          setPendingSwitchOperationId((current) => (current === operationId ? undefined : current));
        });
    },
    [stream, t],
  );

  const modelSwitchActions = useMemo<ModelSwitchNoticeActions>(() => ({
    pendingOperationId: pendingSwitchOperationId,
    edit: () => { openHood('info', undefined, true); },
    cancel: typeof client.cancelAgentModelSwitch === 'function'
      ? (operationId) => {
          runModelSwitchAction(
            operationId,
            () => client.cancelAgentModelSwitch(sessionId, MAIN_AGENT_ID, operationId),
            'modelSwitch.cancelFailed',
          );
        }
      : undefined,
    retry: typeof client.recoverAgentModelSwitch === 'function'
      ? (operationId) => {
          runModelSwitchAction(
            operationId,
            () => client.recoverAgentModelSwitch(sessionId, MAIN_AGENT_ID, operationId, 'retry'),
            'modelSwitch.recoverFailed',
          );
        }
      : undefined,
    retryAsFresh: typeof client.recoverAgentModelSwitch === 'function'
      ? (operationId) => {
          runModelSwitchAction(
            operationId,
            () => client.recoverAgentModelSwitch(sessionId, MAIN_AGENT_ID, operationId, 'retry', 'fresh'),
            'modelSwitch.recoverFailed',
          );
        }
      : undefined,
    keepOriginal: typeof client.recoverAgentModelSwitch === 'function'
      ? (operationId) => {
          runModelSwitchAction(
            operationId,
            () => client.recoverAgentModelSwitch(sessionId, MAIN_AGENT_ID, operationId, 'keep_original'),
            'modelSwitch.recoverFailed',
          );
        }
      : undefined,
  }), [client, pendingSwitchOperationId, runModelSwitchAction, sessionId]);

  const handleRecoverInterruption = useCallback(() => {
    if (recoveringInterruption || stream.state.busy || typeof client.recoverSession !== 'function') return;
    setRecoveringInterruption(true);
    void client
      .recoverSession(sessionId)
      .then((receipt) => {
        if (receipt?.status === 'nothing_to_recover') {
          void stream.resync();
        }
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setRecoveringInterruption(false);
      });
  }, [client, recoveringInterruption, sessionId, stream]);

  const handleRetryCompaction = useCallback((strategy: 'summarize' | 'relay') => {
    if (stream.state.busy || typeof client.compactSession !== 'function') return;
    void client.compactSession(sessionId, { strategy }).catch((error: unknown) => {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  }, [client, sessionId, stream.state.busy]);

  const handleOpenModelPicker = useCallback(() => {
    openHood('info', undefined, true);
  }, []);

  return (
    <div
      data-mobile-screen={isRoot ? 'assistant-chat' : 'chat'}
      style={swipeX > 0 ? { transform: `translate3d(${swipeX}px, 0, 0)` } : undefined}
      onTouchStart={(event) => {
        if (isRoot) return;
        const touch = event.touches[0];
        if (touch === undefined || touch.clientX > 28) return;
        edgeSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, active: false };
      }}
      onTouchMove={(event) => {
        const edge = edgeSwipeRef.current;
        const touch = event.touches[0];
        if (edge === null || touch === undefined) return;
        const dx = touch.clientX - edge.startX;
        const dy = Math.abs(touch.clientY - edge.startY);
        if (!edge.active && dx > 12 && dx > dy * 1.4) {
          edge.active = true;
        }
        if (edge.active && dx > 0) {
          setSwipeX(Math.min(260, dx));
        }
      }}
      onTouchEnd={() => {
        if (edgeSwipeRef.current?.active && swipeX > 96) {
          setSwipeX(0);
          edgeSwipeRef.current = null;
          onBack?.();
          return;
        }
        setSwipeX(0);
        edgeSwipeRef.current = null;
      }}
      className={`flex min-h-0 flex-1 flex-col bg-paper ${isRoot ? '' : 'kiki-mobile-push-screen'}`}
    >
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-hairline/65 px-2">
        {leading ?? (
          <>
            <button
              type="button"
              data-mobile-chat-back
              aria-label={t('mobile.chat.back')}
              onClick={onBack}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink transition-colors hover:bg-ink/[0.05]"
            >
              <Icon name="arrowLeft" size={16} />
            </button>

            <button
              type="button"
              onClick={() => { openHood('info'); }}
              className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center text-left"
            >
              <span className="w-full truncate text-[15px] font-semibold leading-tight text-ink">{title}</span>
              <span className="mt-0.5 flex w-full items-center gap-1.5 text-[11.5px] leading-none text-ink-faint">
                <span
                  className={`h-[6px] w-[6px] shrink-0 rounded-full ${stream.state.busy ? 'bg-accent' : 'bg-success'}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">{subStatus}</span>
              </span>
            </button>
          </>
        )}

        <button
          type="button"
          data-mobile-chat-more
          aria-label={t('mobile.chat.more')}
          onClick={() => { openHood('info'); }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
        >
          <Icon name="more" size={16} />
        </button>
      </header>

      {belowHeader}

      <ModelSwitchActionsContext.Provider value={modelSwitchActions}>
        <MobileTranscript
          state={stream.state}
          blocks={stream.state.blocks}
          loaded={stream.state.loaded}
          loadError={loadError}
          busy={stream.state.busy}
          hasMoreHistory={stream.state.hasMoreHistory}
          loadingOlder={stream.loadingOlder}
          messageMode={messageMode}
          personaName={persona?.name}
          greeting={greeting}
          modelCatalog={modelsQuery.data}
          modelCatalogScope={spaceKey}
          interruptedWork={session?.interrupted_work}
          recoveringInterruption={recoveringInterruption}
          onLoadOlder={() => { void stream.loadOlder(); }}
          onRetryLoad={canRetryLoad ? () => { void stream.retryLoad(); } : undefined}
          onOpenHood={openHood}
          onResolveApproval={(approvalId, decision, reason) => { void stream.resolveApproval(approvalId, decision, reason); }}
          onAnswerQuestion={stream.answerQuestion}
          onDismissQuestion={stream.dismissQuestion}
          onOpenWorkbench={onOpenWorkbench}
          onContinueFailedTurn={handleContinueFailedTurn}
          onRetryFailedTurn={handleRetryFailedTurn}
          onRestoreDraft={handleRestoreDraft}
          onOpenModelPicker={handleOpenModelPicker}
          onOpenProviderSettings={handleOpenProviderSettings}
          onRecoverInterruption={typeof client.recoverSession === 'function' ? handleRecoverInterruption : undefined}
          onRetryCompaction={typeof client.compactSession === 'function' ? handleRetryCompaction : undefined}
        />
      </ModelSwitchActionsContext.Provider>

      <div className="relative shrink-0">
        <ToastAnchor className="kiki-mobile-toast-anchor-inline" />
        {runningTasksCount > 0 ? (
          <div className="px-3 pb-1">
            <button
              type="button"
              data-mobile-live-pill
              onClick={() => { openHood('tools'); }}
              className="mx-auto flex h-11 w-full max-w-[640px] items-center justify-between gap-2 rounded-2xl border border-hairline/90 bg-panel px-3.5 text-[13px] text-ink shadow-xs"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span className="truncate font-medium">
                  {t('mobile.chat.liveRunPill', { count: runningTasksCount })}
                </span>
              </span>
              <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
            </button>
          </div>
        ) : null}

        <MobileComposer
          draftKey={`${spaceKey}::${sessionId}`}
          spaceName={persona?.name ?? personaNameHint ?? spaceName}
          busy={stream.state.busy}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          onOpenModelPicker={() => { openHood('info', undefined, true); }}
          onOpenVoice={() => {
            onOpenVoiceForChat((spoken) => {
              void send(spoken);
            });
          }}
          onSend={(text, timing) => send(text, timing)}
          onAbort={stream.abort}
          restoreDraft={restoreDraft}
        />
      </div>

      {isRoot ? <div className="kiki-mobile-tabbar-spacer" aria-hidden="true" /> : null}

      <LiftTheHoodSheet
        open={hoodOpen}
        initialTab={hoodTab}
        initialChangeId={hoodChangeId}
        initialModelPicker={hoodModels}
        onClose={() => { setHoodOpen(false); }}
        client={client}
        spaceKey={spaceKey}
        spaceName={spaceName}
        sessionTitle={title}
        currentModel={stream.state.model}
        personaName={persona?.name}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        blocks={stream.state.blocks}
        onOpenWorkbench={onOpenWorkbench}
      />
    </div>
  );
}

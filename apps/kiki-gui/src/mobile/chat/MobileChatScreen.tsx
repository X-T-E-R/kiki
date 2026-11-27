import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAIN_AGENT_ID, personaGreeting, type UserBlock } from '@kiki/session-core/session';
import { pushToast } from '../../lib/toasts';

import { Icon } from '../../components/icons';

function InspectorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10 2.75V13.25" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
import { lazyComponent } from '../../lib/lazyComponent';
import {
  canFaithfullyRetryUserBlock,
  ModelSwitchActionsContext,
  type ModelSwitchNoticeActions,
} from '../../components/timeline/transcriptDeliveryContext';

const ActionSheet = lazyComponent(() =>
  import('../../components/overlays/ActionSheet').then((m) => m.ActionSheet),
);

if (import.meta.env.MODE === 'test') {
  await ActionSheet.preload();
}
import { ToastAnchor } from '../../components/Toasts';
import { useI18n } from '../../i18n';
import { isSessionNotFoundMessage, type KikiClient } from '../../lib/client';
import { useMobileSessionStream } from './useMobileSessionStream';

const LazyMobileChatWorkspace = lazy(() => import('./MobileChatWorkspace'));

interface MobileChatScreenProps {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly sessionId: string;
  readonly client: KikiClient;
  /**
   * `push`: a pushed thread with a back arrow and edge swipe.
   * `root`: the Assistant tab's resident chat.
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
  const stream = useMobileSessionStream(client, spaceKey, sessionId, onOpenProviderSettings);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [planMode, setPlanMode] = useState(false);
  const [recoveringInterruption, setRecoveringInterruption] = useState(false);
  const [pendingSwitchOperationId, setPendingSwitchOperationId] = useState<string | undefined>(undefined);
  const [restoreDraft, setRestoreDraft] = useState<{ readonly text: string; readonly nonce: number } | undefined>(undefined);
  const isRoot = variant === 'root';

  // Smooth touch left-edge swipe-back gesture on pushed chat screens.
  const [swipeX, setSwipeX] = useState(0);
  const edgeSwipeRef = useRef<{ readonly startX: number; readonly startY: number; active: boolean } | null>(null);

  const session = stream.state.session;
  const persona = session?.agent_config?.persona;
  const messageMode = session?.delivery === 'message';
  const hasUserTurn = useMemo(() => stream.state.blocks.some((block) => block.kind === 'user'), [stream.state.blocks]);

  const personaQuery = useQuery({
    queryKey: ['mobile-persona', spaceKey, client.baseUrl, persona?.id],
    enabled: persona?.id !== undefined && stream.state.loaded && !hasUserTurn && typeof client.getPersona === 'function',
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
  const waitingCount = useMemo(
    () =>
      stream.state.blocks.filter(
        (block) =>
          (block.kind === 'approval' && block.resolution === undefined) ||
          (block.kind === 'question' && block.outcome === undefined),
      ).length || (stream.state.pendingInteraction !== 'none' ? 1 : 0),
    [stream.state.blocks, stream.state.pendingInteraction],
  );
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
    edit: () => {
      document.querySelector<HTMLButtonElement>('[data-composer-compact-sheet-trigger], [data-model-picker-trigger]')?.click();
    },
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

  return (
    <div
      data-mobile-screen={isRoot ? 'assistant-chat' : 'chat'}
      style={swipeX > 0 ? { transform: `translate3d(${swipeX}px, 0, 0)` } : undefined}
      onTouchStart={(event) => {
        if (isRoot || inspectorOpen || moreMenuOpen) return;
        const touch = event.touches[0];
        if (touch === undefined || touch.clientX > 24) return;
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
      <header
        data-main-header=""
        className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline/70 px-2"
      >
        {leading ?? (
          <>
            <button
              type="button"
              data-mobile-chat-back
              aria-label={t('mobile.chat.back')}
              onClick={onBack}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/[0.05]"
            >
              <Icon name="arrowLeft" size={16} />
            </button>

            <button
              type="button"
              onClick={() => { setInspectorOpen(true); }}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left"
            >
              <h1 className="min-w-0 flex-1 truncate font-sans text-[15px] font-bold leading-5 text-ink">
                {title}
              </h1>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${stream.state.busy ? 'status-dot-busy bg-accent' : 'bg-success/80'}`}
                title={spaceName}
                aria-hidden="true"
              />
            </button>
          </>
        )}

        <button
          type="button"
          data-mobile-voice-trigger=""
          aria-label={t('mobile.chat.voice')}
          title={t('mobile.chat.voice')}
          onClick={() => {
            onOpenVoiceForChat((spoken) => {
              const trimmed = spoken.trim();
              if (trimmed === '') return;
              void stream.sendPrompt({
                text: trimmed,
                model: selectedModel,
                planMode,
                ...(greeting !== undefined && stream.state.blocks.length === 0 ? { personaGreetingReply: true } : {}),
              });
            });
          }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </button>

        <button
          type="button"
          data-rail-toggle=""
          aria-label={t('sv.togglePanelAria')}
          aria-expanded={inspectorOpen}
          onClick={() => { setInspectorOpen((prev) => !prev); }}
          className={`relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-2 transition-colors ${
            inspectorOpen ? 'bg-canvas text-ink' : 'text-ink-soft hover:bg-ink/[0.05] hover:text-ink'
          }`}
        >
          <InspectorIcon />
          {waitingCount > 0 ? (
            <span className="text-[11px] font-bold text-accent-ink tabular-nums">{waitingCount}</span>
          ) : runningTasksCount > 0 ? (
            <span className="text-[11px] text-ink-faint tabular-nums">{runningTasksCount}</span>
          ) : null}
        </button>

        <button
          type="button"
          data-mobile-chat-more
          aria-label={t('mobile.chat.more')}
          aria-expanded={moreMenuOpen}
          onClick={() => { setMoreMenuOpen(true); }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
        >
          <Icon name="more" size={16} />
        </button>
      </header>

      {belowHeader}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ToastAnchor className="kiki-mobile-toast-anchor-inline" />
        {loadError !== undefined && (!stream.state.loaded || stream.state.blocks.length === 0) ? (
          <div
            role="alert"
            data-mobile-load-error=""
            className="flex flex-1 flex-col items-center justify-center gap-4 px-6"
          >
            <div className="max-w-[360px] rounded-2xl border border-danger/30 bg-danger/5 p-4 text-center">
              <p className="text-[13px] font-bold text-danger">{t('transcript.couldNotOpen')}</p>
              <p className="mt-1 break-words font-mono text-[11px] text-danger/80">{loadError}</p>
              {canRetryLoad ? (
                <button
                  type="button"
                  data-mobile-retry-load=""
                  onClick={() => { void stream.retryLoad(); }}
                  className="mt-3 min-h-11 rounded-xl bg-accent px-4 py-2 text-[13px] font-normal text-on-accent transition-colors hover:bg-accent-deep"
                >
                  {t('common.retry')}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <ModelSwitchActionsContext.Provider value={modelSwitchActions}>
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-[12px] text-ink-faint">
                  {t('transcript.opening')}
                </div>
              }
            >
              <LazyMobileChatWorkspace
                spaceKey={spaceKey}
                spaceName={spaceName}
                sessionId={sessionId}
                client={client}
                stream={stream}
                messageMode={messageMode}
                greeting={greeting?.text}
                persona={persona}
                personaNameHint={personaNameHint}
                modelCatalog={modelsQuery.data}
                selectedModel={selectedModel}
                onSelectModel={setSelectedModel}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
                restoreDraft={restoreDraft}
                recoveringInterruption={recoveringInterruption}
                inspectorOpen={inspectorOpen}
                onInspectorOpenChange={setInspectorOpen}
                onRetryLoad={canRetryLoad ? () => { void stream.retryLoad(); } : undefined}
                onContinueFailedTurn={handleContinueFailedTurn}
                onRetryFailedTurn={handleRetryFailedTurn}
                onRetryCompaction={typeof client.compactSession === 'function' ? handleRetryCompaction : undefined}
                onRecoverInterruption={typeof client.recoverSession === 'function' ? handleRecoverInterruption : undefined}
                onOpenProviderSettings={handleOpenProviderSettings}
              />
            </Suspense>
          </ModelSwitchActionsContext.Provider>
        )}
      </div>

      {moreMenuOpen ? (
        <ActionSheet
          ariaLabel={t('mobile.chat.more')}
          overlayId="mobile-chat-more-sheet"
          dataAttribute="data-mobile-chat-more-sheet"
          onClose={() => { setMoreMenuOpen(false); }}
        >
          <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
          <div className="flex flex-col gap-0.5 py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMoreMenuOpen(false);
                setInspectorOpen(true);
              }}
              className="flex w-full items-center gap-3 text-left text-ink hover:bg-ink/[0.04]"
            >
              <InspectorIcon />
              <span>{t('sv.showPanel')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-mobile-open-workbench=""
              onClick={() => {
                setMoreMenuOpen(false);
                onOpenWorkbench();
              }}
              className="flex w-full items-center gap-3 text-left text-ink hover:bg-ink/[0.04]"
            >
              <Icon name="expand" size={16} className="text-ink-soft" />
              <span>{t('mobile.chat.openWorkbench')}</span>
            </button>
            {typeof client.compactSession === 'function' ? (
              <button
                type="button"
                role="menuitem"
                disabled={stream.state.busy}
                onClick={() => {
                  setMoreMenuOpen(false);
                  handleRetryCompaction('summarize');
                }}
                className="flex w-full items-center gap-3 text-left text-ink hover:bg-ink/[0.04] disabled:opacity-50"
              >
                <Icon name="collapse" size={16} className="text-ink-soft" />
                <span>{locale === 'zh' ? '压缩上下文' : 'Compact context'}</span>
              </button>
            ) : null}
          </div>
        </ActionSheet>
      ) : null}
    </div>
  );
}

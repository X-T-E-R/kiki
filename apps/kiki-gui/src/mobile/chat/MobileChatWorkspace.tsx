import { Drawer } from '@base-ui/react/drawer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router-dom';

import type { DeferredAppendTiming, PermissionMode, PromptSkillActivation } from '@kiki/protocol';
import {
  buildPromptContent,
  readDraft,
  writeDraft,
  type ComposerAttachment,
} from '@kiki/session-core/composer';
import {
  assistantMessageIdFromBlock,
  MAIN_AGENT_ID,
  sessionAgentForest,
  type AssistantBlock,
  type Block,
  type TranscriptDetailKind,
  type UserBlock,
} from '@kiki/session-core/session';
import { resolveCatalogModel } from '@kiki/session-core/settings';
import type { ContentRef } from '@kiki/transcript';

import { Composer, resolveSelectedEffort } from '../../components/Composer';
import { useComposerWorking } from '../../components/composerWorking';
import { Markdown } from '../../components/Markdown';
import { MediaPreviewProvider } from '../../components/mediaPreview';
import type { MediaPreviewApi } from '../../components/mediaPreviewContext';
import { MessageViewContext } from '../../components/message/messageViewContext';
import { PersonaAvatar, personaAvatarOf } from '../../components/persona/PersonaAvatar';
import { Transcript, useStableForest, type TranscriptRowActions } from '../../components/Transcript';
import { TranscriptDetailProvider, type TranscriptEntityKind } from '../../components/transcriptDetail';
import { useI18n } from '../../i18n';
import { type AgentProfileCatalogMode } from '../../lib/agentProfileCatalog';
import type { KikiClient } from '../../lib/client';
import { useLayerHistory } from '../../lib/layerHistory';
import { RECOMMENDED_PERMISSION_MODE } from '../../lib/permissionModes';
import { pushToast } from '../../lib/toasts';
import { anyOverlayOpen } from '../../lib/uiBusy';
import { ConnectionScope, useOptionalConnection, type ConnectionValue } from '../../state/connection';
import type { MobileSessionStreamResult } from './useMobileSessionStream';

const LazyRightRail = lazy(() =>
  import('../../components/RightRail').then((m) => ({ default: m.RightRail })),
);

export interface MobileChatWorkspaceProps {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly sessionId: string;
  readonly client: KikiClient;
  readonly stream: MobileSessionStreamResult;
  readonly messageMode: boolean;
  readonly greeting?: string;
  readonly persona?: { readonly id: string; readonly name: string; readonly icon?: string };
  readonly personaNameHint?: string;
  readonly modelCatalog?: Awaited<ReturnType<KikiClient['listModels']>>['items'];
  readonly selectedModel?: string;
  readonly onSelectModel: (model: string | undefined) => void;
  readonly planMode: boolean;
  readonly onPlanModeChange: (next: boolean) => void;
  readonly restoreDraft?: { readonly text: string; readonly nonce: number };
  readonly recoveringInterruption: boolean;
  readonly inspectorOpen: boolean;
  readonly onInspectorOpenChange: (open: boolean) => void;
  readonly onRetryLoad?: () => void;
  readonly onContinueFailedTurn: () => void;
  readonly onRetryFailedTurn: (failedUserBlock: UserBlock | undefined) => void;
  readonly onRetryCompaction?: (strategy: 'summarize' | 'relay') => void;
  readonly onRecoverInterruption?: () => void;
  readonly onOpenProviderSettings: () => void;
}

function buildFallbackConnectionValue(
  parent: ConnectionValue | null,
  spaceKey: string,
  client: KikiClient,
): ConnectionValue {
  if (parent !== null && parent.client === client && parent.spaceKey === spaceKey) {
    return parent;
  }
  const isRemote = spaceKey.startsWith('remote:');
  const remoteId = isRemote ? spaceKey.slice('remote:'.length) : null;
  const noopAsync = async () => {};
  const noop = () => {};
  return {
    connectionId: remoteId,
    connectionSource: isRemote ? 'remote' : (parent?.connectionSource ?? 'app-shell'),
    spaceKey,
    localSpaceKey: parent?.localSpaceKey ?? 'local',
    localScopeId: parent?.localScopeId ?? 'local',
    localServerHomeId: parent?.localServerHomeId,
    scopeId: spaceKey,
    connectionRef: remoteId ?? parent?.connectionRef,
    sshLabel: isRemote ? null : (parent?.sshLabel ?? null),
    activateSshProfile: parent?.activateSshProfile ?? noopAsync,
    activateLocal: parent?.activateLocal ?? noop,
    restoreLocal: parent?.restoreLocal ?? noopAsync,
    scopeAdapter:
      parent?.scopeAdapter ??
      ({
        currentScope: () => ({ kind: 'local' }),
        activateScope: noopAsync,
      } as unknown as ConnectionValue['scopeAdapter']),
    needsScopeReload: false,
    config: parent?.config ?? { url: client.baseUrl ?? '', token: '' },
    client,
    localClient: parent?.localClient ?? (isRemote ? (parent?.client ?? null) : client),
    klient: ((client as { klient?: unknown }).klient ?? parent?.klient ?? {}) as ConnectionValue['klient'],
    socket: (parent?.socket ?? {
      status: 'open',
      subscribe: () => noop,
      connect: noop,
      close: noop,
    }) as ConnectionValue['socket'],
    meta:
      parent?.meta ??
      ({
        version: '0.7.0',
        protocol_version: 1,
        capabilities: {},
      } as unknown as ConnectionValue['meta']),
    wsStatus: parent?.wsStatus ?? 'open',
    disconnect: parent?.disconnect ?? noop,
    applyConnection: parent?.applyConnection ?? noop,
  };
}

function MobileChatWorkspaceBody({
  spaceKey,
  spaceName,
  sessionId,
  client,
  stream,
  messageMode,
  greeting,
  persona,
  personaNameHint,
  modelCatalog,
  selectedModel,
  onSelectModel,
  planMode,
  onPlanModeChange,
  restoreDraft,
  recoveringInterruption,
  inspectorOpen,
  onInspectorOpenChange,
  onRetryLoad,
  onContinueFailedTurn,
  onRetryFailedTurn,
  onRetryCompaction,
  onRecoverInterruption,
  onOpenProviderSettings,
}: MobileChatWorkspaceProps) {
  const { t, locale } = useI18n();
  const parentConn = useOptionalConnection();
  const scopedConnection = useMemo(
    () => buildFallbackConnectionValue(parentConn, spaceKey, client),
    [client, parentConn, spaceKey],
  );

  const draftKey = `${spaceKey}::${sessionId}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => stream.state.permissionMode ?? RECOMMENDED_PERMISSION_MODE,
  );
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);
  const previewRef = useRef<MediaPreviewApi | null>(null);
  const lastRestoredNonceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setDraft(readDraft(draftKey));
    setAttachments([]);
  }, [draftKey]);

  useEffect(() => {
    if (restoreDraft === undefined || restoreDraft.nonce === lastRestoredNonceRef.current) return;
    lastRestoredNonceRef.current = restoreDraft.nonce;
    setDraft((prev) => {
      const next = prev.trim() === '' ? restoreDraft.text : `${prev}\n${restoreDraft.text}`;
      writeDraft(draftKey, next);
      return next;
    });
  }, [draftKey, restoreDraft]);

  const handleDraftChange = useCallback(
    (next: string) => {
      setDraft(next);
      writeDraft(draftKey, next);
    },
    [draftKey],
  );

  const handleAttachmentsChange = useCallback(
    (
      next:
        | readonly ComposerAttachment[]
        | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
    ) => {
      setAttachments((prev) => (typeof next === 'function' ? next(prev) : next));
    },
    [],
  );

  const state = stream.state;
  const session = state.session;
  const rawForest = useMemo(
    () => stream.controller?.getForest() ?? sessionAgentForest(state),
    [state, stream.controller],
  );
  const forest = useStableForest(rawForest);

  const queryClient = useQueryClient();
  if (modelCatalog !== undefined && queryClient.getQueryData(['models']) === undefined) {
    queryClient.setQueryData(['models'], { items: modelCatalog });
  }
  const configQuery = useQuery({
    queryKey: ['config', spaceKey],
    queryFn: () => client.getConfig(),
    enabled: typeof client.getConfig === 'function' && modelCatalog === undefined,
    staleTime: 60_000,
    retry: 1,
  });
  const serverDefaultModel = configQuery.data?.default_model ?? modelCatalog?.[0]?.id;
  const sessionModel = state.model ?? session?.agent_config?.model ?? undefined;
  const effectiveModel = selectedModel ?? sessionModel ?? serverDefaultModel;
  const catalogEntry = useMemo(
    () => (effectiveModel === undefined ? undefined : resolveCatalogModel(modelCatalog ?? [], effectiveModel)),
    [effectiveModel, modelCatalog],
  );
  const supportedEfforts = catalogEntry?.support_efforts;
  const effectiveEffort = resolveSelectedEffort(
    supportedEfforts,
    effortOverride ?? state.thinkingEffort ?? session?.agent_config?.execution?.selection?.overrides?.thinking ?? undefined,
    catalogEntry?.default_effort,
  );

  const canAbort =
    state.busy && (state.abortablePromptId !== undefined || state.abortableTurnId !== undefined);
  const composerWorking =
    (canAbort || (state.busy && session?.main_turn_active === true)) &&
    state.pendingInteraction === 'none';
  const workingTiming = useComposerWorking({
    busy: composerWorking,
    scopeKey: draftKey,
    loaded: state.loaded,
    blocks: state.blocks,
    turnStartedAt: state.turnStartedAt,
  });
  const workingInfo = useMemo(
    () =>
      composerWorking
        ? {
            startedAt: workingTiming.startedAt,
            lastResponseAt: workingTiming.lastResponseAt,
          }
        : undefined,
    [composerWorking, workingTiming.lastResponseAt, workingTiming.startedAt],
  );

  const composerContextUsage = useMemo(() => {
    const usage = session?.usage;
    if (usage === undefined || usage.context_limit <= 0) return undefined;
    return {
      tokens: usage.context_tokens,
      limit: usage.context_limit,
    };
  }, [session?.usage]);

  const agentProfileCatalogMode = useMemo<AgentProfileCatalogMode>(() => ({ mode: 'disabled' }), []);

  const messageViewContext = useMemo(
    () => ({
      persona: persona !== undefined ? personaAvatarOf(persona) : undefined,
      sessionId,
      internalProse: messageMode,
    }),
    [messageMode, persona, sessionId],
  );

  const handleSend = useCallback(
    async (
      text: string,
      currentAttachments: readonly ComposerAttachment[],
      options?: {
        readonly goalObjective?: string;
        readonly appendTiming?: DeferredAppendTiming;
        readonly presentation?: import('@kiki/transcript').TextPresentation;
        readonly skills?: readonly PromptSkillActivation[];
      },
    ) => {
      const content = buildPromptContent(text, currentAttachments, options?.presentation);
      if (content === null) return;
      const textPart = content.find((part) => part.type === 'text');
      const echoText = textPart !== undefined && textPart.type === 'text' ? textPart.text : text;
      const ok = await stream.sendPrompt({
        text: echoText,
        content,
        model: selectedModel,
        thinking: effortOverride,
        permissionMode,
        planMode,
        timing: options?.appendTiming,
        skills: options?.skills,
        ...(greeting !== undefined && state.blocks.length === 0 ? { personaGreetingReply: true } : {}),
      });
      if (ok) {
        setDraft('');
        writeDraft(draftKey, '');
        setAttachments([]);
      }
    },
    [
      draftKey,
      effortOverride,
      greeting,
      permissionMode,
      planMode,
      selectedModel,
      state.blocks.length,
      stream,
    ],
  );

  const handleSendNow = useCallback(
    async (
      text: string,
      currentAttachments: readonly ComposerAttachment[],
      presentation?: import('@kiki/transcript').TextPresentation,
      skills?: readonly PromptSkillActivation[],
    ) => {
      const content = buildPromptContent(text, currentAttachments, presentation);
      if (content === null) return;
      const textPart = content.find((part) => part.type === 'text');
      const echoText = textPart !== undefined && textPart.type === 'text' ? textPart.text : text;
      const ok = await stream.sendPrompt({
        text: echoText,
        content,
        skills,
        now: true,
      });
      if (ok) {
        setDraft('');
        writeDraft(draftKey, '');
        setAttachments([]);
      }
    },
    [draftKey, stream],
  );

  const rowActions = useMemo<TranscriptRowActions>(
    () => ({
      disabled: state.busy || state.resyncing === true,
      canFork: false,
      onEditMessage: async (
        block: UserBlock,
        text: string,
        editedAttachments: readonly ComposerAttachment[] = [],
        presentation,
      ) => {
        if (stream.controller === null || block.userMessageId === undefined) return;
        const content = buildPromptContent(text, editedAttachments, presentation);
        if (content === null) return;
        await stream.controller.editMessage(block.userMessageId, { text, content });
      },
      onRegenerate: (block: AssistantBlock) => {
        if (state.busy) return;
        // Find preceding user block in the same turn to regenerate cleanly.
        const blocks: readonly Block[] = state.blocks;
        const idx = blocks.findIndex((candidate) => candidate.id === block.id);
        for (let i = (idx >= 0 ? idx : blocks.length) - 1; i >= 0; i -= 1) {
          const candidate = blocks[i]!;
          if (candidate.kind === 'user' && candidate.userMessageId !== undefined) {
            void stream.regenerateMessage(candidate.userMessageId);
            return;
          }
        }
        const assistantMsgId = assistantMessageIdFromBlock(block);
        if (assistantMsgId !== undefined) {
          void stream.regenerateMessage(assistantMsgId);
        }
      },
      onFork: () => {},
    }),
    [state.blocks, state.busy, state.resyncing, stream],
  );

  const showGreeting =
    state.loaded &&
    greeting !== undefined &&
    state.blocks.length === 0 &&
    !state.hasMoreHistory &&
    !state.busy;

  useLayerHistory('mobile-chat-inspector', inspectorOpen, () => {
    onInspectorOpenChange(false);
  });

  const handleOpenFileInPreview = useCallback((path: string) => {
    onInspectorOpenChange(false);
    previewRef.current?.openFile(path);
  }, [onInspectorOpenChange]);

  const placeholderLabel = persona?.name ?? personaNameHint ?? spaceName;

  return (
    <ConnectionScope value={scopedConnection}>
      <MediaPreviewProvider
        sessionId={sessionId}
        cwd={session?.metadata?.cwd}
        sessionViewState={state}
        agentForest={forest}
        controller={stream.controller}
        apiRef={previewRef}
      >
        <TranscriptDetailProvider
          controller={stream.controller ?? undefined}
          load={(agentId: string, kind: TranscriptDetailKind, id: string) =>
            stream.controller?.loadTranscriptDetail(agentId, kind, id) ?? Promise.resolve(false)}
          loads={state.detailLoads}
          contentRefs={state.contentRefs}
          sessionId={sessionId}
          agentId={MAIN_AGENT_ID}
          loadContent={(ref: ContentRef) =>
            stream.controller?.loadContentSegment(MAIN_AGENT_ID, ref) ?? Promise.resolve(false)}
          loadEntities={(kind: TranscriptEntityKind) =>
            stream.controller?.loadTranscriptEntities(MAIN_AGENT_ID, kind) ?? Promise.resolve(false)}
        >
          <MessageViewContext.Provider value={messageViewContext}>
            <div
              className="flex min-h-0 flex-1 flex-col"
              style={{ '--kiki-seat-height': '0px' } as CSSProperties}
            >
              {showGreeting ? (
                <div
                  data-mobile-transcript=""
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6"
                >
                  <div className="mx-auto flex w-full max-w-[var(--kiki-chat-content-width,760px)] flex-col gap-3">
                    {persona !== undefined ? (
                      <div className="flex items-center gap-2">
                        <PersonaAvatar persona={personaAvatarOf(persona)} size={24} />
                        <span className="text-[13px] font-bold text-ink-soft">{persona.name}</span>
                      </div>
                    ) : null}
                    <div data-mobile-msg="greeting" className="kiki-prose w-full text-ink">
                      <Markdown text={greeting} />
                    </div>
                  </div>
                </div>
              ) : (
                <Transcript
                  state={state}
                  view={messageMode ? 'message' : 'process'}
                  forest={forest}
                  rowActions={rowActions}
                  modelCatalog={modelCatalog}
                  modelCatalogScope={spaceKey}
                  interruptedWork={session?.interrupted_work}
                  recoveringInterruption={recoveringInterruption}
                  onRecoverInterruption={onRecoverInterruption}
                  onLoadOlder={stream.loadOlder}
                  onRetryLoad={onRetryLoad}
                  onResolveApproval={async (approvalId, decision, scope) => {
                    await stream.resolveApproval(approvalId, decision, scope);
                  }}
                  onAnswerQuestion={async (questionId, answers) => {
                    await stream.answerQuestion(questionId, answers);
                  }}
                  onDismissQuestion={async (questionId) => {
                    await stream.dismissQuestion(questionId);
                  }}
                  onContinueFailedTurn={onContinueFailedTurn}
                  onRetryFailedTurn={onRetryFailedTurn}
                  onRetryCompaction={onRetryCompaction}
                  onOpenModelPicker={() => {
                    // Focus or open model sheet via composer's model trigger
                    document.querySelector<HTMLButtonElement>('[data-composer-compact-sheet-trigger], [data-model-picker-trigger]')?.click();
                  }}
                  onOpenProviderSettings={onOpenProviderSettings}
                  onCompactContext={
                    onRetryCompaction === undefined
                      ? undefined
                      : () => {
                          onRetryCompaction('summarize');
                        }
                  }
                />
              )}

              <div
                data-mobile-composer-dock=""
                className="relative shrink-0 px-3 pt-1 pb-[calc(10px+var(--kiki-safe-bottom-inset))]"
              >
                <div className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)]">
                  <Composer
                    busy={state.busy}
                    disabled={!state.loaded && state.loadError !== undefined}
                    disabledPlaceholder={t('mobile.chat.composerPlaceholder', { space: placeholderLabel })}
                    value={draft}
                    onChange={handleDraftChange}
                    model={selectedModel}
                    defaultModel={sessionModel}
                    serverDefaultModel={serverDefaultModel}
                    modelSource={selectedModel !== undefined ? 'override' : sessionModel !== undefined ? 'session' : 'server-default'}
                    permissionMode={permissionMode}
                    planMode={planMode}
                    efforts={supportedEfforts}
                    effort={effectiveEffort}
                    contextUsage={composerContextUsage}
                    sessionId={sessionId}
                    workspaceId={session?.workspace_id}
                    agentProfileCatalogMode={agentProfileCatalogMode}
                    attachments={attachments}
                    onChangeAttachments={handleAttachmentsChange}
                    onChangeModel={(next) => {
                      onSelectModel(next);
                    }}
                    onChangePermissionMode={setPermissionMode}
                    onChangePlanMode={onPlanModeChange}
                    onChangeEffort={setEffortOverride}
                    onCompactContext={
                      typeof client.compactSession === 'function'
                        ? () => {
                            onRetryCompaction?.('summarize');
                          }
                        : undefined
                    }
                    onSend={handleSend}
                    onSendNow={state.busy ? handleSendNow : undefined}
                    working={workingInfo}
                    onAbort={() => {
                      void stream.abort();
                    }}
                    autoFocus={false}
                    onOpenImage={(src, name) => {
                      previewRef.current?.openImage(src, name);
                    }}
                  />
                </div>
              </div>
            </div>

            {stream.controller !== null ? (
              <Drawer.Root
                open={inspectorOpen}
                modal="trap-focus"
                onOpenChange={(nextOpen, eventDetails) => {
                  if (!nextOpen && (eventDetails.reason === 'outside-press' || eventDetails.reason === 'escape-key') && anyOverlayOpen()) {
                    eventDetails.cancel();
                    return;
                  }
                  onInspectorOpenChange(nextOpen);
                }}
                swipeDirection="down"
                snapPoints={[0.68, 0.94]}
              >
                <Drawer.Portal>
                  <Drawer.Backdrop className="kiki-drawer-backdrop" />
                  <Drawer.Viewport className="kiki-drawer-viewport-bottom">
                    <Drawer.Popup
                      data-mobile-inspector-drawer=""
                      aria-label={locale === 'zh' ? '会话检查器' : 'Session inspector'}
                      className="kiki-drawer-bottom h-[92dvh]"
                    >
                      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
                      <Suspense
                        fallback={
                          <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-ink-faint">
                            {t('transcript.opening')}
                          </div>
                        }
                      >
                        <LazyRightRail
                          className="app-rail open flex min-h-0 w-full flex-1 flex-col"
                          state={state}
                          forest={forest}
                          selectedAgentId={MAIN_AGENT_ID}
                          onOpenSubagent={(agentId) => {
                            previewRef.current?.openAgentPanel(agentId);
                            onInspectorOpenChange(false);
                          }}
                          onClose={() => {
                            onInspectorOpenChange(false);
                          }}
                          onOpenFile={handleOpenFileInPreview}
                          onCancelTask={(taskId, ownerAgentId) => {
                            if (typeof client.cancelTask !== 'function') return;
                            void client
                              .cancelTask(sessionId, taskId, ownerAgentId !== undefined ? { agent_id: ownerAgentId } : undefined)
                              .catch((err: unknown) => {
                                pushToast({
                                  tone: 'error',
                                  text: err instanceof Error ? err.message : String(err),
                                });
                              });
                          }}
                          onResolveApproval={async (approvalId, decision) => {
                            await stream.resolveApproval(approvalId, decision);
                          }}
                        />
                      </Suspense>
                    </Drawer.Popup>
                  </Drawer.Viewport>
                </Drawer.Portal>
              </Drawer.Root>
            ) : null}
          </MessageViewContext.Provider>
        </TranscriptDetailProvider>
      </MediaPreviewProvider>
    </ConnectionScope>
  );
}

export default function MobileChatWorkspace(props: MobileChatWorkspaceProps) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return (
      <MemoryRouter>
        <MobileChatWorkspaceBody {...props} />
      </MemoryRouter>
    );
  }
  return <MobileChatWorkspaceBody {...props} />;
}

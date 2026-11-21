import { useRef, useState } from 'react';

import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { LiftTheHoodSheet, type HoodTab } from './LiftTheHoodSheet';
import { MobileComposer } from './MobileComposer';
import { MobileTranscript } from './MobileTranscript';
import { useMobileSessionStream } from './useMobileSessionStream';

interface MobileChatScreenProps {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly sessionId: string;
  readonly client: KikiClient;
  readonly onBack: () => void;
  readonly onOpenWorkbench: () => void;
  readonly onOpenVoiceForChat: (onResult: (text: string) => void) => void;
}

export function MobileChatScreen({
  spaceKey,
  spaceName,
  sessionId,
  client,
  onBack,
  onOpenWorkbench,
  onOpenVoiceForChat,
}: MobileChatScreenProps) {
  const { t } = useI18n();
  const stream = useMobileSessionStream(client, spaceKey, sessionId);
  const [hoodOpen, setHoodOpen] = useState(false);
  const [hoodTab, setHoodTab] = useState<HoodTab>('info');
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [planMode, setPlanMode] = useState(false);

  // Smooth touch left-edge swipe-back gesture (zero document reload).
  const [swipeX, setSwipeX] = useState(0);
  const edgeSwipeRef = useRef<{ readonly startX: number; readonly startY: number; active: boolean } | null>(null);

  const openHood = (tab: HoodTab) => {
    setHoodTab(tab);
    setHoodOpen(true);
  };

  const title = stream.state.session?.title?.trim() || t('mobile.chats.title');
  const runningTasksCount = stream.state.tasks.filter((task) => task.status === 'running').length;
  const subStatus = stream.state.busy ? `${spaceName} · ${t('mobile.chat.thinking')}` : spaceName;

  return (
    <div
      data-mobile-screen="chat"
      style={swipeX > 0 ? { transform: `translate3d(${swipeX}px, 0, 0)` } : undefined}
      onTouchStart={(event) => {
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
          onBack();
          return;
        }
        setSwipeX(0);
        edgeSwipeRef.current = null;
      }}
      className="kiki-mobile-push-screen flex min-h-0 flex-1 flex-col bg-paper"
    >
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-hairline/65 px-2">
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
          className="flex min-w-0 flex-1 flex-col items-start text-left"
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

      <MobileTranscript
        blocks={stream.state.blocks}
        loaded={stream.state.loaded}
        hasMoreHistory={stream.state.hasMoreHistory}
        loadingOlder={stream.loadingOlder}
        onLoadOlder={() => { void stream.loadOlder(); }}
        onOpenHood={openHood}
        onResolveApproval={(approvalId, decision) => { void stream.resolveApproval(approvalId, decision); }}
        onOpenWorkbench={onOpenWorkbench}
      />

      {runningTasksCount > 0 ? (
        <div className="shrink-0 px-3 pb-1">
          <button
            type="button"
            data-mobile-live-pill
            onClick={() => { openHood('tools'); }}
            className="mx-auto flex h-10 w-full max-w-[640px] items-center justify-between gap-2 rounded-2xl border border-hairline/90 bg-panel px-3.5 text-[13px] text-ink shadow-xs"
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
        spaceName={spaceName}
        busy={stream.state.busy}
        planMode={planMode}
        onPlanModeChange={setPlanMode}
        onOpenModelPicker={() => { openHood('info'); }}
        onOpenVoice={() => {
          onOpenVoiceForChat((spoken) => {
            void stream.sendPrompt({ text: spoken, model: selectedModel, planMode });
          });
        }}
        onSend={(text, timing) =>
          stream.sendPrompt({
            text,
            model: selectedModel,
            planMode,
            timing,
          })
        }
        onAbort={stream.abort}
      />

      <LiftTheHoodSheet
        open={hoodOpen}
        initialTab={hoodTab}
        onClose={() => { setHoodOpen(false); }}
        client={client}
        spaceName={spaceName}
        sessionTitle={title}
        currentModel={stream.state.model}
        personaName={stream.state.session?.agent_config?.persona?.name}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        blocks={stream.state.blocks}
        onOpenWorkbench={onOpenWorkbench}
      />
    </div>
  );
}

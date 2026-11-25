import { useEffect, useRef, useState } from 'react';
import { AudioLines, Mic } from 'lucide-react';

import type { DeferredAppendTiming } from '@kiki/protocol';
import { readDraft, writeDraft } from '@kiki/session-core/composer';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { useI18n } from '../../i18n';

interface MobileComposerProps {
  readonly draftKey: string;
  readonly spaceName: string;
  readonly busy: boolean;
  readonly planMode: boolean;
  readonly onPlanModeChange: (next: boolean) => void;
  readonly onOpenModelPicker: () => void;
  readonly onOpenVoice: () => void;
  readonly onSend: (text: string, timing?: DeferredAppendTiming) => Promise<boolean>;
  readonly onAbort: () => Promise<void>;
  readonly restoreDraft?: { readonly text: string; readonly nonce: number };
}

export function MobileComposer({
  draftKey,
  spaceName,
  busy,
  planMode,
  onPlanModeChange,
  onOpenModelPicker,
  onOpenVoice,
  onSend,
  onAbort,
  restoreDraft,
}: MobileComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState(() => readDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setText(readDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (restoreDraft === undefined) return;
    setText(restoreDraft.text);
    writeDraft(draftKey, restoreDraft.text);
    textareaRef.current?.focus();
  }, [draftKey, restoreDraft]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(132, Math.max(44, el.scrollHeight))}px`;
  }, [text]);

  const hasText = text.trim() !== '';

  const handleChange = (next: string) => {
    setText(next);
    writeDraft(draftKey, next);
  };

  const handlePrimaryAction = async () => {
    if (sending) return;
    if (busy && !hasText) {
      await onAbort();
      return;
    }
    if (!hasText) {
      onOpenVoice();
      return;
    }
    const payload = text.trim();
    setSending(true);
    try {
      const ok = await onSend(payload);
      if (ok) {
        setText('');
        writeDraft(draftKey, '');
      }
    } finally {
      setSending(false);
    }
  };

  const primaryState: 'voice' | 'send' | 'stop' | 'steer' =
    busy && hasText
      ? 'steer'
      : busy
        ? 'stop'
        : hasText
          ? 'send'
          : 'voice';

  const primaryLabel =
    primaryState === 'stop'
      ? t('mobile.chat.abort')
      : primaryState === 'steer'
        ? t('mobile.chat.sendNow')
        : primaryState === 'send'
          ? t('mobile.chat.send')
          : t('mobile.chat.voice');

  return (
    <div
      data-mobile-composer
      className="shrink-0 bg-paper px-3 pb-[max(10px,var(--kiki-safe-bottom-inset))] pt-2"
    >
      <div className="mx-auto flex w-full max-w-[640px] items-end gap-1.5 rounded-[28px] border border-hairline bg-panel px-1.5 py-1.5 shadow-[0_2px_12px_-4px_rgb(var(--kiki-shadow-ink)/0.1)]">
        <button
          type="button"
          data-mobile-composer-plus
          aria-label={t('mobile.chat.options')}
          onClick={() => { setOptionsOpen(true); }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink-soft transition-colors hover:bg-ink/[0.1] hover:text-ink"
        >
          <Icon name="plus" size={16} />
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          data-mobile-composer-input
          value={text}
          onChange={(event) => { handleChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void handlePrimaryAction();
            }
          }}
          placeholder={t('mobile.chat.composerPlaceholder', { space: spaceName })}
          className="min-h-[44px] max-h-[132px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[11px] text-[16px] leading-[1.4] text-ink placeholder:text-ink-faint focus:outline-none"
        />

        {hasText ? null : (
          <button
            type="button"
            aria-label={t('mobile.chat.dictate')}
            onClick={onOpenVoice}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Mic className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          data-mobile-composer-primary={primaryState}
          aria-label={primaryLabel}
          disabled={sending}
          onClick={() => { void handlePrimaryAction(); }}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
            primaryState === 'send' || primaryState === 'steer'
              ? 'bg-accent text-primary-foreground hover:bg-accent-deep'
              : 'bg-ink text-paper'
          }`}
        >
          {primaryState === 'stop' ? (
            <Icon name="stop" size={12} />
          ) : primaryState === 'send' || primaryState === 'steer' ? (
            <Icon name="arrowUp" size={16} />
          ) : (
            <AudioLines className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
          )}
        </button>
      </div>

      {optionsOpen ? (
        <ActionSheet
          role="menu"
          ariaLabel={t('mobile.chat.options')}
          overlayId="mobile-composer-options"
          onClose={() => { setOptionsOpen(false); }}
          sheetClassName="rounded-t-[24px]!"
        >
          <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPlanModeChange(!planMode);
              setOptionsOpen(false);
            }}
            className="flex w-full items-center justify-between text-left text-ink hover:bg-ink/[0.04]"
          >
            <span className="flex items-center gap-3">
              <Icon name="plan" size={16} className="text-ink-soft" />
              <span>{planMode ? t('mobile.chat.modeDefault') : t('mobile.chat.modePlan')}</span>
            </span>
            {planMode ? <Icon name="check" size={16} className="text-accent" /> : null}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOptionsOpen(false);
              onOpenModelPicker();
            }}
            className="flex w-full items-center justify-between text-left text-ink hover:bg-ink/[0.04]"
          >
            <span className="flex items-center gap-3">
              <Icon name="star" size={16} className="text-ink-soft" />
              <span>{t('mobile.chat.modelLabel')}</span>
            </span>
            <Icon name="chevron" size={14} className="text-ink-faint" />
          </button>
        </ActionSheet>
      ) : null}
    </div>
  );
}

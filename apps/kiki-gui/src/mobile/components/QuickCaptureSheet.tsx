import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';

import { randomUuid } from '@kiki/session-core/util';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { pushToast } from '../../lib/toasts';

interface QuickCaptureSheetProps {
  readonly open: boolean;
  readonly initialText?: string;
  readonly targetSpaceKey: string;
  readonly targetSpaceName: string;
  readonly client: KikiClient;
  readonly onClose: () => void;
  readonly onOpenSpacePicker: () => void;
  readonly onOpenVoice: () => void;
  readonly onCreatedSession: (spaceKey: string, sessionId: string) => void;
}

export function QuickCaptureSheet({
  open,
  initialText = '',
  targetSpaceKey,
  targetSpaceName,
  client,
  onClose,
  onOpenSpacePicker,
  onOpenVoice,
  onCreatedSession,
}: QuickCaptureSheetProps) {
  const { t } = useI18n();
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      if (initialText !== '') setText(initialText);
      const timer = setTimeout(() => { inputRef.current?.focus(); }, 60);
      return () => { clearTimeout(timer); };
    }
    return undefined;
  }, [open, initialText]);

  if (!open) return null;

  const canSend = text.trim() !== '' && !sending;

  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || sending) return;
    setSending(true);
    try {
      const created = await client.createSession({
        creation_id: randomUuid(),
      });
      await client.submitPrompt(created.id, {
        prompt_id: randomUuid(),
        content: [{ type: 'text', text: trimmed }],
      });
      setText('');
      onClose();
      onCreatedSession(targetSpaceKey, created.id);
    } catch (error) {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <ActionSheet
      role="dialog"
      ariaLabel={t('mobile.quick.title')}
      overlayId="mobile-quick-capture"
      dataAttribute="data-mobile-quick-sheet"
      onClose={onClose}
      autofocus={false}
      sheetClassName="rounded-t-[24px]!"
    >
      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onOpenSpacePicker}
            className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-[12.5px] font-medium text-ink"
          >
            <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-success" aria-hidden="true" />
            <span className="min-w-0 truncate">{targetSpaceName}</span>
          </button>
          <button
            type="button"
            aria-label={t('mobile.voice.cancel')}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-faint hover:bg-ink/[0.06] hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <textarea
          ref={inputRef}
          rows={4}
          data-mobile-quick-input
          value={text}
          onChange={(event) => { setText(event.target.value); }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('mobile.quick.placeholder')}
          className="min-h-[108px] w-full resize-none bg-transparent text-[16px] leading-[1.55] text-ink placeholder:text-ink-faint focus:outline-none"
        />

        <div className="flex items-center justify-between border-t border-hairline/70 pt-2.5">
          <button
            type="button"
            aria-label={t('mobile.chat.voice')}
            onClick={() => {
              onClose();
              onOpenVoice();
            }}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-ink/[0.06] text-ink-soft transition-colors hover:bg-ink/[0.1] hover:text-ink"
          >
            <Mic className="h-4 w-4" strokeWidth={1.85} aria-hidden="true" />
          </button>

          <button
            type="button"
            data-mobile-quick-send
            disabled={!canSend}
            onClick={() => { void submit(); }}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-5 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep disabled:opacity-45"
          >
            <span>{t('mobile.quick.send')}</span>
            <Icon name="arrowUp" size={14} />
          </button>
        </div>
      </div>
    </ActionSheet>
  );
}

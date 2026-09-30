/**
 * RoomComposer — the room's one input. Typing `@` opens the member list
 * (「所有人」 first); ↑↓ picks, Enter or Tab inserts, Esc closes. Enter sends,
 * Shift+Enter breaks the line. The placeholder states the routing rule, the
 * one place the rule is written down.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { PersonaAvatar, type PersonaAvatarData } from '../persona/PersonaAvatar';
import { mentionAtCaret, mentionOptions, type MentionOption } from './roomLog';

export interface RoomComposerMember {
  readonly personaId: string;
  readonly name: string;
  readonly hint?: string;
  readonly face: PersonaAvatarData;
}

export function RoomComposer({
  roomName,
  hostName,
  hostIsThread = false,
  members,
  sending,
  onSend,
}: {
  readonly roomName: string;
  readonly hostName: string;
  /** True when a thread hosts the room; thread-host rooms use their own placeholder copy. */
  readonly hostIsThread?: boolean;
  readonly members: readonly RoomComposerMember[];
  readonly sending: boolean;
  /** Resolves true when the message was accepted (the draft then clears). */
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const listId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(undefined);

  const mention = mentionAtCaret(text, caret);
  const options: MentionOption[] = mention === undefined ? [] : mentionOptions(
    members,
    mention.query,
    { label: t('room.everyone'), hint: t('room.everyoneHint') },
  );
  const open = mention !== undefined && options.length > 0 && dismissedAt !== mention.start;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const faces = new Map(members.map((member) => [member.personaId, member.face]));
  const placeholder = hostIsThread ? t('room.placeholderThreadHost', { name: roomName }) : t('room.placeholder', { name: roomName, host: hostName });

  useLayoutEffect(() => {
    const node = textarea.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [text]);

  const insert = (option: MentionOption) => {
    if (mention === undefined) return;
    const next = `${text.slice(0, mention.start)}@${option.insert} ${text.slice(caret)}`;
    const nextCaret = mention.start + option.insert.length + 2;
    setText(next);
    setCaret(nextCaret);
    setActive(0);
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || sending) return;
    if (await onSend(trimmed)) {
      setText('');
      setCaret(0);
    }
  };

  const syncCaret = () => { setCaret(textarea.current?.selectionStart ?? text.length); };

  return (
    <div className="relative" data-room-composer>
      {open ? (
        <div className="anim-enter absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-[12px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
          <ul id={listId} role="listbox" aria-label={t('room.mentionListAria')} data-room-mentions className="max-h-60 overflow-y-auto">
            {options.map((option, index) => {
              const face = option.personaId === undefined ? undefined : faces.get(option.personaId);
              return (
                <li key={option.key} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
                  data-room-mention={option.key}
                  onPointerDown={(event) => { event.preventDefault(); insert(option); }}
                  onPointerEnter={() => { setActive(index); }}
                  className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 ${index === activeIndex ? 'bg-selected' : ''}`}>
                  {face !== undefined ? <PersonaAvatar persona={face} size={22} decorative /> : (
                    <span aria-hidden className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-ink/[0.06] text-[12px] font-medium text-ink-soft">@</span>
                  )}
                  <span className="min-w-0 shrink truncate text-[13px] text-ink">{option.label}</span>
                  {option.hint !== undefined ? <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{option.hint}</span> : null}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-hairline px-3 pt-1.5 pb-1 text-[11.5px] text-ink-faint max-sm:hidden">{t('room.mentionHint')}</p>
        </div>
      ) : null}
      <div className="composer-card flex items-end gap-2 rounded-[18px] bg-panel py-2 pr-2 pl-4">
        <textarea
          ref={textarea}
          rows={1}
          value={text}
          data-room-input
          aria-label={placeholder}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setDismissedAt(undefined);
          }}
          onSelect={syncCaret}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (open) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((current) => (Math.min(current, options.length - 1) + step + options.length) % options.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const option = options[activeIndex];
                if (option !== undefined) insert(option);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedAt(mention?.start);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          className="max-h-[200px] min-h-6 flex-1 resize-none self-center bg-transparent py-1.5 text-[14px] leading-6 text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          data-room-send
          onClick={() => { void send(); }}
          disabled={text.trim() === '' || sending}
          aria-label={t('room.send')}
          title={t('room.send')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:bg-hairline disabled:text-ink-faint"
        >
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
    </div>
  );
}

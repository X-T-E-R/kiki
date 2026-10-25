/**
 * Where a delivered message actually went, written as quiet lines under the
 * speech it belongs to.
 *
 * The projection already decided what reached this conversation (`reached`)
 * and which destination reported what (`channels`); this file only says it in
 * words. Nothing here infers delivery: a channel that reported `unsupported`
 * took none of the attachments, an `unknown` outcome stays unknown, and a
 * message that reached another destination is never drawn as if it had been
 * read here.
 */

import type { I18nKey } from '@kiki/session-core/i18n';
import type { MessageBlock, MessageChannelDelivery } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';

const KIND_LABEL: Readonly<Record<string, I18nKey>> = {
  image: 'message.media.image',
  file: 'message.media.file',
  audio: 'message.media.audio',
  voice: 'message.media.voice',
  video: 'message.media.video',
};

type Translate = ReturnType<typeof useI18n>['t'];
type Locale = ReturnType<typeof useI18n>['locale'];

/** A destination as the receipt named it; `internal` is this conversation. */
function channelName(channelId: string, t: Translate): string {
  return channelId === 'internal' ? t('message.internal') : channelId;
}

/** Media kinds in the reader's words; a kind this build does not know keeps its token. */
function kindList(kinds: readonly string[], t: Translate, locale: Locale): string {
  return kinds
    .map((kind) => {
      const label = KIND_LABEL[kind];
      return label === undefined ? kind : t(label);
    })
    .join(locale === 'zh' ? '、' : ', ');
}

interface DeliveryNote {
  readonly id: string;
  readonly text: string;
  readonly icon: 'external' | 'info' | 'warning';
  readonly action: boolean;
}

/** The notes a destination list produces; empty when everything simply landed. */
export function deliveryNotes(block: MessageBlock, t: Translate, locale: Locale): DeliveryNote[] {
  const channels = block.channels ?? [];
  const unconfirmed = block.status === 'pending' || block.reached === 'unconfirmed';
  // An older receipt can report an unconfirmed outcome without naming any
  // channel; the reader is still owed the fact that nothing confirmed it.
  if (channels.length === 0 && !unconfirmed) return [];
  const separator = locale === 'zh' ? '、' : ', ';
  const internal = channels.find((channel) => channel.channelId === 'internal');
  const external = channels.filter((channel) => channel.channelId !== 'internal');
  const reachedElsewhere = block.reached === 'elsewhere'
    ? external.filter((channel) => channel.status === 'delivered').map((channel) => channelName(channel.channelId, t))
    : [];
  const notes: DeliveryNote[] = [];
  if (reachedElsewhere.length > 0) {
    notes.push({ id: 'elsewhere', text: t('message.deliveryElsewhere', { channels: reachedElsewhere.join(separator) }), icon: 'external', action: false });
  }
  if (unconfirmed) {
    notes.push({ id: 'unconfirmed', text: t('message.deliveryUnconfirmed'), icon: 'warning', action: true });
  }
  // A channel that delivered the text can still name media it did not take;
  // `unsupported` alone means it took none of the attachments at all.
  const internalKinds = internal?.unsupported ?? [];
  if (internalKinds.length > 0 || internal?.status === 'unsupported' || internal?.status === 'partial') {
    const text = internalKinds.length > 0
      ? t('message.internalUnsupported', { kinds: kindList(internalKinds, t, locale) })
      : internal?.status === 'partial'
        ? t('message.internalPartial')
        : t('message.channelFailed', { channel: channelName('internal', t) });
    const id = internalKinds.length > 0
      ? 'internal-unsupported'
      : internal?.status === 'partial'
        ? 'internal-partial'
        : 'internal-failed';
    notes.push({ id, text, icon: 'info', action: false });
  }
  for (const channel of external) {
    const name = channelName(channel.channelId, t);
    const kinds = channel.unsupported ?? [];
    // An unknown outcome outranks any media list: nothing about that endpoint
    // is confirmed, so it cannot also claim which attachments it skipped.
    if (channel.status === 'unknown') {
      notes.push({ id: `channel-unknown-${channel.channelId}`, text: t('message.channelUnknown', { channel: name }), icon: 'warning', action: false });
    } else if (kinds.length > 0 || channel.status === 'partial') {
      // `delivered` with a non-empty list or `partial` is a partial send: the endpoint took
      // the message and named the media it did not take (or reported partial status).
      const text = kinds.length > 0
        ? t('message.channelUnsupported', { channel: name, kinds: kindList(kinds, t, locale) })
        : t('message.channelPartial', { channel: name });
      notes.push({ id: `channel-unsupported-${channel.channelId}`, text, icon: 'info', action: false });
    } else if (channel.status === 'unsupported' || channel.status === 'failed') {
      notes.push({ id: `channel-failed-${channel.channelId}`, text: t('message.channelFailed', { channel: name }), icon: 'warning', action: false });
    }
  }
  return notes;
}

/**
 * The notes for one message: a destination line for speech that landed
 * elsewhere, an unconfirmed line that opens the process, and one line per
 * destination that took less than the whole message.
 */
export function DeliveryNotes({ block, onOpenProcess }: { readonly block: MessageBlock; readonly onOpenProcess?: () => void }) {
  const { t, locale } = useI18n();
  const notes = deliveryNotes(block, t, locale);
  if (notes.length === 0) return null;
  return (
    <div data-message-delivery-notes={block.reached ?? block.status} className="mt-1 flex flex-col gap-0.5">
      {notes.map((note) => {
        const body = (
          <>
            <Icon name={note.icon} size={12} className="mt-[3px] shrink-0" />
            <span className="min-w-0">{note.text}</span>
          </>
        );
        const tone = 'flex items-start gap-1.5 text-left text-[12px] leading-5 text-ink-faint';
        return note.action && onOpenProcess !== undefined ? (
          <button
            key={note.id}
            type="button"
            data-message-delivery-note={note.id}
            onClick={onOpenProcess}
            className={`${tone} -ml-1 min-h-7 rounded-md px-1 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent`}
          >
            {body}
          </button>
        ) : (
          <p key={note.id} data-message-delivery-note={note.id} className={tone}>
            {body}
          </p>
        );
      })}
    </div>
  );
}

/** Attachments this conversation did not receive, according to its own channel. */
export function withheldKinds(block: MessageBlock): ReadonlySet<string> {
  const internal: MessageChannelDelivery | undefined = block.channels?.find((channel) => channel.channelId === 'internal');
  return new Set(internal?.status === 'delivered' ? internal.unsupported ?? [] : []);
}

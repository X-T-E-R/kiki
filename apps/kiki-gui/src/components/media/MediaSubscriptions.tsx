/**
 * Subscribed discovery sources — where new media providers are looked for.
 *
 * This is a different question from "which providers are installed", so it
 * gets its own folded section rather than its own page: the reader comes here
 * to add a place to look, and the providers that place has already produced
 * are above, in the list. Both are needed; merging them would mean a catalog
 * subscription with nothing installed yet looked like a broken provider.
 *
 * The consequences are stated where the action is, not in a dialog:
 *
 *  - Adding reads metadata only. It does not install anything, enable
 *    anything, or run a script from the new address. Installing a provider
 *    from it goes through the ordinary plugin install preview, which is where
 *    source consent already lives.
 *  - Removing takes away a place to look. It does not uninstall a provider
 *    that came from there, does not delete a stored key, and does not touch
 *    anything already generated. A reader who removes a subscription is asking
 *    "stop suggesting more from here", and the copy says exactly that.
 *
 * The roster is the host's (`pluginMediaService.sources` /
 * `setSources`); nothing here is kept in local storage, because a list that
 * only this machine remembers is a list the next window disagrees with.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { withSubscription, type MediaSource } from '../../lib/mediaSources';
import { FeedbackLine, type Feedback } from '../controls';
import { Icon } from '../icons';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../ui';
import { Disclosure, EmptyNote, QUIET_BUTTON } from '../capabilities/primitives';

export function MediaSubscriptions({
  sources,
  loading,
  onChange,
}: {
  readonly sources: readonly MediaSource[];
  readonly loading?: boolean;
  /** Persist the next roster; the caller re-reads what the host stored. */
  readonly onChange: (next: readonly MediaSource[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const add = async () => {
    if (id.trim() === '' || url.trim() === '') return;
    setBusy(true);
    setFeedback(null);
    try {
      await onChange(withSubscription(sources, { id: id.trim(), url: url.trim(), enabled: true }));
      setId('');
      setUrl('');
      setAdding(false);
      setFeedback({ tone: 'success', text: t('cap.media.subscriptions.added', { id: id.trim() }) });
    } catch (failure) {
      setFeedback({ tone: 'error', text: errorText(locale, failure) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: MediaSource) => {
    setBusy(true);
    setFeedback(null);
    try {
      await onChange(withSubscription(sources, target, true));
      setFeedback({ tone: 'info', text: t('cap.media.subscriptions.removed', { id: target.id }) });
    } catch (failure) {
      setFeedback({ tone: 'error', text: errorText(locale, failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-hairline pt-4" data-media-subscriptions={sources.length}>
      <Disclosure
        label={t('cap.media.subscriptions.title')}
        open={adding || sources.length > 0}
        onToggle={() => { setAdding((value) => !value); }}
        dataAttrs={{ 'data-media-subscriptions-toggle': '' }}
      >
        <div className="min-w-0 space-y-3">
          {loading ? (
            <p className="text-[12px] text-ink-faint" role="status">{t('cap.loading')}</p>
          ) : sources.length === 0 ? (
            <EmptyNote title={t('cap.media.subscriptions.none')} body={t('cap.media.subscriptions.noneBody')} />
          ) : (
            <ul className="min-w-0 space-y-0.5">
              {sources.map((source) => (
                <li key={source.id} className="flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-2 py-1 hover:bg-ink/[0.04]" data-media-subscription={source.id}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{source.id}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-faint">{source.url}</span>
                  </span>
                  {!source.enabled ? <span className="shrink-0 text-[11px] text-ink-faint">{t('cap.media.subscriptions.paused')}</span> : null}
                  <button
                    type="button"
                    disabled={busy}
                    data-media-subscription-remove={source.id}
                    onClick={() => { void remove(source); }}
                    className={DANGER_GHOST_BUTTON}
                  >
                    {t('cap.media.subscriptions.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <form
              noValidate
              className="max-w-lg space-y-2"
              data-media-subscription-form
              onSubmit={(event) => { event.preventDefault(); void add(); }}
            >
              <div className="grid gap-2 min-[560px]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <label className="block space-y-1">
                  <span className="block text-[12px] font-medium text-ink">{t('cap.media.subscriptions.name')}</span>
                  <input
                    className={`${INPUT} font-mono`}
                    value={id}
                    data-media-subscription-id
                    required
                    aria-required
                    onChange={(event) => { setId(event.target.value); }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="block text-[12px] font-medium text-ink">{t('cap.media.subscriptions.url')}</span>
                  <input
                    className={`${INPUT} font-mono`}
                    value={url}
                    data-media-subscription-url
                    required
                    aria-required
                    placeholder="https://"
                    onChange={(event) => { setUrl(event.target.value); }}
                  />
                </label>
              </div>
              <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('cap.media.subscriptions.addHint')}</p>
              <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('cap.media.subscriptions.removeHint')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className={SECONDARY_BUTTON} disabled={busy || id.trim() === '' || url.trim() === ''} data-media-subscription-add>
                  <Icon name="plus" size={14} />
                  {t('cap.media.subscriptions.add')}
                </button>
                <button type="button" className={QUIET_BUTTON} disabled={busy} onClick={() => { setAdding(false); }}>{t('common.cancel')}</button>
              </div>
            </form>
          ) : (
            <button type="button" className={`${QUIET_BUTTON} -ml-3`} data-media-subscriptions-add onClick={() => { setAdding(true); }}>
              <Icon name="plus" size={14} className="text-ink-faint" />
              {t('cap.media.subscriptions.add')}
            </button>
          )}
          <FeedbackLine feedback={feedback} />
        </div>
      </Disclosure>
    </div>
  );
}

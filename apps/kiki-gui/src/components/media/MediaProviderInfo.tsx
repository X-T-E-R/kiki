/**
 * What a provider can do, and what voices it has — asked on demand.
 *
 * Both lists are the reason this file exists rather than a section in the
 * detail. A capability query can cost a paid provider money if it reaches the
 * network, and a provider's voice list runs to thousands of entries. So:
 *
 *  - Nothing fires on page open. The reader presses a button.
 *  - Capabilities are shown for one provider at a time, and the model list is
 *    bounded by whatever page the provider returned; there is no "load all".
 *  - Voices are filtered by a language the reader types, and the page is
 *    explicit — a provider with a thousand voices is paged, not truncated
 *    silently.
 *
 * The distinction that matters for copy: a provider that has *not* been asked
 * is not a provider that has nothing. The closed state says "not asked yet",
 * never "no models".
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { mediaApi, mediaKeys, type MediaKind } from '../../lib/mediaSources';
import { useConnection } from '../../state/connection';
import { FeedbackLine } from '../controls';
import { Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { Tag } from '../capabilities/primitives';
import { MediaKindGlyph } from './MediaKindGlyph';

/**
 * What one capability query came back with, normalized to the things this
 * section draws.
 *
 * The contract answers either a capability page or `{ providers }` — the
 * roster, which is how an unknown or unconfigured provider says "here is who
 * you could use" instead of failing. Both arms carry an index signature, so
 * TypeScript cannot narrow the union on a property; the arm is therefore
 * chosen on the one field only a page defines, and every field is read
 * defensively. A wrong-shaped answer renders as zero rows rather than throwing
 * inside a panel.
 */
interface CapabilityAnswer {
  readonly models: readonly { readonly id: string; readonly kind: MediaKind; readonly label?: string }[];
  readonly constraints: readonly string[];
  /** Providers offered instead of a page; 0 when a real page came back. */
  readonly rosterSize: number;
  readonly skillRefs: readonly { readonly name: string }[];
  readonly hasMore: boolean;
}

function normalizeCapabilities(answer: unknown): CapabilityAnswer {
  const record = (typeof answer === 'object' && answer !== null ? answer : {}) as {
    readonly models?: unknown;
    readonly constraints?: unknown;
    readonly providers?: unknown;
    readonly skill_refs?: unknown;
    readonly cursor?: unknown;
  };
  const isPage = Array.isArray(record.models);
  return {
    models: isPage
      ? (record.models as readonly { id?: unknown; kind?: unknown; label?: unknown }[]).flatMap((model) =>
        typeof model.id === 'string'
          ? [{
            id: model.id,
            kind: typeof model.kind === 'string' ? model.kind as MediaKind : 'image',
            ...(typeof model.label === 'string' ? { label: model.label } : {}),
          }]
          : [])
      : [],
    constraints: Array.isArray(record.constraints) ? record.constraints.filter((item): item is string => typeof item === 'string') : [],
    rosterSize: !isPage && Array.isArray(record.providers) ? record.providers.length : 0,
    skillRefs: Array.isArray(record.skill_refs)
      ? (record.skill_refs as readonly { name?: unknown }[]).flatMap((ref) => (typeof ref.name === 'string' ? [{ name: ref.name }] : []))
      : [],
    hasMore: record.cursor !== null && record.cursor !== undefined,
  };
}

/** One provider's models, constraints and skills, on demand. */
export function MediaCapabilityList({ provider, kinds }: { readonly provider: string; readonly kinds: readonly MediaKind[] }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<MediaKind>(kinds[0] ?? 'image');
  const [asked, setAsked] = useState(false);

  const query = useQuery({
    queryKey: mediaKeys.capabilities(provider, '', kind),
    queryFn: async (): Promise<CapabilityAnswer> => {
      const api = mediaApi(client);
      if (api === undefined) throw new Error('media domain unavailable');
      return normalizeCapabilities(await api.capabilities({ provider, kind }));
    },
    enabled: asked,
    retry: false,
  });

  return (
    <section data-media-capabilities={provider} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium text-ink">{t('cap.media.detail.capabilities')}</h2>
        {kinds.length > 1 ? (
          <span className="flex items-center gap-0.5 rounded-[9px] bg-ink/[0.04] p-0.5" data-media-capability-kinds>
            {kinds.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                data-media-capability-kind={value}
                onClick={() => { setKind(value); setAsked(false); }}
                className={`inline-flex min-h-7 items-center gap-1 rounded-[7px] px-2.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                  kind === value ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
                }`}
              >
                <MediaKindGlyph kind={value} className="h-3.5 w-3.5" />
                {t(`cap.media.kind.${value}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </span>
        ) : null}
        <span className="flex-1" />
        {!asked || query.isError ? (
          <button type="button" className={`${SECONDARY_BUTTON} h-8`} data-media-capabilities-ask={provider} onClick={() => { setAsked(true); }}>
            {t('cap.media.detail.loadCapabilities')}
          </button>
        ) : null}
      </div>

      {!asked ? (
        <p className="mt-1 text-[12px] text-ink-faint" data-media-capabilities-idle>{t('cap.media.detail.capabilitiesIdle')}</p>
      ) : query.isPending ? (
        <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} size={12} />{t('cap.loading')}</p>
      ) : query.isError ? (
        <div className="mt-1 space-y-1">
          <FeedbackLine feedback={{ tone: 'error', text: t('cap.media.detail.capabilitiesFailed', { detail: errorText(locale, query.error) }) }} />

        </div>
      ) : query.data !== undefined ? (
        <div className="mt-2" data-media-capabilities-loaded>
          {query.data.rosterSize > 0 ? (
            <p className="text-[12px] text-ink-soft" data-media-capabilities-roster>
              {t('cap.media.detail.noModelsYet', { count: query.data.rosterSize })}
            </p>
          ) : query.data.models.length === 0 ? (
            <p className="text-[12px] text-ink-faint">{t('cap.media.detail.noModels')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-media-models={query.data.models.length}>
              {query.data.models.map((model) => (
                <li key={model.id}>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel px-2.5 py-1 text-[12px] text-ink">
                    <MediaKindGlyph kind={model.kind} className="h-3.5 w-3.5 text-ink-faint" />
                    {model.label ?? model.id}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {query.data.constraints.length > 0 ? (
            <ul className="mt-2 space-y-0.5" data-media-constraints={query.data.constraints.length}>
              {query.data.constraints.map((constraint) => (
                <li key={constraint} className="text-[12px] leading-4 text-ink-soft">· {constraint}</li>
              ))}
            </ul>
          ) : null}
          {query.data.skillRefs.length > 0 ? (
            <p className="mt-2 text-[11px] leading-4 text-ink-faint" data-media-skill-refs>
              {query.data.skillRefs.map((ref) => ref.name).join(' · ')}
            </p>
          ) : null}
          {query.data.hasMore ? (
            <p className="mt-2 text-[11px] text-ink-faint">{t('cap.media.detail.moreModels')}</p>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}

/**
 * One provider's voices, filtered by a language the reader types.
 *
 * Paged, never preloaded: a speech provider can have thousands. The language
 * box is a filter the reader drives, not a required field — some providers
 * ignore it, and forcing it would hide the voices that have no language tag.
 */
export function MediaVoicePicker({ provider }: { readonly provider: string }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [language, setLanguage] = useState('');
  const [asked, setAsked] = useState(false);
  const query = useQuery({
    queryKey: mediaKeys.voices(provider, '', language),
    queryFn: async () => {
      const api = mediaApi(client);
      if (api === undefined) throw new Error('media domain unavailable');
      return api.voices({ provider, ...(language.trim() !== '' ? { language: language.trim() } : {}) });
    },
    enabled: asked,
    retry: false,
  });

  return (
    <section data-media-voices={provider} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium text-ink">{t('cap.media.detail.voices')}</h2>
        <label className="sr-only" htmlFor={`media-voice-language-${provider}`}>{t('cap.media.detail.voiceLanguage')}</label>
        <input
          id={`media-voice-language-${provider}`}
          className="h-8 w-32 rounded-md bg-ink/[0.04] px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus-within:ring-hairline-strong"
          placeholder={t('cap.media.detail.voiceLanguage')}
          value={language}
          data-media-voice-language
          onChange={(event) => { setLanguage(event.target.value); }}
        />
        <span className="flex-1" />
        <button type="button" className={`${SECONDARY_BUTTON} h-8`} data-media-voices-ask={provider} onClick={() => { setAsked(true); }}>
          {t('cap.media.detail.loadVoices')}
        </button>
      </div>

      {!asked ? (
        <p className="mt-1 text-[12px] text-ink-faint" data-media-voices-idle>{t('cap.media.detail.voicesIdle')}</p>
      ) : query.isPending ? (
        <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} size={12} />{t('cap.loading')}</p>
      ) : query.isError ? (
        <FeedbackLine feedback={{ tone: 'error', text: t('cap.media.detail.voicesFailed', { detail: errorText(locale, query.error) }) }} />
      ) : query.data !== undefined ? (
        <div className="mt-2" data-media-voices-loaded={query.data.voices.length}>
          {query.data.voices.length === 0 ? (
            <p className="text-[12px] text-ink-faint">{t('cap.media.detail.noVoices')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {query.data.voices.map((voice) => (
                <li key={voice.id}>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel px-2.5 py-1 text-[12px] text-ink">
                    {voice.label ?? voice.id}
                    {voice.languages !== undefined && voice.languages.length > 0 ? (
                      <Tag>{voice.languages.slice(0, 3).join(', ')}</Tag>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {query.data.cursor !== null && query.data.cursor !== undefined ? <p className="mt-2 text-[11px] text-ink-faint">{t('cap.media.detail.moreVoices')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

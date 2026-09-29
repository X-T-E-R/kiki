import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  EXPERIMENTAL_FLAG_HOMES,
  experimentalCardId,
  experimentalFlagHome,
  experimentalFlagRows,
  experimentalSectionForFlag,
  markRestartRequired,
  type ExperimentalFlagEffect,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Hint, InlineError, SavedTick } from '../controls';
import { mergeConfigEcho } from './configEcho';
import { SectionCard } from './SectionCard';
import { SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

type Choice = 'default' | 'on' | 'off';

const EFFECT_KEY = {
  now: 'st.exp.effect.now',
  newSessions: 'st.exp.effect.newSessions',
  restart: 'st.exp.effect.restart',
} as const satisfies Record<ExperimentalFlagEffect, string>;

/** Server-reported flags plus saved overrides, restricted to one page's rows. */
export function useExperimentalFlags() {
  const { client } = useConnection();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  const rows = experimentalFlagRows(metaQuery.data ?? {}, configQuery.data ?? {});
  return {
    rows,
    effective: metaQuery.data?.experimental_flags ?? {},
    loading: configQuery.isLoading || metaQuery.isLoading,
    error: configQuery.error ?? metaQuery.error,
    ready: configQuery.data !== undefined && metaQuery.data !== undefined,
  };
}

/** One flag: the small tag, what it does, when it takes effect, and a three-way choice. */
function ExperimentalRow({ id, override, effective }: { id: string; override: boolean | undefined; effective: boolean | undefined }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, ping] = useSavedTick();
  const [pending, setPending] = useState<Choice | null>(null);
  const home = experimentalFlagHome(id);
  const name = t(home?.labelKey ?? 'st.exp.unknown.name');
  const saved_choice: Choice = override === undefined ? 'default' : override ? 'on' : 'off';
  const choice = pending ?? saved_choice;
  // The server's answer wins over the saved override (per-feature env vars
  // outrank config); say so instead of letting the switch look broken.
  const envOverride = pending === null && override !== undefined && effective !== undefined && effective !== override;

  const apply = async (next: Choice) => {
    setPending(next);
    setSaving(true);
    setError(null);
    try {
      const latest = await client.getConfig();
      const experimental = { ...(latest.experimental ?? {}) };
      if (next === 'default') delete experimental[id];
      else experimental[id] = next === 'on';
      const echoed = await client.patchConfig({ experimental, replace_domains: ['experimental'] });
      queryClient.setQueryData<KikiConfigResponse>(['config'], mergeConfigEcho(latest, echoed));
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      if (home?.effect === 'restart' && next === 'on') markRestartRequired([id]);
      ping();
    } catch (cause) {
      setError(errorText(locale, cause));
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  const labelId = `experimental-flag-${id}-label`;
  return (
    <div data-experimental-row={id} className="grid gap-x-6 gap-y-2 border-t border-hairline py-3 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span id={labelId} className="text-[13px] text-ink">{name}</span>
          <span data-experimental-tag className="rounded-[4px] bg-ink/[0.05] px-1.5 py-px text-[11px] font-medium leading-4 text-ink-soft">
            {t('st.exp.tag')}
          </span>
        </p>
        <Hint>
          {t(home?.descriptionKey ?? 'st.exp.unknown.desc')}{' '}
          <span data-experimental-effect={home?.effect ?? 'now'}>{t(EFFECT_KEY[home?.effect ?? 'now'])}</span>
        </Hint>
        <p className="text-[12px] leading-snug text-ink-faint">
          <span data-flag-effective={String(effective)}>
            {t(effective === undefined ? 'st.exp.state.unknown' : effective ? 'st.exp.state.on' : 'st.exp.state.off')}
          </span>
          <span aria-hidden className="px-1.5">·</span>
          <span className="font-mono text-[11px]">{t('st.exp.flagId', { id })}</span>
        </p>
        {envOverride ? <p className="text-[12px] leading-snug text-amber-ink" data-experimental-env>{t('st.exp.envOverride')}</p> : null}
        {error !== null ? <p role="alert" className="text-[12px] leading-snug text-danger">{error}</p> : null}
      </div>
      <div className="flex items-center gap-2 sm:justify-end" id={`experimental-flag-${id}`}>
        <SavedTick show={saved} />
        <SettingsSegmented<Choice>
          ariaLabel={t('st.exp.choiceLabel', { feature: name })}
          value={choice}
          disabled={saving}
          dataAttr="data-experimental-choice"
          onChange={(next) => void apply(next)}
          choices={[
            // Default follows the server; while nothing is saved, the current
            // state is what Default resolves to, so the pair never reads as a conflict.
            { value: 'default', label: override === undefined && effective !== undefined
              ? t(effective ? 'st.exp.choice.defaultOn' : 'st.exp.choice.defaultOff')
              : t('st.exp.choice.default') },
            { value: 'on', label: t('st.exp.choice.on') },
            { value: 'off', label: t('st.exp.choice.off') },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * The Experimental block at the end of a feature page: every flag whose home
 * is this page, each saved the moment it changes. Renders nothing when the
 * server reports none of them, so a page never carries an empty heading.
 * Flags a feature card already switches (session titles) are skipped.
 */
export function ExperimentalRows({ section }: { section: string }) {
  const { t } = useI18n();
  const { rows, effective, loading, error } = useExperimentalFlags();
  const mine = rows.filter((row) => experimentalSectionForFlag(row.id) === section
    && experimentalFlagHome(row.id)?.cardId === undefined);
  if (error !== null && error !== undefined) {
    return <SectionCard id={experimentalCardId(section)} title={t('st.exp.rowsTitle')}><InlineError error={error} /></SectionCard>;
  }
  if (loading || mine.length === 0) return null;
  // Known flags in registry order first, then server-specific extras by id.
  const order = (id: string) => {
    const index = EXPERIMENTAL_FLAG_HOMES.findIndex((home) => home.id === id);
    return index === -1 ? EXPERIMENTAL_FLAG_HOMES.length : index;
  };
  const sorted = mine.toSorted((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
  return (
    <SectionCard id={experimentalCardId(section)} title={t('st.exp.rowsTitle')}>
      <div data-experimental-rows={section}>
        {sorted.map((row) => (
          <ExperimentalRow key={row.id} id={row.id} override={row.override} effective={effective[row.id]} />
        ))}
      </div>
    </SectionCard>
  );
}

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
import { InlineError, SavedTick } from '../controls';
import { mergeConfigEcho } from './configEcho';
import { SectionCard } from './SectionCard';
import { SettingField, SettingsBox } from './fields';
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
      const experimental = { ...latest.experimental };
      if (next === 'default') delete experimental[id];
      else experimental[id] = next === 'on';
      const echoed = await client.patchConfig({ experimental, replace_domains: ['experimental'] });
      queryClient.setQueryData<KikiConfigResponse>(['config'], mergeConfigEcho(latest, echoed));
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      const resolved = queryClient.getQueryData<Awaited<ReturnType<typeof client.meta>>>(['meta']);
      if (home?.effect === 'restart' && (next === 'on' || (next === 'default' && resolved?.experimental_flags?.[id] === true))) markRestartRequired([id]);
      ping();
    } catch (cause) {
      setError(errorText(locale, cause));
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  // One box row per flag: name + tag on the left, the three-way choice on the
  // right. The raw flag id is for logs, so it rides the row's `title`, not the
  // visible line.
  return (
    <SettingField
      label={name}
      labelId={`experimental-flag-${id}-label`}
      help={
        <>
          {t(home?.descriptionKey ?? 'st.exp.unknown.desc')}{' '}
          {/* The segmented's default option already resolves the current
              state (默认（关闭）), so the help does not repeat it. */}
          <span data-experimental-effect={home?.effect ?? 'now'}>{t(EFFECT_KEY[home?.effect ?? 'now'])}</span>
        </>
      }
    >
      <span className="flex shrink-0 flex-wrap items-center gap-2" title={t('st.exp.flagId', { id })}>
        <span data-experimental-tag className="rounded-[4px] bg-ink/[0.05] px-1.5 py-px text-[11px] font-medium leading-4 text-ink-soft">
          {t('st.exp.tag')}
        </span>
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
        {envOverride ? <span className="basis-full text-right text-[12px] leading-snug text-amber-ink" data-experimental-env>{t('st.exp.envOverride')}</span> : null}
        {error !== null ? <span role="alert" className="basis-full text-right text-[12px] leading-snug text-danger">{error}</span> : null}
      </span>
    </SettingField>
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
      <SettingsBox data-experimental-rows={section}>
        {sorted.map((row) => (
          <div key={row.id} data-experimental-row={row.id}>
            <ExperimentalRow id={row.id} override={row.override} effective={effective[row.id]} />
          </div>
        ))}
      </SettingsBox>
    </SectionCard>
  );
}

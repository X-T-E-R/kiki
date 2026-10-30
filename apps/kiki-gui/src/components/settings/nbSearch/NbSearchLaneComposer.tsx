/**
 * The lane / preset model, for the user who composes search methods instead of
 * just configuring a service. Lives inside the search tab's advanced
 * disclosure: the everyday answer is the service list above; this list answers
 * "which method runs, what it costs, and what I combined".
 *
 * Click model (settings-wide rule): a row click opens the editor; becoming the
 * default is an explicit 设为默认 button, and the default row carries a tag.
 */

import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import {
  nbSearchExecutionKind,
  resolveEffectiveDefaultLane,
  setNbSearchLane,
  setNbSearchPreset,
  type NbSearchDraft,
} from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { Hint } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { NbSearchLaneEditor } from './NbSearchLaneEditor';
import { NbSearchPresetEditor } from './NbSearchPresetEditor';
import { NbSearchInstanceEditor } from './NbSearchInstanceEditor';
import {
  nbSearchInstanceProviderId,
  nbSearchLaneIdentity,
  nbSearchPresetIdentity,
  nbSearchProviderLabel,
  nbSearchSourceBadgeKey,
  nbSearchUsageWord,
  type NbSearchAdvancedBinding,
} from './advancedSupport';
import { makeDefaultLane } from './serviceCards';

function firstUnusedLane(capabilities: NbSearchCapabilities, draft: NbSearchDraft): string {
  return capabilities.search.lanes.find((lane) => draft.advanced?.lanes[lane.id] === undefined)?.id
    ?? capabilities.search.lanes[0]?.id
    ?? '';
}

export function NbSearchLaneComposer({
  binding,
  saving = false,
}: {
  binding: NbSearchAdvancedBinding;
  saving?: boolean;
}) {
  const { t, tp } = useI18n();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const capabilities = binding.capabilities;
  const draft = binding.draft;

  const effective = useMemo(
    () => resolveEffectiveDefaultLane(capabilities, draft.defaultSearchLane),
    [capabilities, draft.defaultSearchLane],
  );
  const defaultLaneId = draft.defaultSearchLane === '' ? effective.laneId : draft.defaultSearchLane;
  const inheritedDefault = draft.defaultSearchLane === '';

  const laneRows = useMemo(() => {
    const byId = new Map<string, { id: string }>(
      capabilities.search.lanes.map((lane) => [lane.id, { id: lane.id }]),
    );
    for (const [id, lane] of Object.entries(draft.advanced?.lanes ?? {})) {
      if (lane === null || byId.has(id)) continue;
      byId.set(id, { id });
    }
    return [...byId.values()];
  }, [capabilities.search.lanes, draft]);

  const presetRows = useMemo(() => {
    const byName = new Map<string, { id: string; lanes: readonly string[] }>();
    for (const preset of capabilities.search.presets) {
      byName.set(preset.name, { id: preset.name, lanes: preset.lanes });
    }
    for (const [name, preset] of Object.entries(draft.advanced?.presets ?? {})) {
      if (preset === null) continue;
      byName.set(name, { id: name, lanes: preset.lanes });
    }
    return [...byName.values()];
  }, [capabilities.search.presets, draft]);

  const addLane = () => {
    const base = 'custom.search';
    let id = base;
    for (let suffix = 2; draft.advanced?.lanes[id] !== undefined; suffix += 1) id = `${base}-${suffix}`;
    const lane = firstUnusedLane(capabilities, draft);
    const identity = nbSearchLaneIdentity(capabilities, draft, lane);
    binding.onChange(setNbSearchLane(draft, id, identity.profile ?? {
      provider_instance_id: '',
      operation_id: '',
      latency: 'medium',
      cost: 'cheap',
    }));
    setOpenRow(`lane:${id}`);
  };

  const [instanceDraftOpen, setInstanceDraftOpen] = useState(false);

  const addPreset = () => {
    const base = 'preset';
    let id = base;
    for (let suffix = 2; draft.advanced?.presets[id] !== undefined; suffix += 1) id = `${base}-${suffix}`;
    const lane = capabilities.search.lanes.find((candidate) => candidate.output.channel === 'results')?.id;
    if (lane === undefined) return;
    binding.onChange(setNbSearchPreset(draft, id, { lanes: [lane] }));
    setOpenRow(`preset:${id}`);
  };

  return (
    <div className="space-y-4" data-nb-search-composer>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.composer.methodsTitle')}</p>
          <span className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
              disabled={saving}
              data-nb-search-lane-add
              onClick={() => {
                setInstanceDraftOpen(false);
                addLane();
              }}
            >
              <Icon name="plus" size={12} />
              {t('st.nbSearch.custom.lane.add')}
            </button>
            <button
              type="button"
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
              disabled={saving}
              aria-expanded={instanceDraftOpen}
              data-nb-search-new-instance
              onClick={() => {
                setInstanceDraftOpen((open) => !open);
              }}
            >
              <Icon name={instanceDraftOpen ? 'close' : 'plus'} size={12} />
              {instanceDraftOpen ? t('st.nbSearch.custom.close') : t('st.nbSearch.custom.instance.add')}
            </button>
          </span>
        </div>

        {instanceDraftOpen ? (
          <NbSearchInstanceEditor
            capabilities={capabilities}
            draft={draft}
            saving={saving}
            onCancel={() => {
              setInstanceDraftOpen(false);
            }}
            onCreated={(next) => {
              binding.onChange(next);
              setInstanceDraftOpen(false);
            }}
          />
        ) : null}

        <ul className="space-y-0" data-nb-search-lane-rows>
          {laneRows.map((row) => {
            const lane = capabilities.search.lanes.find((candidate) => candidate.id === row.id);
            const identity = nbSearchLaneIdentity(capabilities, draft, row.id);
            const expanded = openRow === `lane:${row.id}`;
            const execution = lane === undefined ? 'none' : nbSearchExecutionKind(lane.execution_modes);
            const usable = lane !== undefined && lane.availability === 'ready' && execution === 'sync';
            const isDefault = defaultLaneId === row.id;
            const title = identity.profile === undefined
              ? row.id
              : `${nbSearchProviderLabel(t, nbSearchInstanceProviderId(capabilities, draft, identity.profile.provider_instance_id) ?? identity.profile.provider_instance_id)} · ${identity.profile.operation_id}`;
            return (
              <li key={row.id} data-nb-search-lane-row={row.id} data-nb-search-lane-origin={identity.source}>
                <div className="flex items-start gap-1 py-2 pl-1 pr-1">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    data-nb-search-lane-edit={row.id}
                    onClick={() => {
                      setOpenRow(expanded ? null : `lane:${row.id}`);
                    }}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="min-w-0 break-words text-[13px] text-ink">{title}</span>
                        <span className={`shrink-0 text-[12px] ${usable ? 'text-ink-soft' : 'text-ink-faint'}`}>
                          {lane === undefined
                            ? t('st.nbSearch.custom.lane.pending')
                            : t(nbSearchUsageWord(lane.availability, execution))}
                        </span>
                        {isDefault ? (
                          <span className="shrink-0 rounded-full bg-panel px-1.5 py-px text-[11px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]" data-nb-search-lane-default>
                            {inheritedDefault ? t('st.nbSearch.services.inheritBadge') : t('st.nbSearch.services.defaultBadge')}
                          </span>
                        ) : null}
                        <span className="text-[11px] text-ink-faint" data-nb-search-lane-source-badge={identity.source}>
                          {t(nbSearchSourceBadgeKey(identity.source))}
                        </span>
                        {identity.source === 'override' ? (
                          <span className="text-[11px] text-ink-soft" data-nb-search-lane-overridden>
                            {t('st.nbSearch.custom.lane.badgeOverridden')}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <Icon name="chevron" size={12} className={`mt-1 shrink-0 text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
                  </button>
                  {!isDefault ? (
                    <button
                      type="button"
                      className={`${SECONDARY_BUTTON} mt-0.5 shrink-0 px-2 py-0.5 text-[11px]`}
                      disabled={saving}
                      data-nb-search-lane-make-default={row.id}
                      onClick={() => {
                        binding.onChange(makeDefaultLane(draft, row.id));
                      }}
                    >
                      {t('st.nbSearch.services.makeDefault')}
                    </button>
                  ) : null}
                </div>
                {expanded ? (
                  <div className="pb-3 pl-4 pr-2">
                    <NbSearchLaneEditor
                      binding={binding}
                      laneId={row.id}
                      saving={saving}
                      onRename={(next) => {
                        setOpenRow(`lane:${next}`);
                      }}
                      onClose={() => {
                        setOpenRow(null);
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2" data-nb-search-presets>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">{t('st.nbSearch.custom.preset.group')}</p>
            <Hint>{t('st.nbSearch.custom.preset.groupHint')}</Hint>
          </div>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} shrink-0 inline-flex items-center gap-1`}
            disabled={saving}
            data-nb-search-preset-add
            onClick={addPreset}
          >
            <Icon name="plus" size={12} />
            {t('st.nbSearch.custom.preset.add')}
          </button>
        </div>

        {presetRows.length === 0 ? (
          <p className="text-[12px] text-ink-faint">{t('st.nbSearch.custom.preset.empty')}</p>
        ) : (
          <ul className="space-y-0" data-nb-search-preset-rows>
            {presetRows.map((preset) => {
              const expanded = openRow === `preset:${preset.id}`;
              const source = nbSearchPresetIdentity(capabilities, draft, preset.id).source;
              return (
                <li key={preset.id} data-nb-search-preset-row={preset.id} data-nb-search-preset-origin={source}>
                  <div className="flex items-start gap-1 py-2 pl-1 pr-1">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                      aria-expanded={expanded}
                      data-nb-search-preset-open={preset.id}
                      onClick={() => {
                        setOpenRow(expanded ? null : `preset:${preset.id}`);
                      }}
                    >
                      <span className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="min-w-0 break-words text-[13px] text-ink">{preset.id}</span>
                        <span className="shrink-0 text-[12px] text-ink-faint" data-nb-search-preset-source-badge={source}>
                          {t(nbSearchSourceBadgeKey(source))}
                        </span>
                      </span>
                      <span className="block max-w-full truncate font-mono text-[11px] text-ink-faint">
                        {preset.lanes.join(' → ')}
                      </span>
                    </button>
                    <span className="shrink-0 pt-0.5 text-[12px] text-ink-faint">
                      {tp('st.nbSearch.custom.preset.laneCount', preset.lanes.length)}
                    </span>
                  </div>
                  {expanded ? (
                    <div className="pb-3 pl-4 pr-2">
                      <NbSearchPresetEditor
                        binding={binding}
                        presetId={preset.id}
                        saving={saving}
                        onRename={(next) => {
                          setOpenRow(`preset:${next}`);
                        }}
                        onClose={() => {
                          setOpenRow(null);
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

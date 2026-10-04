/**
 * Inline editor for one preset: a named, ordered list of search methods.
 *
 * A preset the layer below Kiki provides is read-only until a local override is
 * built, and "Restore source version" removes that override again. A preset that
 * exists only in Kiki's config can be renamed and deleted. Only lanes whose
 * output channel is `results` are offered, because a preset is a search strategy
 * and the engine rejects anything else.
 */

import { useMemo, useState } from 'react';
import { setNbSearchPreset, validateNbSearchReferences } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSelect } from '../SettingsPrimitives';
import {
  nbSearchIssueText,
  nbSearchItemActions,
  nbSearchLaneIdentity,
  nbSearchPresetIdentity,
  nbSearchProviderLabel,
  nbSearchResultsLaneIds,
  nbSearchInstanceProviderId,
  type NbSearchAdvancedBinding,
} from './advancedSupport';

export function NbSearchPresetEditor({
  binding,
  presetId,
  saving = false,
  onRename,
  onClose,
}: {
  binding: NbSearchAdvancedBinding;
  presetId: string;
  saving?: boolean;
  onRename?: (nextPresetId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const capabilities = binding.capabilities;
  const own = binding.draft.advanced?.presets[presetId] ?? undefined;
  const engine = capabilities.search.presets.find((preset) => preset.name === presetId);
  const source = nbSearchPresetIdentity(capabilities, binding.draft, presetId).source;
  const actions = nbSearchItemActions(source);
  const editable = source !== 'source';
  const lanes = own?.lanes ?? engine?.lanes ?? [];

  const laneChoices = useMemo(
    () => nbSearchResultsLaneIds(capabilities).map((id) => {
      const identity = nbSearchLaneIdentity(capabilities, binding.draft, id);
      const providerId = identity.profile === undefined
        ? undefined
        : nbSearchInstanceProviderId(capabilities, binding.draft, identity.profile.provider_instance_id);
      return {
        value: id,
        label: identity.profile === undefined
          ? id
          : `${nbSearchProviderLabel(t, providerId ?? id)} · ${identity.profile.operation_id}`,
        hint: id,
      };
    }),
    [capabilities, binding.draft, t],
  );

  const issues = useMemo(
    () => validateNbSearchReferences(binding.config, binding.draft, capabilities)
      .filter((issue) => issue.path === `presets.${presetId}`),
    [binding.config, binding.draft, capabilities, presetId],
  );

  const [nameText, setNameText] = useState(presetId);
  const [nameIssue, setNameIssue] = useState<string | null>(null);

  const write = (nextLanes: readonly string[]) => {
    binding.onChange(setNbSearchPreset(binding.draft, presetId, { lanes: [...nextLanes] }));
  };

  const override = () => {
    if (engine === undefined) return;
    binding.onChange(setNbSearchPreset(binding.draft, presetId, { lanes: [...engine.lanes] }));
  };

  const restore = () => {
    binding.onChange(setNbSearchPreset(binding.draft, presetId, undefined));
  };

  const remove = () => {
    binding.onChange(setNbSearchPreset(binding.draft, presetId, undefined));
    onClose();
  };

  const rename = () => {
    const next = nameText.trim();
    if (next === presetId) return;
    if (next === '' || next.length > 256) {
      setNameIssue(t('st.nbSearch.custom.preset.idInvalid'));
      return;
    }
    if (
      binding.draft.advanced?.presets[next] !== undefined
      || capabilities.search.presets.some((preset) => preset.name === next)
    ) {
      setNameIssue(t('st.nbSearch.custom.preset.idTaken'));
      return;
    }
    setNameIssue(null);
    const removed = setNbSearchPreset(binding.draft, presetId, undefined);
    binding.onChange(setNbSearchPreset(removed, next, { lanes: [...lanes] }));
    onRename?.(next);
  };

  return (
    <div
      className="space-y-3 border-l-2 border-hairline pl-3"
      data-nb-search-preset-editor={presetId}
      data-nb-search-preset-source={source}
    >
      <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-preset-origin>
        {source === 'source'
          ? t('st.nbSearch.custom.preset.originSource')
          : source === 'override'
            ? t('st.nbSearch.custom.preset.originOverride')
            : source === 'localUnconfirmed'
              ? t('st.nbSearch.custom.preset.originLocalSetting')
              : source === 'unknown'
                ? t('st.nbSearch.custom.preset.originUnknown')
                : t('st.nbSearch.custom.preset.originLocal')}
      </p>

      {editable ? (
        <label className={FORM_LABEL}>
          {t('st.nbSearch.custom.preset.idLabel')}
          <input
            className={`${INPUT} mt-1 font-mono`}
            value={nameText}
            disabled={saving}
            /* Same reason as the method editor: renaming an override would give the
               source preset back and leave a plain local one behind. */
            readOnly={!actions.canRename}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('st.nbSearch.custom.preset.idLabel')}
            data-nb-search-preset-id
            onChange={(event) => {
              setNameText(event.target.value);
              if (nameIssue !== null) setNameIssue(null);
            }}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                rename();
              } else if (event.key === 'Escape') {
                setNameText(presetId);
                setNameIssue(null);
              }
            }}
          />
          <FieldIssue id={`${presetId}-name-issue`} text={nameIssue} />
          {nameIssue === null ? (
            <span className="mt-1 block font-normal text-[11px] leading-relaxed text-ink-faint">
              {t('st.nbSearch.custom.preset.idHint')}
            </span>
          ) : null}
        </label>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.custom.preset.lanes')}</p>
        <ol className="divide-y divide-hairline" data-nb-search-preset-lanes>
          {lanes.map((laneId, index) => (
            <li key={`${index}:${laneId}`} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="w-5 shrink-0 text-center font-mono text-[11px] text-ink-faint">{index + 1}</span>
              <div className="min-w-0 flex-1">
                {editable && !saving ? (
                  <SettingsSelect
                    variant="form"
                    mono
                    value={laneId}
                    choices={laneChoices.some((choice) => choice.value === laneId)
                      ? laneChoices
                      : [{ value: laneId, label: laneId }, ...laneChoices]}
                    ariaLabel={`${t('st.nbSearch.custom.preset.lanes')} ${index + 1}`}
                    dataAttr="data-nb-search-preset-lane"
                    onChange={(next) => {
                      const nextLanes = [...lanes];
                      nextLanes[index] = next;
                      write(nextLanes);
                    }}
                  />
                ) : (
                  <span className="block min-w-0 break-all font-mono text-[11px] text-ink">{laneId}</span>
                )}
              </div>
              {editable ? (
                <div className="flex shrink-0 items-center gap-1">
                  <MoveButton
                    label={t('st.nbSearch.custom.moveUp', { n: index + 1 })}
                    icon="arrowDown"
                    flip
                    disabled={saving || index === 0}
                    onClick={() => {
                      const next = [...lanes];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      write(next);
                    }}
                  />
                  <MoveButton
                    label={t('st.nbSearch.custom.moveDown', { n: index + 1 })}
                    icon="arrowDown"
                    disabled={saving || index === lanes.length - 1}
                    onClick={() => {
                      const next = [...lanes];
                      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                      write(next);
                    }}
                  />
                  <MoveButton
                    label={t('st.nbSearch.custom.removeRow', { n: index + 1 })}
                    icon="close"
                    tone="danger"
                    disabled={saving || lanes.length === 1}
                    onClick={() => {
                      write(lanes.filter((_, candidate) => candidate !== index));
                    }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {editable ? (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
            disabled={saving || laneChoices.every((choice) => lanes.includes(choice.value))}
            data-nb-search-preset-add-lane
            onClick={() => {
              const unused = laneChoices.find((choice) => !lanes.includes(choice.value));
              if (unused !== undefined) write([...lanes, unused.value]);
            }}
          >
            <Icon name="plus" size={12} />
            {t('st.nbSearch.custom.preset.addLane')}
          </button>
        ) : null}

        <p className="text-[12px] leading-snug text-ink-faint">
          {lanes.length === 1 ? t('st.nbSearch.custom.preset.minLane') : t('st.nbSearch.custom.preset.laneHint')}
        </p>
      </div>

      {issues.map((issue) => (
        <p key={`${issue.code}:${issue.target}`} role="alert" data-nb-search-preset-issue className="text-[12px] leading-4 text-danger">
          {nbSearchIssueText(t, issue)}
          <span className="ml-1 font-mono text-[11px] text-ink-faint">{issue.code} · {issue.path} · {issue.target}</span>
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {editable ? null : (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            data-nb-search-preset-override
            onClick={override}
          >
            {t('st.nbSearch.custom.preset.override')}
          </button>
        )}
        {/* Same rule as search methods: only an override has a source to go back to. */}
        {actions.canRestoreSource ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            data-nb-search-preset-restore
            onClick={restore}
          >
            {t('st.nbSearch.custom.preset.restore')}
          </button>
        ) : null}
        {actions.canRemoveLocal ? (
          <button
            type="button"
            className={DANGER_GHOST_BUTTON}
            disabled={saving}
            data-nb-search-preset-remove
            onClick={remove}
          >
            {t('st.nbSearch.custom.preset.remove')}
          </button>
        ) : null}
        <button type="button" className={`${SECONDARY_BUTTON} ml-auto`} onClick={onClose}>
          <span className="inline-flex items-center gap-1">
            <Icon name="collapse" size={12} />
            {t('st.nbSearch.custom.close')}
          </span>
        </button>
      </div>
    </div>
  );
}

function MoveButton({
  label,
  icon,
  onClick,
  disabled,
  flip = false,
  tone = 'plain',
}: {
  label: string;
  icon: 'arrowDown' | 'close';
  onClick: () => void;
  disabled: boolean;
  flip?: boolean;
  tone?: 'plain' | 'danger';
}) {
  return (
    <button
      type="button"
      className={`${SECONDARY_BUTTON} px-1.5 py-1 ${tone === 'danger' ? 'text-danger hover:border-danger/40' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={12} className={flip ? 'rotate-180' : undefined} />
    </button>
  );
}

/**
 * Inline editor for one search method (lane), opened from its row.
 *
 * A method the layer below Kiki provides is edited by building a local
 * override: the fields stay read-only until "Override in Kiki" is pressed, and
 * "Restore source version" takes the override away again. A method that exists
 * only in Kiki's own config is editable straight away and can be deleted — with
 * the entries that still point at it named first, because deleting a lane does
 * not silently rewrite the default or a preset that lists it.
 *
 * Which of the two it is comes from Kiki's own declaration plus the layer below,
 * never from the effective catalog: a saved local method is in that catalog too.
 *
 * Every edit writes the page's single draft; this editor has no commit button
 * of its own.
 */

import { useMemo, useRef, useState } from 'react';
import {
  nbSearchLaneReferences,
  setNbSearchLane,
  validateNbSearchReferences,
} from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../../ui';
import { ConfirmDialog } from '../../ConfirmDialog';
import { AdvancedDetails } from '../fields';
import { FieldIssue, FORM_LABEL, SettingsSelect } from '../SettingsPrimitives';
import { costLabelKey, latencyLabelKey } from './types';
import {
  nbSearchInstanceIds,
  nbSearchInstanceProviderId,
  nbSearchIssueText,
  nbSearchItemActions,
  nbSearchLaneIdentity,
  nbSearchOperations,
  nbSearchProviderLabel,
  nbSearchReferenceSubject,
  type NbSearchAdvancedBinding,
  type NbSearchLaneConfig,
} from './advancedSupport';

const LATENCY_VALUES = ['fast', 'medium', 'slow'] as const;
const COST_VALUES = ['free', 'cheap', 'expensive'] as const;

export function NbSearchLaneEditor({
  binding,
  laneId,
  saving = false,
  onRename,
  onClose,
}: {
  binding: NbSearchAdvancedBinding;
  laneId: string;
  saving?: boolean;
  /** Called after a local method is renamed, so the open row follows it. */
  onRename?: (nextLaneId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const capabilities = binding.capabilities;
  const identity = nbSearchLaneIdentity(capabilities, binding.draft, laneId);
  const actions = nbSearchItemActions(identity.source);
  const own = binding.draft.advanced?.lanes[laneId] ?? undefined;
  const profile = own ?? identity.profile;
  const editable = identity.source !== 'source';

  const instanceIds = useMemo(
    () => nbSearchInstanceIds(capabilities, binding.draft),
    [capabilities, binding.draft],
  );
  const instanceId = profile?.provider_instance_id ?? instanceIds[0] ?? '';
  const providerId = nbSearchInstanceProviderId(capabilities, binding.draft, instanceId);
  const operations = useMemo(
    () => nbSearchOperations(capabilities, providerId),
    [capabilities, providerId],
  );
  const operationId = profile?.operation_id ?? operations[0]?.operationId ?? '';

  const issues = useMemo(
    () => validateNbSearchReferences(binding.config, binding.draft, capabilities)
      .filter((issue) => issue.path === `lanes.${laneId}`),
    [binding.config, binding.draft, capabilities, laneId],
  );

  const [idText, setIdText] = useState(laneId);
  const [idIssue, setIdIssue] = useState<string | null>(null);
  const [evidenceText, setEvidenceText] = useState((profile?.evidence_groups ?? []).join(', '));
  const [confirming, setConfirming] = useState(false);
  // Passing capabilities folds in the references that live in the layers below
  // Kiki's own config, so deleting a method names every consumer.
  const references = nbSearchLaneReferences(binding.draft, laneId, capabilities);
  // The draft object changes on every keystroke elsewhere; the ladder below
  // reads through a ref so a stale closure cannot drop the newest edits.
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  const build = (patch: Partial<NbSearchLaneConfig>): NbSearchLaneConfig => {
    const groups = patch.evidence_groups ?? profile?.evidence_groups;
    return {
      provider_instance_id: patch.provider_instance_id ?? instanceId,
      operation_id: patch.operation_id ?? operationId,
      latency: patch.latency ?? profile?.latency ?? 'medium',
      cost: patch.cost ?? profile?.cost ?? 'cheap',
      ...(groups !== undefined && groups.length > 0 ? { evidence_groups: [...groups] } : {}),
    };
  };

  const write = (patch: Partial<NbSearchLaneConfig>) => {
    bindingRef.current.onChange(setNbSearchLane(bindingRef.current.draft, laneId, build(patch)));
  };

  const override = () => {
    if (identity.profile === undefined) return;
    bindingRef.current.onChange(setNbSearchLane(bindingRef.current.draft, laneId, identity.profile));
  };

  const restore = () => {
    bindingRef.current.onChange(setNbSearchLane(bindingRef.current.draft, laneId, undefined));
  };

  const rename = () => {
    const next = idText.trim();
    if (next === laneId) return;
    if (next === '' || next.length > 256) {
      setIdIssue(t('st.nbSearch.custom.lane.idInvalid'));
      return;
    }
    if (
      bindingRef.current.draft.advanced?.lanes[next] !== undefined
      || capabilities.search.lanes.some((lane) => lane.id === next)
    ) {
      setIdIssue(t('st.nbSearch.custom.lane.idTaken'));
      return;
    }
    setIdIssue(null);
    const removed = setNbSearchLane(bindingRef.current.draft, laneId, undefined);
    bindingRef.current.onChange(setNbSearchLane(removed, next, build({})));
    onRename?.(next);
  };

  const commitEvidence = () => {
    const parsed = evidenceText.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    if (parsed.some((entry) => entry.length > 128) || parsed.length > 32) {
      setEvidenceText((profile?.evidence_groups ?? []).join(', '));
      return;
    }
    write({ evidence_groups: parsed });
  };

  const remove = () => {
    if (references.length > 0) {
      setConfirming(true);
      return;
    }
    bindingRef.current.onChange(setNbSearchLane(bindingRef.current.draft, laneId, undefined));
    onClose();
  };

  const fieldSelect = <T extends string>(
    label: string, value: T, choices: readonly { value: T; label: string; hint?: string }[], onChange: (next: T) => void,
  ) => (
    <label className={FORM_LABEL}>
      {label}
      <div className="mt-1">
        <SettingsSelect
          variant="form"
          value={value}
          choices={choices}
          ariaLabel={label}
          disabled={saving || !editable}
          onChange={onChange}
        />
      </div>
    </label>
  );

  return (
    <div
      className="space-y-3 border-l-2 border-hairline pl-3"
      data-nb-search-lane-editor={laneId}
      data-nb-search-lane-source={identity.source}
    >
      <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-lane-origin>
        {identity.source === 'source'
          ? t('st.nbSearch.custom.lane.originSource')
          : identity.source === 'override'
            ? t('st.nbSearch.custom.lane.originOverride')
            : identity.source === 'localUnconfirmed'
              ? t('st.nbSearch.custom.lane.originLocalSetting')
              : identity.source === 'unknown'
                ? t('st.nbSearch.custom.lane.originUnknown')
                : t('st.nbSearch.custom.lane.originLocal')}
      </p>

      {editable ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={FORM_LABEL}>
              {t('st.nbSearch.custom.lane.idLabel')}
              <input
                className={`${INPUT} mt-1 font-mono`}
                value={idText}
                disabled={saving}
                /* Renaming an override would turn it into a plain local method and
                   quietly hand the source method back, so the ID stays fixed. */
                readOnly={!actions.canRename}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('st.nbSearch.custom.lane.idLabel')}
                data-nb-search-lane-id
                onChange={(event) => {
                  setIdText(event.target.value);
                  if (idIssue !== null) setIdIssue(null);
                }}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    rename();
                  } else if (event.key === 'Escape') {
                    setIdText(laneId);
                    setIdIssue(null);
                  }
                }}
              />
              <FieldIssue id={`${laneId}-id-issue`} text={idIssue} />
              {idIssue === null ? (
                <span className="mt-1 block font-normal text-[11px] leading-relaxed text-ink-faint">
                  {t('st.nbSearch.custom.lane.idHint')}
                </span>
              ) : null}
            </label>

            {fieldSelect(
              t('st.nbSearch.custom.lane.instance'),
              instanceId,
              instanceIds.map((id) => ({
                value: id,
                label: nbSearchProviderLabel(t, nbSearchInstanceProviderId(capabilities, binding.draft, id) ?? id),
                hint: id,
              })),
              (next) => {
                const nextProvider = nbSearchInstanceProviderId(capabilities, binding.draft, next);
                const nextOperation = nbSearchOperations(capabilities, nextProvider)[0]?.operationId ?? operationId;
                write({ provider_instance_id: next, operation_id: nextOperation });
              },
            )}

            {fieldSelect(
              t('st.nbSearch.custom.lane.operation'),
              operationId,
              operations.map((operation) => ({
                value: operation.operationId,
                label: operation.operationId,
                hint: operation.channel,
              })),
              (next) => {
                write({ operation_id: next });
              },
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {fieldSelect(
                t('st.nbSearch.custom.lane.latency'),
                profile?.latency ?? 'medium',
                LATENCY_VALUES.map((value) => ({ value, label: t(latencyLabelKey(value)!) })),
                (next) => {
                  write({ latency: next });
                },
              )}

              {fieldSelect(
                t('st.nbSearch.custom.lane.cost'),
                profile?.cost ?? 'cheap',
                COST_VALUES.map((value) => ({ value, label: t(costLabelKey(value)!) })),
                (next) => {
                  write({ cost: next });
                },
              )}
            </div>
          </div>

          <AdvancedDetails summary={t('st.nbSearch.custom.lane.evidence')}>
            <label className="block">
              <span className="text-[12px] text-ink-soft">{t('st.nbSearch.custom.lane.evidenceLabel')}</span>
              <input
                className={`${INPUT} mt-1 font-mono`}
                value={evidenceText}
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('st.nbSearch.custom.lane.evidenceLabel')}
                data-nb-search-lane-evidence
                onChange={(event) => {
                  setEvidenceText(event.target.value);
                }}
                onBlur={commitEvidence}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitEvidence();
                  }
                }}
              />
            </label>
            <p className="text-[12px] leading-snug text-ink-faint">
              {t('st.nbSearch.custom.lane.evidenceHint')}
            </p>
          </AdvancedDetails>
        </>
      ) : (
        <dl className="space-y-1 text-[12px]" data-nb-search-lane-readonly>
          <ReadonlyRow label={t('st.nbSearch.custom.lane.instance')} value={instanceId === '' ? t('st.nbSearch.custom.lane.unknown') : instanceId} />
          <ReadonlyRow label={t('st.nbSearch.custom.lane.operation')} value={operationId === '' ? t('st.nbSearch.custom.lane.unknown') : operationId} />
          <ReadonlyRow
            label={t('st.nbSearch.custom.lane.tier')}
            value={profile === undefined
              ? t('st.nbSearch.custom.lane.unknown')
              : `${t(latencyLabelKey(profile.latency)!)} · ${t(costLabelKey(profile.cost)!)}`}
          />
        </dl>
      )}

      {issues.map((issue) => (
        <p key={`${issue.code}:${issue.path}:${issue.target}`} role="alert" data-nb-search-lane-issue className="text-[12px] leading-4 text-danger">
          {nbSearchIssueText(t, issue)}
          <span className="ml-1 font-mono text-[11px] text-ink-faint">{issue.code} · {issue.path} · {issue.target}</span>
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {editable ? null : (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving || identity.profile === undefined}
            data-nb-search-lane-override
            onClick={override}
          >
            {t('st.nbSearch.custom.lane.override')}
          </button>
        )}
        {/* Taking an override back only means something when a layer below
            really has this method; a local one is removed instead. */}
        {actions.canRestoreSource ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            data-nb-search-lane-restore
            onClick={restore}
          >
            {t('st.nbSearch.custom.lane.restore')}
          </button>
        ) : null}
        {actions.canRemoveLocal ? (
          <button
            type="button"
            className={DANGER_GHOST_BUTTON}
            disabled={saving}
            data-nb-search-lane-remove
            onClick={remove}
          >
            {t('st.nbSearch.custom.lane.remove')}
          </button>
        ) : null}
        <button
          type="button"
          className={`${SECONDARY_BUTTON} ml-auto`}
          onClick={onClose}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="collapse" size={12} />
            {t('st.nbSearch.custom.close')}
          </span>
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title={t('st.nbSearch.custom.lane.removeTitle', { lane: laneId })}
        body={t('st.nbSearch.custom.removeReferenced')}
        confirmLabel={t('st.nbSearch.custom.lane.remove')}
        overlayId={`nb-search-lane-remove-${laneId}`}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          bindingRef.current.onChange(setNbSearchLane(bindingRef.current.draft, laneId, undefined));
          onClose();
        }}
      >
        <ul className="space-y-1" data-nb-search-lane-references>
          {references.map((path) => (
            <li key={path} className="text-[12px] text-ink">
              {nbSearchReferenceSubject(t, path)}
              <span className="ml-1 font-mono text-[11px] text-ink-faint">{path}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-[11px] text-ink">{value}</dd>
    </div>
  );
}

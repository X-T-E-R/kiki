/**
 * Per-source steer settings, under Advanced.
 *
 * The steering a user message gets is the basic configuration and already has
 * its editor above. What lives here is everything else that can start a turn,
 * as nine fixed sources, one compact row each: what the source is, and which of
 * the three answers it has.
 *
 * The rows stay flat on purpose. Nine of them are configuration a person reads
 * once, then rarely touches, so they are a list rather than nine cards: the
 * whole section is one quiet band, a hairline separates the rows, and only the
 * row someone is actually changing opens up. A card per source would give nine
 * boxes equal weight and hide the answer behind a click.
 *
 * Only `custom` opens the editor, and it opens the same body and the same three
 * cadence controls the user's own steering uses — because a source with its own
 * setting should not feel like a different kind of thing.
 */

import { useState } from 'react';

import type { ModelCognitionBodies, ModelSteeringSource, ModelSteeringSourceMode } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { Toggle } from '../controls';
import { SettingsSegmented } from './SettingsPrimitives';
import type { EditScope } from './modelEditScope';
import {
  STEER_SOURCES, steerCadenceProblem, steerScopeFor, withSteerCadence, withSteerCustomText, withSteerMode,
  type ModelSteerSourcesDraft, type SteerCadenceDraft, type SteerScope, type SteerSourceDraft,
} from './modelSteerSourceDraft';

const SOURCE_LABEL = {
  thread: 'st.steerSource.thread',
  room: 'st.steerSource.room',
  agent: 'st.steerSource.agent',
  task: 'st.steerSource.task',
  cron: 'st.steerSource.cron',
  hook: 'st.steerSource.hook',
  automation: 'st.steerSource.automation',
  skill: 'st.steerSource.skill',
  external: 'st.steerSource.external',
} as const satisfies Readonly<Record<ModelSteeringSource, I18nKey>>;

const MODE_CHOICES: readonly ModelSteeringSourceMode[] = ['off', 'inherit', 'custom'] as const;

const MODE_LABEL = {
  off: 'st.steerSource.modeOff',
  inherit: 'st.steerSource.modeInherit',
  custom: 'st.steerSource.modeCustom',
} as const satisfies Readonly<Record<ModelSteeringSourceMode, I18nKey>>;

/**
 * The custom body the engine resolved for one source.
 *
 * A source's words can be stored on the model or read from a file, exactly like
 * the user's own reminder. When it is a file, the engine's own projection is
 * the only thing that knows what the file says today, so it is read from there
 * rather than from the declaration.
 */
export function steerSourceBody(bodies: ModelCognitionBodies | undefined, scope: SteerScope, source: ModelSteeringSource) {
  return bodies?.branches?.[scope]?.steering_sources?.[source];
}

/**
 * Whether a custom source holds any words, from either side of the reference.
 *
 * The draft holds what this page will write. The engine's projection is only
 * consulted for a *file-backed* source, whose text lives in a file the draft
 * never carries: falling back to the resolved text for an inline source would
 * keep showing an old body after a person cleared the box, which is a state
 * that does not exist — clearing inline text really does mean no words.
 */
function hasWords(draft: SteerSourceDraft, scope: SteerScope, bodies: ModelCognitionBodies | undefined, source: ModelSteeringSource): boolean {
  if (draft.custom.text.trim() !== '') return true;
  const resolved = steerSourceBody(bodies, scope, source);
  return resolved?.source === 'files' && (resolved.text ?? '').trim() !== '';
}

export function ModelSteerSources({
  bodies,
  scope,
  draft,
  onDraftChange,
  branchOff = false,
  identityInheritsShared = false,
  disabled = false,
}: {
  bodies: ModelCognitionBodies | undefined;
  /** The identity the rows above are editing. */
  scope: EditScope;
  draft: ModelSteerSourcesDraft | null;
  onDraftChange: (source: ModelSteeringSource, next: SteerSourceDraft) => void;
  /**
   * This identity takes no model cognition at all. The rows are shown and kept
   * editable, because writing a source here is what turns the identity on for
   * that source, but the reason is stated rather than left to be inferred.
   */
  branchOff?: boolean;
  identityInheritsShared?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const steerScope = steerScopeFor(scope);

  return (
    <div className="min-w-0 space-y-3" data-steer-sources={steerScope} data-model-steer-sources>
      {branchOff ? (
        <p className="text-[12px] leading-5 text-ink-soft" data-steer-branch-off>
          {t('st.steerSource.branchOff')}
        </p>
      ) : null}
      {identityInheritsShared ? (
        <p className="text-[12px] leading-5 text-ink-soft" data-steer-identity-inherited>
          {t('st.steerSource.identityInherited')}
        </p>
      ) : null}
      <ul className="min-w-0 divide-y divide-hairline" data-steer-source-rows>
        {STEER_SOURCES.map((source) => (
          <li key={source} data-steer-source={source}>
            <SteerSourceRow
              source={source}
              steerScope={steerScope}
              bodies={bodies}
              draft={draft?.[steerScope]?.[source]}
              disabled={disabled}
              onDraftChange={onDraftChange}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One source: its name, its answer, and its own setting when it has one. */
function SteerSourceRow({ source, steerScope, bodies, draft, disabled, onDraftChange }: {
  source: ModelSteeringSource;
  steerScope: SteerScope;
  bodies: ModelCognitionBodies | undefined;
  draft: SteerSourceDraft | undefined;
  disabled: boolean;
  onDraftChange: (source: ModelSteeringSource, next: SteerSourceDraft) => void;
}) {
  const { t } = useI18n();
  const current: SteerSourceDraft = draft ?? { mode: 'off', custom: { text: '', cadence: { onTurn: true, onInput: true, intervalSteps: '0' } } };

  return (
    <div className="py-2 first:pt-0.5 last:pb-0.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] leading-5 text-ink" data-steer-source-label={source}>
            {t(SOURCE_LABEL[source])}
          </span>
          {/*
            The segmented control already says which of the three answers is
            chosen, so a row repeats that only when the choice needs a word the
            control cannot give: a custom source that holds nothing yet, which
            is the one case where "separately" would otherwise read as "and with
            what?" right above an empty box.
          */}
          {current.mode === 'custom' && !hasWords(current, steerScope, bodies, source) ? (
            <span className="truncate text-[11.5px] leading-4 text-ink-faint" data-steer-source-state={source}>
              {t('st.steerSource.stateEmpty')}
            </span>
          ) : null}
        </div>
        <SettingsSegmented<ModelSteeringSourceMode>
          ariaLabel={t('st.steerSource.modeAria', { source: t(SOURCE_LABEL[source]) })}
          value={current.mode}
          disabled={disabled}
          dataAttr="data-steer-mode"
          onChange={(mode) => { onDraftChange(source, withSteerMode(current, mode)); }}
          choices={MODE_CHOICES.map((mode) => ({ value: mode, label: t(MODE_LABEL[mode]) }))}
        />
      </div>
      {/*
        The editor opens for `custom` alone. `inherit` deliberately shows no
        copy of the user's own words: it is a decision to keep following them,
        and a frozen duplicate would read as a separate setting that happens to
        agree today.
      */}
      {current.mode === 'custom' ? (
        <div className="mt-2.5 space-y-3 rounded-md bg-ink/[0.025] px-3 py-3" data-steer-source-editor={source}>
          <SteerSourceBody
            source={source}
            steerScope={steerScope}
            bodies={bodies}
            text={current.custom.text}
            disabled={disabled}
            onChange={(text) => { onDraftChange(source, withSteerCustomText(current, text)); }}
          />
          <SteerCadenceFields
            source={source}
            cadence={current.custom.cadence}
            disabled={disabled}
            onChange={(cadence) => { onDraftChange(source, withSteerCadence(current, cadence)); }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The source's own words, or the file they are read from, read-only if need be. */
function SteerSourceBody({ source, steerScope, bodies, text, disabled, onChange }: {
  source: ModelSteeringSource;
  steerScope: SteerScope;
  bodies: ModelCognitionBodies | undefined;
  text: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const { t } = useI18n();
  const [showFile, setShowFile] = useState(false);
  const label = t(SOURCE_LABEL[source]);
  const view = steerSourceBody(bodies, steerScope, source);

  // A file-backed body is shown as it resolves today, and stays selectable: the
  // file itself is not edited from here, and the path stays visible so the
  // original reference can be restored from the manifest.
  if (view !== undefined && view.source === 'files') {
    return (
      <div className="space-y-1.5" data-steer-body={source} data-steer-body-source="files">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.steerSource.body')}</p>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-ink/[0.035] px-3 py-2 font-mono text-[12px] leading-5 text-ink-soft select-text"
          data-steer-body-readonly={source}>{view.text ?? ''}</pre>
        <button type="button"
          className="text-[11.5px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          data-steer-body-files={source}
          onClick={() => { setShowFile(!showFile); }}>
          {t(showFile ? 'st.steerSource.hideFile' : 'st.steerSource.showFile')}
        </button>
        {showFile ? (
          <p className="break-all font-mono text-[11px] text-ink-faint">
            {(view.files ?? []).map((file) => file.path).join(', ')}
          </p>
        ) : null}
        {view.error !== undefined ? <p role="alert" className="text-[12px] leading-5 text-danger">{view.error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-steer-body={source} data-steer-body-source={view?.source ?? 'unset'}>
      <p className="text-[12px] font-medium text-ink-soft">{t('st.steerSource.body')}</p>
      <textarea rows={5} spellCheck={false} disabled={disabled} aria-label={label}
        placeholder={t('st.steerSource.emptyBody')}
        className="h-auto w-full resize-y rounded-md border border-hairline-strong bg-panel px-2.5 py-2 font-mono text-[12px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-selected-ink/45 disabled:cursor-not-allowed disabled:opacity-60"
        data-steer-body-editor={source} value={text}
        onChange={(event) => { onChange(event.target.value); }} />
    </div>
  );
}

/**
 * The same three timing controls the user's own steering uses.
 *
 * Each is a separate value with its own current value shown, because a declared
 * `false` and an unset one behave the same but mean different things to whoever
 * reads the declaration later.
 */
function SteerCadenceFields({ source, cadence, disabled, onChange }: {
  source: ModelSteeringSource;
  cadence: SteerCadenceDraft;
  disabled: boolean;
  onChange: (cadence: SteerCadenceDraft) => void;
}) {
  const { t } = useI18n();
  const intervalProblem = steerCadenceProblem(cadence.intervalSteps);
  return (
    <div className="space-y-1.5" data-steer-cadence>
      <p className="text-[12px] font-medium text-ink-soft">{t('st.modelPrompt.cadence')}</p>
      <Toggle
        id={`steer-cadence-turn-${source}`}
        label={t('st.modelPrompt.cadenceTurn')}
        checked={cadence.onTurn}
        disabled={disabled}
        onChange={(onTurn) => { onChange({ ...cadence, onTurn }); }}
      />
      <Toggle
        id={`steer-cadence-input-${source}`}
        label={t('st.modelPrompt.cadenceInput')}
        checked={cadence.onInput}
        disabled={disabled}
        onChange={(onInput) => { onChange({ ...cadence, onInput }); }}
      />
      <label className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] text-ink">{t('st.modelPrompt.cadenceInterval')}</span>
        <span className="flex items-baseline gap-1.5">
          <input type="number" min={0} step={1} disabled={disabled}
            aria-label={t('st.modelPrompt.cadenceInterval')}
            data-steer-cadence-interval={source}
            value={cadence.intervalSteps}
            onChange={(event) => { onChange({ ...cadence, intervalSteps: event.target.value }); }}
            className="w-16 rounded-md border border-hairline-strong bg-panel px-2 py-1 text-right font-mono text-[12px] text-ink outline-none transition-colors focus-visible:border-selected-ink/45 disabled:cursor-not-allowed disabled:opacity-60" />
          <span className="text-[11.5px] text-ink-faint">{t('st.steerSource.steps')}</span>
        </span>
      </label>
      {intervalProblem !== undefined ? (
        <p role="alert" className="text-[11.5px] leading-4 text-danger" data-steer-cadence-issue>
          {t(intervalProblem === 'empty' ? 'st.steerSource.cadenceEmpty' : 'st.steerSource.cadenceCount')}
        </p>
      ) : null}
    </div>
  );
}
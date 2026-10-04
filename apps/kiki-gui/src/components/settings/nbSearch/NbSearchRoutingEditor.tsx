/**
 * Fetch routing: which pipeline a URL fetch is planned through.
 *
 * The engine owns the decision. This editor writes only the parts Kiki is
 * allowed to write — whether routing runs, whether the maintained built-in
 * package runs, and the user's own ordered origin/path rules — and reads
 * everything else (the built-in rule list, the package version) from the
 * capability projection the server already builds. It never re-implements
 * matching: the inline preview calls the standard package's own
 * `selectFetchRoute` through the protocol re-export, so what the page predicts
 * is the same pure function the runtime will run, with no provider contacted
 * and nothing paid.
 *
 * Three states for the whole domain, matching the config format: follow the
 * source, a Kiki-owned routing config, or an explicit clear. A clear turns off
 * the inherited user rules while leaving the built-in package on, which is not
 * the same as switching fetching off, and the row says exactly that.
 *
 * Renders the body only — the Fetch tab owns the group heading.
 */

import { useMemo, useState } from 'react';
import { selectFetchRoute, type FetchRouteRule } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import { AdvancedDetails } from '../fields';
import { costLabelKey, latencyLabelKey } from './types';
import {
  nbSearchBuiltinRuleActive,
  nbSearchRoutingView,
  type NbSearchAdvancedBinding,
  type NbSearchRoutingDraft,
} from './advancedSupport';

type RoutingMode = 'inherited' | 'custom' | 'cleared';
type RoutingConfig = NbSearchRoutingDraft;
type ActionKind = 'pipelines' | 'default';
/** Undefined restores inheritance, null clears it, a value is a Kiki routing config. */
type OptionalRouting = NbSearchRoutingDraft | null;

const MAX_RULES = 256;
const MAX_PIPELINES = 64;
const REPRESENTATION_ANY = 'any';

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hairline/50 font-mono text-[11px] font-semibold text-ink">
      {n}
    </span>
  );
}

function actionKind(rule: FetchRouteRule): ActionKind {
  return 'pipelines' in rule.action ? 'pipelines' : 'default';
}

function planText(rule: FetchRouteRule, defaultWord: string): string {
  return 'pipelines' in rule.action ? rule.action.pipelines.join(' → ') : defaultWord;
}

export function NbSearchRoutingEditor({
  binding,
  saving = false,
}: {
  binding: NbSearchAdvancedBinding;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const advanced = binding.draft.advanced;
  const capabilities = binding.capabilities;
  const view = nbSearchRoutingView(capabilities, binding.draft);
  const [previewUrl, setPreviewUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newOrigin, setNewOrigin] = useState('');

  const pipelineById = useMemo(
    () => new Map(capabilities.fetch.pipelines.map((pipeline) => [pipeline.id, pipeline])),
    [capabilities.fetch.pipelines],
  );
  const urlPipelines = useMemo(
    () => capabilities.fetch.pipelines.filter((pipeline) => pipeline.input_kinds.includes('url')),
    [capabilities.fetch.pipelines],
  );
  const defaultPipelines = advanced?.fetchChains.find(
    (chain) => chain.inputKind === 'url' && chain.representation === 'markdown',
  )?.pipelines ?? binding.draft.fetchChain;

  if (advanced === undefined) return null;

  const own = advanced.routing;
  const mode: RoutingMode = own === undefined ? 'inherited' : own === null ? 'cleared' : 'custom';
  const config: RoutingConfig | undefined = own === undefined || own === null ? undefined : own;
  const rules = view.effective.rules;
  const builtinEnabled = view.effective.builtin_enabled;
  const routingEnabled = view.effective.enabled;

  const write = (routing: OptionalRouting | undefined) => {
    binding.onChange({ ...binding.draft, advanced: { ...advanced, routing } });
  };

  /** Entering custom mode seeds from the effective view, so nothing hides. */
  const toCustom = (): RoutingConfig => ({
    enabled: view.effective.enabled,
    builtin_enabled: view.effective.builtin_enabled,
    ...(view.effective.disabled_builtin_rules.length > 0
      ? { disabled_builtin_rules: [...view.effective.disabled_builtin_rules] }
      : {}),
    rules: view.effective.rules.map((rule) => structuredClone(rule)),
  });

  const setMode = (next: RoutingMode) => {
    if (next === 'inherited') write(undefined);
    else if (next === 'cleared') write(null);
    else write(toCustom());
  };

  const patch = (fields: Partial<RoutingConfig>) => {
    const current = config ?? toCustom();
    write({ ...current, ...fields });
  };

  const writeRules = (next: readonly FetchRouteRule[]) => {
    patch({ rules: [...next] });
  };

  const updateRule = (index: number, rule: FetchRouteRule) => {
    writeRules(rules.map((current, candidate) => (candidate === index ? rule : current)));
  };

  const moveRule = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target]!, next[index]!];
    writeRules(next);
  };

  const setRulePipelines = (index: number, pipelines: readonly string[]) => {
    if (pipelines.length === 0 || pipelines.length > MAX_PIPELINES) return;
    updateRule(index, { ...rules[index]!, action: { pipelines: [...pipelines] } });
  };

  const commitNewRule = () => {
    const id = newId.trim();
    const origin = newOrigin.trim();
    if (id === '' || origin === '' || rules.some((rule) => rule.id === id)) return;
    writeRules([...rules, { id, match: { origin }, action: { pipelines: ['direct.fetch'] } }]);
    setNewId('');
    setNewOrigin('');
    setAdding(false);
  };

  const newRuleBlocked = newId.trim() === ''
    || newOrigin.trim() === ''
    || rules.some((rule) => rule.id === newId.trim());
  const newRuleDuplicate = newId.trim() !== '' && rules.some((rule) => rule.id === newId.trim());

  const preview = useMemo(() => {
    const trimmed = previewUrl.trim();
    if (trimmed === '') return null;
    try {
      // The standard package's own selector. Pure: it plans, it does not
      // fetch, and it cannot bill. A URL it cannot parse is left to the tool.
      return selectFetchRoute(
        { url: trimmed, representation: 'markdown', execution: 'sync' },
        view.effective,
        defaultPipelines,
      );
    } catch {
      return null;
    }
  }, [previewUrl, view, defaultPipelines]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <span className="text-[13px] text-ink" data-nb-search-routing-mode={mode}>
            {mode === 'inherited'
              ? t('st.nbSearch.routing.modeInherited')
              : mode === 'cleared'
                ? t('st.nbSearch.routing.modeCleared')
                : t('st.nbSearch.routing.modeCustom')}
          </span>
          <p className="text-[12px] leading-snug text-ink-faint">
            {mode === 'inherited'
              ? t('st.nbSearch.routing.modeInheritedHint')
              : mode === 'cleared'
                ? t('st.nbSearch.routing.modeClearedHint')
                : t('st.nbSearch.routing.modeCustomHint')}
          </p>
        </div>
        <SettingsSegmented
          value={mode}
          ariaLabel={t('st.nbSearch.routing.mode')}
          dataAttr="data-nb-search-routing-mode-choice"
          disabled={saving}
          choices={[
            { value: 'inherited', label: t('st.nbSearch.advanced.inheritSource') },
            { value: 'custom', label: t('st.nbSearch.advanced.customValue') },
            { value: 'cleared', label: t('st.nbSearch.routing.modeClearedShort') },
          ]}
          onChange={setMode}
        />
      </div>

      {/* The maintained package: what it covers, and whether it runs. Its switch
          is independent of the user's own rules and of routing as a whole. */}
      <div className="space-y-2 rounded-lg border border-hairline p-3" data-nb-search-routing-builtin>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <p className="text-[13px] font-medium text-ink">{t('st.nbSearch.routing.builtinTitle')}</p>
            <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-routing-package>
              {view.reported
                ? t('st.nbSearch.routing.packageMeta', {
                  id: view.effective.package.id,
                  version: view.effective.package.version,
                  maintainer: view.effective.package.maintainer,
                })
                : t('st.nbSearch.routing.packageUnreported')}
            </p>
            <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.routing.builtinHint')}</p>
          </div>
          <SettingsSegmented
            value={builtinEnabled ? 'on' : 'off'}
            ariaLabel={t('st.nbSearch.routing.builtinTitle')}
            dataAttr="data-nb-search-routing-builtin-switch"
            disabled={saving || mode === 'inherited'}
            choices={[
              { value: 'on', label: t('st.nbSearch.routing.builtinOn') },
              { value: 'off', label: t('st.nbSearch.routing.builtinOff') },
            ]}
            onChange={(next) => {
              patch({ builtin_enabled: next === 'on' });
            }}
          />
        </div>

        {view.effective.builtin_rules.length === 0 ? null : (
          <ul className="divide-y divide-hairline" data-nb-search-routing-builtin-rules>
            {view.effective.builtin_rules.map((rule) => {
              const active = nbSearchBuiltinRuleActive(view, rule.id);
              return (
                <li key={rule.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5" data-nb-search-routing-builtin-rule={rule.id} data-nb-search-routing-builtin-rule-active={active ? 'true' : 'false'}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[11px] text-ink">{rule.id}</span>
                    <span className="block break-all font-mono text-[11px] leading-relaxed text-ink-faint">{rule.match.origin}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                    {planText(rule, t('st.nbSearch.routing.builtinDefaultChain'))}
                  </span>
                  <span className={`shrink-0 text-[12px] ${active ? 'text-ink-soft' : 'text-ink-faint'}`}>
                    {active ? t('st.nbSearch.routing.builtinActive') : t('st.nbSearch.routing.builtinDisabled')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {view.effective.disabled_builtin_rules.length === 0 ? null : (
          <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-routing-builtin-disabled>
            {t('st.nbSearch.routing.builtinDisabledHint', {
              ids: view.effective.disabled_builtin_rules.join(', '),
            })}
          </p>
        )}
      </div>

      {/* The user's own rules, in priority order. */}
      <div className="space-y-2" data-nb-search-routing-rules>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.routing.userTitle')}</span>
          {mode === 'custom' && rules.length < MAX_RULES ? (
            <button
              type="button"
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
              disabled={saving || adding}
              data-nb-search-routing-add
              onClick={() => {
                setNewId(`my-rule-${rules.length + 1}`);
                setNewOrigin('');
                setAdding(true);
              }}
            >
              <Icon name="plus" size={12} />
              {t('st.nbSearch.routing.addRule')}
            </button>
          ) : null}
        </div>

        {rules.length === 0 ? (
          <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-routing-rules-empty>
            {t('st.nbSearch.routing.rulesNone')}
          </p>
        ) : (
          <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.routing.orderHint')}</p>
        )}

        {mode === 'custom' ? (
          <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
            <ol className="space-y-3" data-nb-search-routing-rules-list>
              {rules.map((rule, index) => {
                const pipelines = 'pipelines' in rule.action ? rule.action.pipelines : [];
                const off = rule.enabled === false;
                const unknownPipeline = pipelines.filter((id) => !urlPipelines.some((candidate) => candidate.id === id));
                return (
                  <li
                    key={`${index}:${rule.id}`}
                    className="space-y-2 rounded-lg border border-hairline p-3"
                    data-nb-search-routing-rule={rule.id}
                    data-nb-search-routing-rule-enabled={off ? 'false' : 'true'}
                  >
                    {/* The name gets the whole row on a phone, where four row
                        buttons beside it would squeeze the field to nothing. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <StepNumber n={index + 1} />
                      <label className="min-w-0 flex-1 basis-40">
                        <span className="sr-only">{t('st.nbSearch.routing.ruleId', { n: index + 1 })}</span>
                        <input
                          className={`${INPUT} font-mono`}
                          value={rule.id}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={t('st.nbSearch.routing.ruleIdPlaceholder')}
                          aria-label={t('st.nbSearch.routing.ruleId', { n: index + 1 })}
                          data-nb-search-routing-rule-id
                          onChange={(event) => {
                            updateRule(index, { ...rule, id: event.target.value });
                          }}
                        />
                      </label>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                          data-nb-search-routing-rule-up
                          aria-label={t('st.nbSearch.routing.moveRuleUp', { n: index + 1 })}
                          title={t('st.nbSearch.routing.moveRuleUp', { n: index + 1 })}
                          disabled={index === 0}
                          onClick={() => { moveRule(index, -1); }}
                        >
                          <Icon name="arrowDown" size={12} className="rotate-180" />
                        </button>
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                          data-nb-search-routing-rule-down
                          aria-label={t('st.nbSearch.routing.moveRuleDown', { n: index + 1 })}
                          title={t('st.nbSearch.routing.moveRuleDown', { n: index + 1 })}
                          disabled={index === rules.length - 1}
                          onClick={() => { moveRule(index, 1); }}
                        >
                          <Icon name="arrowDown" size={12} />
                        </button>
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                          data-nb-search-routing-rule-toggle
                          aria-pressed={!off}
                          aria-label={t(off ? 'st.nbSearch.routing.enableRule' : 'st.nbSearch.routing.disableRule', { id: rule.id })}
                          title={t(off ? 'st.nbSearch.routing.enableRule' : 'st.nbSearch.routing.disableRule', { id: rule.id })}
                          onClick={() => {
                            updateRule(index, { ...rule, enabled: !off });
                          }}
                        >
                          {/* A strike, not the close mark: close on this row
                              already means delete, and a rule being off is
                              neither. */}
                          {off ? <Icon name="dash" size={12} /> : <Icon name="check" size={12} />}
                        </button>
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} shrink-0 px-1.5 py-1 text-danger hover:border-danger/40`}
                          data-nb-search-routing-rule-remove
                          aria-label={t('st.nbSearch.routing.removeRule', { id: rule.id })}
                          title={t('st.nbSearch.routing.removeRule', { id: rule.id })}
                          onClick={() => {
                            writeRules(rules.filter((_, candidate) => candidate !== index));
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    </div>

                    {off ? (
                      <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.routing.ruleDisabledHint')}</p>
                    ) : null}

                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className={FORM_LABEL}>
                        {t('st.nbSearch.routing.origin')}
                        <input
                          className={`${INPUT} mt-1 font-mono`}
                          value={rule.match.origin}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="https://example.com"
                          aria-label={t('st.nbSearch.routing.origin', { n: index + 1 })}
                          data-nb-search-routing-rule-origin
                          onChange={(event) => {
                            updateRule(index, { ...rule, match: { ...rule.match, origin: event.target.value } });
                          }}
                        />
                      </label>
                      <label className={FORM_LABEL}>
                        {t('st.nbSearch.routing.pathGlobs')}
                        <input
                          className={`${INPUT} mt-1 font-mono`}
                          value={(rule.match.path_globs ?? []).join(', ')}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="/reference/**, /api/**"
                          aria-label={t('st.nbSearch.routing.pathGlobs', { n: index + 1 })}
                          data-nb-search-routing-rule-globs
                          onChange={(event) => {
                            const globs = event.target.value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
                            updateRule(index, { ...rule, match: { ...rule.match, path_globs: globs.length === 0 ? undefined : globs } });
                          }}
                        />
                      </label>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className={FORM_LABEL}>
                        {t('st.nbSearch.fetch.representation')}
                        <span className="mt-1 block font-normal">
                          <SettingsSelect
                            variant="form"
                            value={rule.match.representation ?? REPRESENTATION_ANY}
                            ariaLabel={t('st.nbSearch.routing.representation', { n: index + 1 })}
                            dataAttr="data-nb-search-routing-rule-representation"
                            choices={[
                              { value: REPRESENTATION_ANY, label: t('st.nbSearch.routing.representationAny') },
                              { value: 'markdown', label: t('st.nbSearch.fetch.representation.markdown') },
                              { value: 'text', label: t('st.nbSearch.fetch.representation.text') },
                            ]}
                            onChange={(next) => {
                              updateRule(index, {
                                ...rule,
                                match: { ...rule.match, representation: next === REPRESENTATION_ANY ? undefined : next },
                              });
                            }}
                          />
                        </span>
                      </label>
                      <label className={FORM_LABEL}>
                        {t('st.nbSearch.routing.action', { n: index + 1 })}
                        <span className="mt-1 block font-normal">
                          <SettingsSegmented
                            value={actionKind(rule)}
                            ariaLabel={t('st.nbSearch.routing.action', { n: index + 1 })}
                            dataAttr="data-nb-search-routing-rule-action"
                            choices={[
                              { value: 'pipelines', label: t('st.nbSearch.routing.actionPipelines') },
                              { value: 'default', label: t('st.nbSearch.routing.actionDefaultShort') },
                            ]}
                            onChange={(next) => {
                              if (next === 'default') updateRule(index, { ...rule, action: { use: 'default' } });
                              else setRulePipelines(index, pipelines.length === 0 ? ['direct.fetch'] : pipelines);
                            }}
                          />
                        </span>
                      </label>
                    </div>

                    {actionKind(rule) === 'default' ? (
                      <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-routing-rule-default>
                        {t('st.nbSearch.routing.actionDefaultHint')}
                      </p>
                    ) : (
                      <div className="space-y-1" data-nb-search-routing-rule-pipelines>
                        <p className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.routing.pipelines')}</p>
                        {pipelines.map((pipelineId, step) => {
                          const pipeline = pipelineById.get(pipelineId);
                          return (
                            <div key={`${step}:${pipelineId}`} className="flex items-center gap-2" data-nb-search-routing-pipeline={pipelineId}>
                              <StepNumber n={step + 1} />
                              <div className="min-w-0 flex-1">
                                <SettingsSelect
                                  variant="form"
                                  mono
                                  value={pipelineId}
                                  ariaLabel={t('st.nbSearch.routing.pipelineStep', { n: step + 1 })}
                                  dataAttr="data-nb-search-routing-pipeline-step"
                                  choices={[
                                    ...(pipeline === undefined
                                      ? [{ value: pipelineId, label: pipelineId, hint: t('st.nbSearch.custom.pipelineUnknown') }]
                                      : []),
                                    ...urlPipelines.map((candidate) => ({
                                      value: candidate.id,
                                      label: candidate.id,
                                      hint: `${costLabelKey(candidate.cost) === undefined ? candidate.cost : t(costLabelKey(candidate.cost)!)} · ${latencyLabelKey(candidate.latency) === undefined ? candidate.latency : t(latencyLabelKey(candidate.latency)!)}`,
                                    })),
                                  ]}
                                  onChange={(nextId) => {
                                    const next = [...pipelines];
                                    next[step] = nextId;
                                    setRulePipelines(index, next);
                                  }}
                                />
                              </div>
                              <button
                                type="button"
                                className={`${SECONDARY_BUTTON} shrink-0 px-1.5 py-1 text-danger hover:border-danger/40`}
                                data-nb-search-routing-pipeline-remove
                                aria-label={t('st.nbSearch.routing.removePipelineStep', { n: step + 1 })}
                                title={t('st.nbSearch.routing.removePipelineStep', { n: step + 1 })}
                                disabled={pipelines.length === 1}
                                onClick={() => {
                                  setRulePipelines(index, pipelines.filter((_, candidate) => candidate !== step));
                                }}
                              >
                                <Icon name="close" size={12} />
                              </button>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
                          data-nb-search-routing-pipeline-add
                          disabled={urlPipelines.every((candidate) => pipelines.includes(candidate.id))}
                          onClick={() => {
                            const unused = urlPipelines.find((candidate) => !pipelines.includes(candidate.id));
                            if (unused !== undefined) setRulePipelines(index, [...pipelines, unused.id]);
                          }}
                        >
                          <Icon name="plus" size={12} />
                          {t('st.nbSearch.addPipeline')}
                        </button>
                        <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.routing.pipelinesHint')}</p>
                      </div>
                    )}

                    {unknownPipeline.length === 0 ? null : (
                      <p role="alert" className="text-[12px] leading-4 text-danger" data-nb-search-routing-pipeline-issue>
                        {t('st.nbSearch.routing.pipelineUnknownNamed', { ids: unknownPipeline.join(', ') })}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>

            {adding ? (
              <div className="space-y-2 rounded-lg border border-hairline p-3" data-nb-search-routing-new>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={FORM_LABEL}>
                    {t('st.nbSearch.routing.newRuleId')}
                    <input
                      className={`${INPUT} mt-1 font-mono`}
                      value={newId}
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t('st.nbSearch.routing.newRuleId')}
                      data-nb-search-routing-new-id
                      onChange={(event) => { setNewId(event.target.value); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commitNewRule(); }
                        if (event.key === 'Escape') { setAdding(false); }
                      }}
                    />
                  </label>
                  <label className={FORM_LABEL}>
                    {t('st.nbSearch.routing.origin')}
                    <input
                      className={`${INPUT} mt-1 font-mono`}
                      value={newOrigin}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="https://example.com"
                      aria-label={t('st.nbSearch.routing.origin')}
                      data-nb-search-routing-new-origin
                      onChange={(event) => { setNewOrigin(event.target.value); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commitNewRule(); }
                        if (event.key === 'Escape') { setAdding(false); }
                      }}
                    />
                  </label>
                </div>
                {newRuleDuplicate ? (
                  <p role="alert" className="text-[12px] leading-4 text-danger" data-nb-search-routing-new-issue>
                    {t('st.nbSearch.routing.duplicateId')}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={newRuleBlocked}
                    data-nb-search-routing-new-save
                    onClick={commitNewRule}
                  >
                    {t('st.nbSearch.routing.addRule')}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    data-nb-search-routing-new-cancel
                    onClick={() => { setAdding(false); }}
                  >
                    {t('st.nbSearch.routing.cancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : (
          <ol className="divide-y divide-hairline" data-nb-search-routing-rules-readonly>
            {rules.map((rule, index) => (
              <li key={`${index}:${rule.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2">
                <StepNumber n={index + 1} />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[11px] text-ink">{rule.id}</span>
                  <span className="block break-all font-mono text-[11px] leading-relaxed text-ink-faint">
                    {rule.match.origin}
                    {(rule.match.path_globs ?? []).length > 0 ? ` ${(rule.match.path_globs ?? []).join(' ')}` : ''}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                  {planText(rule, t('st.nbSearch.routing.actionDefault'))}
                </span>
              </li>
            ))}
          </ol>
        )}

        {mode === 'custom' && rules.some((rule) => rule.id.trim() === '' || rule.match.origin.trim() === '') ? (
          <p role="alert" data-nb-search-routing-issue className="text-[12px] leading-4 text-danger">
            {t('st.nbSearch.routing.incomplete')}
          </p>
        ) : null}
      </div>

      {/* Local, offline plan preview. It calls the engine's own selector: no
          provider is contacted, so nothing here can cost anything. */}
      <div className="space-y-2 border-t border-hairline pt-3">
        <label className={FORM_LABEL}>
          {t('st.nbSearch.routing.previewTitle')}
          <input
            className={`${INPUT} mt-1 font-mono`}
            value={previewUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://example.com/page"
            aria-label={t('st.nbSearch.routing.previewTitle')}
            data-nb-search-routing-preview-input
            onChange={(event) => { setPreviewUrl(event.target.value); }}
          />
        </label>
        {preview === null ? null : (
          <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-routing-preview-result={preview.origin}>
            {preview.origin === 'user'
              ? t('st.nbSearch.routing.previewMatched', { origin: t('st.nbSearch.routing.originUser'), rule: preview.rule_id ?? '', pipelines: preview.pipelines.join(' → ') })
              : preview.origin === 'builtin'
                ? t('st.nbSearch.routing.previewMatched', { origin: t('st.nbSearch.routing.originBuiltin'), rule: preview.rule_id ?? '', pipelines: preview.pipelines.join(' → ') })
                : t('st.nbSearch.routing.previewDefault', { pipelines: preview.pipelines.join(' → ') })}
          </p>
        )}
      </div>

      <AdvancedDetails summary={t('st.nbSearch.routing.advancedTitle')}>
        <p data-nb-search-routing-precedence>{t('st.nbSearch.routing.precedence')}</p>
        <p data-nb-search-routing-enabled={routingEnabled ? 'true' : 'false'}>
          {routingEnabled ? t('st.nbSearch.routing.routingOn') : t('st.nbSearch.routing.routingOff')}
        </p>
        {routingEnabled ? null : (
          <>
            <button
              type="button"
              className={`${SECONDARY_BUTTON} mt-1`}
              data-nb-search-routing-enable
              disabled={saving}
              onClick={() => {
                patch({ enabled: true });
              }}
            >
              {t('st.nbSearch.routing.enableRouting')}
            </button>
          </>
        )}
      </AdvancedDetails>
    </div>
  );
}

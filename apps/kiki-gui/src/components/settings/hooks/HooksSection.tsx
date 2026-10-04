import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { parseHooksConfigJson } from '@kiki/session-core/settings';
import type { HooksConfig } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { SettingField, SettingsGroup } from '../fields';
import { SettingsDetailLayout, SettingsDraftFooter } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import { DeclarativeRuleEditor } from './DeclarativeRuleEditor';
import { LegacyRuleEditor } from './LegacyRuleEditor';
import { StringListEditor } from './StringListEditor';
import {
  addDeclarativeRule,
  addLegacyRule,
  canFlattenToLegacy,
  convertToV2,
  draftFromHooks,
  flattenToLegacy,
  hooksDraftJson,
  hooksDraftPatch,
  parseHooksDraftJson,
  removeDeclarativeRule,
  removeLegacyRule,
  setV2Disabled,
  setV2Enabled,
  setV2Files,
  updateDeclarativeRule,
  updateLegacyRule,
  validateHooksDraft,
  type DraftIssue,
  type HooksDraft,
  type RuleRef,
} from './hooksDraft';

function sameRef(a: RuleRef | null, b: RuleRef): boolean {
  if (a === null) return false;
  return a.kind === 'declarative' && b.kind === 'declarative' ? a.id === b.id : a.kind === 'legacy' && b.kind === 'legacy' && a.index === b.index;
}

function refKey(ref: RuleRef): string {
  return ref.kind === 'declarative' ? `declarative:${ref.id}` : `legacy:${ref.index}`;
}

function issuesFor(issues: readonly DraftIssue[], ref: RuleRef): DraftIssue[] {
  return issues.filter((issue) => issue.ref !== null && sameRef(issue.ref, ref));
}

/**
 * Hooks leaf: the dual-shape editor for the `hooks` config value. A legacy
 * command array and a schemaVersion-2 object share one list → detail layout;
 * the JSON mode edits either shape and round-trips through the same
 * parseHooksConfigJson/hooksDraftPatch chain as the form. Saving replaces the
 * whole hooks value, so editing one rule can never drop the others.
 */
export function HooksSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<HooksDraft | null>(null);
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [selected, setSelected] = useState<RuleRef | null>(null);
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const [issues, setIssues] = useState<readonly DraftIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data === undefined || dirty) return;
    const raw = JSON.stringify(configQuery.data.hooks ?? [], null, 2);
    setJson(raw);
    try {
      setDraft(draftFromHooks(parseHooksConfigJson(raw)));
      setMode('form');
    } catch {
      // A hooks value outside both shapes stays editable as raw JSON.
      setDraft(null);
      setMode('json');
    }
  }, [configQuery.data, dirty]);

  const edit = (next: HooksDraft) => {
    setDraft(next);
    setDirty(true);
    setIssues([]);
    setFeedback(null);
  };

  const select = (ref: RuleRef | null) => {
    setSelected(ref);
    setNarrowPane(ref === null ? 'list' : 'detail');
  };

  const addCommand = () => {
    if (draft === null) return;
    const next = addLegacyRule(draft);
    edit(next.draft);
    select(next.ref);
  };
  const addDeclarative = () => {
    if (draft === null) return;
    const next = addDeclarativeRule(draft.shape === 'v2' ? draft : convertToV2(draft));
    edit(next.draft);
    select(next.ref);
  };

  const removeRule = (ref: RuleRef) => {
    if (draft === null) return;
    edit(ref.kind === 'declarative' ? removeDeclarativeRule(draft, ref.id) : removeLegacyRule(draft, ref.index));
    if (sameRef(selected, ref)) select(null);
  };

  const switchMode = () => {
    if (mode === 'form') {
      if (draft !== null) setJson(hooksDraftJson(draft));
      setMode('json');
      setFeedback(null);
      return;
    }
    try {
      setDraft(parseHooksDraftJson(json));
      setMode('form');
      setIssues([]);
      setFeedback(null);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const save = async () => {
    let patch: { hooks: HooksConfig };
    if (mode === 'json') {
      try {
        patch = { hooks: parseHooksConfigJson(json) };
      } catch (error) {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
        return;
      }
    } else {
      if (draft === null) return;
      const found = validateHooksDraft(draft);
      if (found.length > 0) {
        const first = found[0]!;
        setIssues(found);
        if (first.ref !== null) select(first.ref);
        setFeedback({ tone: 'error', text: t('st.hooks.configInvalid', { field: first.path, message: first.message }) });
        return;
      }
      try {
        patch = hooksDraftPatch(draft);
      } catch (error) {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
        return;
      }
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      const nextDraft = draftFromHooks(parseHooksConfigJson(JSON.stringify(echoed.hooks ?? [])));
      setDraft(nextDraft);
      setJson(hooksDraftJson(nextDraft));
      setDirty(false);
      setIssues([]);
      pingSaved();
    } catch (error) {
      // Save failures keep the draft: nothing the user typed is lost.
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    const raw = JSON.stringify(configQuery.data?.hooks ?? [], null, 2);
    setJson(raw);
    try {
      setDraft(draftFromHooks(parseHooksConfigJson(raw)));
      setMode('form');
    } catch {
      setDraft(null);
      setMode('json');
    }
    setSelected(null);
    setIssues([]);
    setDirty(false);
    setFeedback(null);
  };

  const legacyRules = draft === null ? [] : draft.shape === 'legacy' ? draft.rules : draft.config.legacy;
  const declarativeRules = draft !== null && draft.shape === 'v2' ? draft.config.rules : [];
  const isEmpty = legacyRules.length === 0 && declarativeRules.length === 0;

  const declarativeDisabled = (id: string): boolean => {
    if (draft === null || draft.shape !== 'v2') return false;
    const rule = draft.config.rules.find((entry) => entry.id === id);
    return rule?.enabled === false
      || !draft.config.enabled
      || draft.config.disabled.includes('*')
      || draft.config.disabled.includes(`user/${id}`);
  };

  const row = (ref: RuleRef, title: string, subtitle: string, disabled: boolean, hasIssue: boolean) => (
    <li key={refKey(ref)}>
      <button
        type="button"
        data-hooks-rule={refKey(ref)}
        aria-current={sameRef(selected, ref) ? 'true' : undefined}
        onClick={() => select(ref)}
        className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pr-2 pl-3 text-left"
      >
        <span className="flex max-w-full items-center gap-1.5">
          {hasIssue ? <span className="shrink-0 text-[11px] text-danger" role="img" aria-label={t('st.hooks.rowIssue')}>●</span> : null}
          <span className="truncate text-[13px] text-ink">{title}</span>
          {disabled ? (
            <span className="shrink-0 rounded-sm bg-ink/[0.06] px-1 text-[10.5px] leading-4 text-ink-faint">{t('st.hooks.ruleDisabled')}</span>
          ) : null}
        </span>
        <span className="max-w-full truncate font-mono text-[11px] text-ink-faint" title={subtitle}>{subtitle}</span>
      </button>
    </li>
  );

  const list = (
    <nav aria-label={t('st.hooks.title')} className="space-y-3">
      {isEmpty ? <Hint>{t('st.hooks.empty')}</Hint> : (
        <>
          {declarativeRules.length > 0 ? (
            <section aria-label={t('st.hooks.declarativeGroup')}>
              <p className="flex h-8 items-center px-1 text-[12px] font-medium text-section-ink">{t('st.hooks.declarativeGroup')}</p>
              <ul className="space-y-0.5">
                {declarativeRules.map((rule) => row(
                  { kind: 'declarative', id: rule.id },
                  rule.id,
                  `${t(`st.hooks.v2event.${rule.event}`)} · ${t(`st.hooks.action.${rule.action.type}`)}`,
                  declarativeDisabled(rule.id),
                  issues.some((issue) => sameRef(issue.ref, { kind: 'declarative', id: rule.id })),
                ))}
              </ul>
            </section>
          ) : null}
          {legacyRules.length > 0 ? (
            <section aria-label={t('st.hooks.commandGroup')}>
              <p className="flex h-8 items-center px-1 text-[12px] font-medium text-section-ink">{t('st.hooks.commandGroup')}</p>
              <ul className="space-y-0.5">
                {legacyRules.map((rule, index) => row(
                  { kind: 'legacy', index },
                  t(`st.hooks.event.${rule.event}`),
                  rule.command,
                  false,
                  issues.some((issue) => sameRef(issue.ref, { kind: 'legacy', index })),
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </nav>
  );

  const detail = (() => {
    if (draft === null || selected === null) {
      return isEmpty ? null : <Hint>{t('st.hooks.selectRule')}</Hint>;
    }
    if (selected.kind === 'declarative') {
      const rule = declarativeRules.find((entry) => entry.id === selected.id);
      if (rule === undefined) return <Hint>{t('st.hooks.selectRule')}</Hint>;
      return (
        <DeclarativeRuleEditor
          key={rule.id}
          rule={rule}
          issues={issuesFor(issues, selected)}
          onChange={(patch) => {
            if (draft.shape !== 'v2') return;
            edit(updateDeclarativeRule(draft, rule.id, patch));
            if (patch.id !== undefined && patch.id !== rule.id) setSelected({ kind: 'declarative', id: patch.id });
          }}
          onRemove={() => removeRule(selected)}
        />
      );
    }
    const rule = legacyRules[selected.index];
    if (rule === undefined) return <Hint>{t('st.hooks.selectRule')}</Hint>;
    return (
      <LegacyRuleEditor
        key={selected.index}
        rule={rule}
        ruleLabel={String(selected.index + 1)}
        issues={issuesFor(issues, selected)}
        onChange={(patch) => edit(updateLegacyRule(draft, selected.index, patch))}
        onRemove={() => removeRule(selected)}
      />
    );
  })();

  return (
    <SectionCard id="st-card-hooks" title={t('st.hooks.title')}>
      <div className="space-y-3">
        <Hint>{t('st.hooks.hint')}</Hint>
        {configQuery.isLoading ? <Hint>{t('st.runtime.loading')}</Hint> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <fieldset disabled={saving || configQuery.data === undefined} className="min-w-0 space-y-3">
          {mode === 'json' ? (
            <textarea
              className={`${INPUT} min-h-64 font-mono`}
              value={json}
              aria-label={t('st.hooks.aria')}
              spellCheck={false}
              onChange={(event) => { setJson(event.target.value); setDirty(true); setFeedback(null); }}
            />
          ) : (
            <>
              {draft !== null && draft.shape === 'v2' ? (
                <SettingField label={t('st.hooks.v2Enabled')} help={t('st.hooks.v2EnabledHint')}>
                  <Toggle
                    id="hooks-v2-enabled"
                    layout="bare"
                    label={t('st.hooks.v2Enabled')}
                    checked={draft.config.enabled}
                    onChange={(enabled) => edit(setV2Enabled(draft, enabled))}
                  />
                </SettingField>
              ) : null}
              {isEmpty ? (
                list
              ) : (
                <SettingsDetailLayout
                  narrowPane={narrowPane}
                  list={list}
                  detail={detail === null ? null : (
                    <div className="space-y-4">
                      <button type="button" className={`${SECONDARY_BUTTON} md:hidden`} onClick={() => setNarrowPane('list')}>
                        <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={12} />{t('st.hooks.title')}</span>
                      </button>
                      {detail}
                    </div>
                  )}
                />
              )}
              {draft !== null && draft.shape === 'v2' ? (
                <>
                  <SettingsGroup title={t('st.hooks.filesTitle')} help={t('st.hooks.filesHint')}>
                    <StringListEditor
                      items={draft.config.files}
                      onChange={(files) => edit(setV2Files(draft, files))}
                      addLabel={t('st.hooks.filesAdd')}
                      placeholder="hooks/extra.toml"
                      dataAttr="data-hooks-files"
                    />
                  </SettingsGroup>
                  <SettingsGroup title={t('st.hooks.disabledTitle')} help={t('st.hooks.disabledHint')}>
                    <StringListEditor
                      items={draft.config.disabled}
                      onChange={(ids) => edit(setV2Disabled(draft, ids))}
                      addLabel={t('st.hooks.disabledAdd')}
                      placeholder="user/focus"
                      dataAttr="data-hooks-disabled"
                    />
                  </SettingsGroup>
                </>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {mode === 'form' ? (
              <>
                <button type="button" className={SECONDARY_BUTTON} data-hooks-add-declarative onClick={addDeclarative}>{t('st.hooks.addDeclarative')}</button>
                <button type="button" className={SECONDARY_BUTTON} data-hooks-add-command onClick={addCommand}>{t('st.hooks.add')}</button>
                {draft !== null && draft.shape === 'v2' && canFlattenToLegacy(draft) && draft.config.legacy.length > 0 ? (
                  <button type="button" data-hooks-flatten-legacy onClick={() => edit(flattenToLegacy(draft))}
                    className="inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                    {t('st.hooks.flatten')}
                  </button>
                ) : null}
              </>
            ) : null}
            <button type="button" data-hooks-json-toggle onClick={switchMode}
              className="ml-auto inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11">
              {t(mode === 'json' ? 'st.hooks.form' : 'st.hooks.advanced')}
            </button>
          </div>
          <SettingsDraftFooter
            saved={justSaved}
            id="hooks"
            dirty={dirty}
            saving={saving}
            saveLabel={t('st.hooks.save')}
            onSave={() => void save()}
            onDiscard={discard}
          />
        </fieldset>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

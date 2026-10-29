import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { parseHooksConfigJson } from '@kiki/session-core/settings';
import type { HooksConfig, HookRuleConfig, LegacyHookConfig } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { useAskKiki, useAskKikiWorkspace, AskKikiButton } from '../../askKiki';
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

/** One rule's summary: a legacy command and a declarative text rule share the row. */
interface HookEntry {
  readonly ref: RuleRef;
  readonly event: string;
  readonly declarative?: HookRuleConfig;
  readonly legacy?: LegacyHookConfig;
}

/** The row's fact line: when it runs, then what it does, type as the quiet tail. */
function entrySummary(entry: HookEntry, t: (key: I18nKey) => string): string {
  const event = t(eventLabelKey(entry));
  const action = entry.declarative !== undefined
    ? t(`st.hooks.action.${entry.declarative.action.type}` as I18nKey)
    : t('st.hooks.kind.command');
  return `${event} · ${action}`;
}

/** One event label key for either shape. */
function eventLabelKey(entry: HookEntry): I18nKey {
  return (entry.declarative !== undefined ? `st.hooks.v2event.${entry.event}` : `st.hooks.event.${entry.event}`) as I18nKey;
}

/**
 * The rough event order the list groups by: a session's own lifecycle first,
 * then prompts and turns, then steps and tools, then the rest. Events the map
 * does not know keep config order at the end.
 */
const EVENT_GROUP_ORDER = [
  'session.start', 'SessionStart', 'SessionEnd',
  'prompt.submit', 'UserPromptSubmit', 'UserPromptQueued',
  'TurnStarted', 'turn.after', 'turn.stopping', 'Stop', 'StopFailure', 'Interrupt',
  'step.before', 'step.after',
  'tool.before', 'PreToolUse', 'tool.after', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionResult',
  'SubagentStart', 'SubagentStop', 'TaskStarted',
  'PreCompact', 'PostCompact', 'SessionHeartbeat', 'Notification',
];

function entriesFromDraft(draft: HooksDraft): readonly HookEntry[] {
  const declarative: HookEntry[] = draft.shape === 'v2'
    ? draft.config.rules.map((rule) => ({
        ref: { kind: 'declarative', id: rule.id } as const,
        event: rule.event,
        declarative: rule,
      }))
    : [];
  const legacy: HookEntry[] = (draft.shape === 'legacy' ? draft.rules : draft.config.legacy).map((rule, index) => ({
    ref: { kind: 'legacy', index } as const,
    event: rule.event,
    legacy: rule,
  }));
  return [...declarative, ...legacy];
}

/**
 * Hooks leaf: one list of rules grouped by when they run, with the editor for
 * the selected rule beside it. A legacy command array and a schemaVersion-2
 * object share that one list → detail layout; a rule's kind (text rule vs
 * command rule) is picked inside the editor, not by separate add buttons. The
 * JSON mode edits either shape and round-trips through the same
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
  const { ask: askKiki, busy: askingKiki } = useAskKiki();
  // Hooks writes global config, but the conversation still runs somewhere: the
  // same workspace a plain New conversation here would use.
  const kikiWorkspace = useAskKikiWorkspace();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const entries = useMemo(() => (draft === null ? [] : entriesFromDraft(draft)), [draft]);

  useEffect(() => {
    if (configQuery.data === undefined || dirty) return;
    const raw = JSON.stringify(configQuery.data.hooks ?? [], null, 2);
    setJson(raw);
    try {
      setDraft(draftFromHooks(parseHooksConfigJson(raw)));
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

  // The detail pane always shows something: a selection that no longer points
  // at a rule (fresh load, a removal, a kind switch) falls forward to the
  // first rule, so the right two-thirds is never a blank wall.
  useEffect(() => {
    if (draft === null || entries.length === 0) return;
    if (selected !== null && entries.some((entry) => sameRef(entry.ref, selected))) return;
    setSelected(entries[0]!.ref);
  }, [draft, entries, selected]);

  // One way in: a text rule, which covers the common case. A command rule is
  // the same flow with the kind switched inside the editor.
  const addRule = () => {
    if (draft === null) return;
    const next = addDeclarativeRule(draft.shape === 'v2' ? draft : convertToV2(draft));
    edit(next.draft);
    select(next.ref);
  };

  const convertSelectedToCommand = (id: string) => {
    if (draft === null || draft.shape !== 'v2') return;
    const rule = draft.config.rules.find((entry) => entry.id === id);
    if (rule === undefined) return;
    const legacyRule: LegacyHookConfig = { event: 'PreToolUse', command: '' };
    const config = draft.config;
    const index = config.legacy.length;
    edit({
      shape: 'v2',
      config: { ...config, rules: config.rules.filter((entry) => entry.id !== id), legacy: [...config.legacy, legacyRule] },
    });
    select({ kind: 'legacy', index });
  };

  const convertSelectedToDeclarative = (index: number) => {
    if (draft === null) return;
    const v2 = draft.shape === 'v2' ? draft : convertToV2(draft);
    const rules = draft.shape === 'legacy' ? draft.rules : draft.config.legacy;
    const rule = rules[index];
    if (rule === undefined) return;
    const next = addDeclarativeRule(v2);
    edit(removeLegacyRule(next.draft, index));
    select(next.ref);
  };

  const removeRule = (ref: RuleRef) => {
    if (draft === null) return;
    edit(ref.kind === 'declarative' ? removeDeclarativeRule(draft, ref.id) : removeLegacyRule(draft, ref.index));
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(json);
      setJson(JSON.stringify(parsed, null, 2));
      setFeedback(null);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const resetToSavedJson = () => {
    const raw = JSON.stringify(configQuery.data?.hooks ?? [], null, 2);
    setJson(raw);
    try {
      setDraft(draftFromHooks(parseHooksConfigJson(raw)));
    } catch {
      setDraft(null);
    }
    select(null);
    setDirty(false);
    setFeedback(null);
    setIssues([]);
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
  const isEmpty = entries.length === 0;

  /** A rule the file-level switches mute reads as off; the row can turn it back. */
  const declarativeDisabled = (id: string): boolean => {
    if (draft === null || draft.shape !== 'v2') return false;
    const rule = draft.config.rules.find((entry) => entry.id === id);
    return rule?.enabled === false
      || !draft.config.enabled
      || draft.config.disabled.includes('*')
      || draft.config.disabled.includes(`user/${id}`);
  };

  const row = (entry: HookEntry, disabled: boolean, hasIssue: boolean) => {
    const title = entry.declarative !== undefined
      ? entry.declarative.id
      : entry.legacy !== undefined
        ? (entry.legacy.command.trim() === '' ? t('st.hooks.commandEmpty') : entry.legacy.command)
        : '';
    return (
      <li key={refKey(entry.ref)} className="flex min-w-0 items-center gap-2 pr-1">
        <button
          type="button"
          data-hooks-rule={refKey(entry.ref)}
          aria-current={sameRef(selected, entry.ref) ? 'true' : undefined}
          onClick={() => select(entry.ref)}
          className="row-interactive flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1.5 pr-1 pl-3 text-left"
        >
          <span className="flex max-w-full items-center gap-1.5">
            {hasIssue ? <span className="shrink-0 text-[11px] text-danger" role="img" aria-label={t('st.hooks.rowIssue')}>●</span> : null}
            <span className={`truncate text-[13px] ${entry.legacy !== undefined ? 'font-mono text-[12px]' : ''} text-ink`}>{title}</span>
            {disabled ? (
              <span className="shrink-0 rounded-sm bg-ink/[0.06] px-1 text-[10.5px] leading-4 text-ink-faint">{t('st.hooks.ruleDisabled')}</span>
            ) : null}
          </span>
          <span className="max-w-full truncate text-[11px] text-ink-faint">{entrySummary(entry, t)}</span>
        </button>
        {entry.declarative !== undefined && draft !== null && draft.shape === 'v2' ? (
          // The row's own switch: the primary way one rule is turned off. The
          // file-level disabled list stays under Advanced.
          <span className="shrink-0" data-hooks-row-switch={entry.declarative.id}>
            <Toggle
              layout="bare"
              label={t('st.hooks.ruleRowToggle', { id: entry.declarative.id })}
              checked={entry.declarative.enabled}
              onChange={(enabled) => edit(updateDeclarativeRule(draft, entry.declarative!.id, { enabled }))}
            />
          </span>
        ) : null}
      </li>
    );
  };

  // Grouped by when the rule runs — the user's "when does this fire" — not by
  // which schema shape stores it.
  const groups: { key: string; items: HookEntry[] }[] = [];
  {
    const sorted = [...entries].sort((a, b) => {
      const ai = EVENT_GROUP_ORDER.indexOf(a.event);
      const bi = EVENT_GROUP_ORDER.indexOf(b.event);
      return (ai === -1 ? EVENT_GROUP_ORDER.length : ai) - (bi === -1 ? EVENT_GROUP_ORDER.length : bi);
    });
    for (const entry of sorted) {
      const label = t(eventLabelKey(entry));
      const group = groups.find((candidate) => candidate.key === label);
      if (group !== undefined) group.items.push(entry);
      else groups.push({ key: label, items: [entry] });
    }
  }
  const groupByEvent = groups.length > 1;

  const list = (
    <nav aria-label={t('st.hooks.title')} className="space-y-3">
      {groups.map((group) => (
        <section key={group.key} aria-label={groupByEvent ? group.key : t('st.hooks.title')}>
          {groupByEvent ? <p className="flex h-8 items-center px-1 text-[12px] font-medium text-section-ink">{group.key}</p> : null}
          <ul className="space-y-0.5">
            {group.items.map((entry) => row(
              entry,
              entry.declarative !== undefined && declarativeDisabled(entry.declarative.id),
              issues.some((issue) => issue.ref !== null && sameRef(issue.ref, entry.ref)),
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );

  const detail = (() => {
    if (draft === null || selected === null) {
      return isEmpty ? null : <Hint>{t('st.hooks.selectRule')}</Hint>;
    }
    if (selected.kind === 'declarative') {
      const rule = draft.shape === 'v2' ? draft.config.rules.find((entry) => entry.id === selected.id) : undefined;
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
          onConvertToCommand={() => convertSelectedToCommand(rule.id)}
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
        onConvertToDeclarative={() => convertSelectedToDeclarative(selected.index)}
      />
    );
  })();

  return (
    <SectionCard id="st-card-hooks" title={t('st.hooks.title')} actions={mode === 'form' ? (
      <>
        <AskKikiButton
          label={t('st.hooks.askKiki')}
          labelAria={t('st.hooks.askKikiAria')}
          busy={askingKiki}
          disabled={!kikiWorkspace.resolved}
          testId="data-hooks-ask-kiki"
          onAsk={() => { void askKiki({ skill: 'kiki-hooks', promptKey: 'st.hooks.askKiki.prompt', location: kikiWorkspace.location }); }}
        />
        <button type="button" className={SECONDARY_BUTTON} data-hooks-add disabled={saving || configQuery.data === undefined} onClick={addRule}>{t('st.hooks.addRule')}</button>
      </>
    ) : undefined}>
      <div className="space-y-3">
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
              {isEmpty ? (
                // The empty state teaches the two kinds, then hands over the
                // one way to start.
                <div className="space-y-2 py-2" data-hooks-empty>
                  <Hint>{t('st.hooks.empty')}</Hint>
                  <Hint>{t('st.hooks.emptyBody')}</Hint>
                  <div>
                    <button type="button" className={SECONDARY_BUTTON} data-hooks-add disabled={saving || configQuery.data === undefined} onClick={addRule}>{t('st.hooks.addRule')}</button>
                  </div>
                </div>
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
              {mode === 'form' ? (
                // File-level decisions — where extra rules come from, which ids
                // stay off, the whole-set switch and the raw JSON — are
                // occasional; they open by themselves only when something is
                // already set there.
                <details data-hooks-sources open={draft !== null && draft.shape === 'v2' && (draft.config.files.length > 0 || draft.config.disabled.length > 0) ? true : undefined}
                  className="group pt-3">
                  <summary className="inline-flex min-h-7 cursor-pointer select-none items-center gap-1 text-[12px] font-medium text-ink-soft hover:text-ink pointer-coarse:min-h-11">
                    <Icon name="chevron" size={12} className="text-ink-faint transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                    {t('st.advanced.disclosure')}
                  </summary>
                  <div className="mt-2 space-y-3">
                    {draft !== null && draft.shape === 'v2' ? (
                      <>
                        <SettingField label={t('st.hooks.v2Enabled')} help={t('st.hooks.v2EnabledHint')}>
                          <Toggle
                            id="hooks-v2-enabled"
                            layout="bare"
                            label={t('st.hooks.v2Enabled')}
                            checked={draft.config.enabled}
                            onChange={(enabled) => edit(setV2Enabled(draft, enabled))}
                          />
                        </SettingField>
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
                        {canFlattenToLegacy(draft) && draft.config.legacy.length > 0 ? (
                          <button type="button" data-hooks-flatten-legacy onClick={() => edit(flattenToLegacy(draft))}
                            className="inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                            {t('st.hooks.flatten')}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    <div>
                      <button type="button" data-hooks-json-toggle onClick={switchMode}
                        className="inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                        {t('st.hooks.advanced')}
                      </button>
                    </div>
                  </div>
                </details>
              ) : null}
            </>
          )}
          {mode === 'json' ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={SECONDARY_BUTTON} data-hooks-format-json onClick={formatJson}>
                {t('st.hooks.formatJson')}
              </button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-hooks-reset-json
                onClick={resetToSavedJson}
                disabled={!dirty && json === JSON.stringify(configQuery.data?.hooks ?? [], null, 2)}
              >
                {t('st.hooks.resetJson')}
              </button>
              <button type="button" data-hooks-json-toggle onClick={switchMode}
                className="ml-auto inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11">
                {t('st.hooks.form')}
              </button>
            </div>
          ) : null}
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

/**
 * Add a space to the list, as one panel with two entries: create a new space
 * directory, or attach a folder that already is one. Both live in a SidePanel
 * because adding is a creation flow (overlays/README.md tier 4), and attach is
 * the same question with one field, pushed as the panel's other step.
 *
 * The create form keeps the §9.2 defaults: everything inherits except plugins,
 * and it auto-detects a folder that already holds a space (then the submit
 * becomes "attach").
 */

import { useEffect, useId, useState } from 'react';

import type { CreateSpaceRequest, InspectSpacePathResponse, SpaceRecord } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { SPACE_COLORS, homesApi, isAbsolutePath, suggestSpacePath } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import type { KikiClient } from '../../../lib/client';
import { FeedbackLine, type Feedback } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented } from '../SettingsPrimitives';
import { AdvancedDetails } from '../fields';

type Inherit = NonNullable<CreateSpaceRequest['inherit']>;

/** The §9.2 defaults: everything inherits except plugins. */
const DEFAULT_INHERIT: Required<Inherit> = {
  config: true, credentials: 'shared', agents: true, instructions: true, skills: true,
  mcp: true, appearance: true, plugins: false, generic_roots: true,
};

type RowKey = keyof Inherit;

/**
 * Credentials decides whether this space shares the main space's accounts, so
 * it stays on the first screen. Everything else is cold configuration: a
 * person creating a space has not yet decided to change how plugins or MCP
 * servers behave, and nine rows of it hides the one answer that matters here.
 */
const FIRST_SCREEN_ROWS: readonly { key: RowKey; labelKey: I18nKey }[] = [
  { key: 'credentials', labelKey: 'st.spaces.inh.credentials' },
];
const FOLDED_ROWS: readonly { key: RowKey; labelKey: I18nKey }[] = [
  { key: 'config', labelKey: 'st.spaces.inh.config' },
  { key: 'agents', labelKey: 'st.spaces.inh.agents' },
  { key: 'instructions', labelKey: 'st.spaces.inh.instructions' },
  { key: 'skills', labelKey: 'st.spaces.inh.skills' },
  { key: 'mcp', labelKey: 'st.spaces.inh.mcp' },
  { key: 'appearance', labelKey: 'st.spaces.inh.appearance' },
  { key: 'plugins', labelKey: 'st.spaces.inh.plugins' },
  { key: 'generic_roots', labelKey: 'st.spaces.inh.genericRoots' },
];

/** Segmented choices per row; values are strings so one control shape fits every row. */
function choicesFor(key: RowKey, t: (key: I18nKey) => string): readonly { value: string; label: string }[] {
  if (key === 'credentials') return [{ value: 'shared', label: t('st.spaces.choice.shared') }, { value: 'isolated', label: t('st.spaces.choice.isolated') }];
  if (key === 'instructions') return [
    { value: 'true', label: t('st.spaces.choice.inherit') },
    { value: 'stack', label: t('st.spaces.choice.stack') },
    { value: 'false', label: t('st.spaces.choice.none') },
  ];
  if (key === 'generic_roots') return [{ value: 'true', label: t('st.spaces.choice.visible') }, { value: 'false', label: t('st.spaces.choice.hidden') }];
  return [{ value: 'true', label: t('st.spaces.choice.inherit') }, { value: 'false', label: t('st.spaces.choice.none') }];
}

function encode(value: Inherit[RowKey]): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function decode(key: RowKey, value: string): Inherit[RowKey] {
  if (key === 'credentials') return value as 'shared' | 'isolated';
  if (key === 'instructions' && value === 'stack') return 'stack';
  return value === 'true';
}

/** One panel for both ways to add a space; `mode` picks the step it starts on. */
export function SpaceFormPanel({ client: controlClient, mainPath, canOpen, mode, onClose, onDone }: {
  client?: KikiClient;
  mainPath: string;
  /** Desktop only: the primary action also opens the new space. */
  canOpen: boolean;
  mode: 'create' | 'attach';
  onClose: () => void;
  onDone: (record: SpaceRecord, open: boolean, existing: boolean) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<'create' | 'attach'>(mode);
  const title = t(step === 'create' ? 'st.spaces.createTitle' : 'st.spaces.attachTitle');
  return (
    <SidePanel
      title={title}
      description={step === 'attach' ? t('st.spaces.attachBody') : undefined}
      overlayId="space-form-panel"
      width="lg"
      onClose={onClose}
      data={{ 'data-space-form-panel': step }}
      back={step === 'attach' ? { label: t('st.spaces.createTitle'), onClick: () => { setStep('create'); } } : undefined}
      stepKey={step}
      footer={null}
    >
      {step === 'create'
        ? <SpaceCreateForm client={controlClient} mainPath={mainPath} canOpen={canOpen} onClose={onClose} onDone={onDone} />
        : <SpaceAttachForm client={controlClient} onClose={onClose} onDone={(record) => { onDone(record, false, true); }} />}
    </SidePanel>
  );
}

/** §9.2 as one form: name and color, location, then what the space takes from the main space. */
export function SpaceCreateForm({ client: controlClient, mainPath, canOpen, onClose, onDone }: {
  client?: KikiClient;
  mainPath: string;
  canOpen: boolean;
  onClose: () => void;
  onDone: (record: SpaceRecord, open: boolean, existing: boolean) => void;
}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
  const host = useHost();
  const { t, locale } = useI18n();
  const nameId = useId();
  const pathId = useId();
  const nameIssueId = useId();
  const pathIssueId = useId();
  const formId = useId();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(SPACE_COLORS[0]);
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [inherit, setInherit] = useState<Required<Inherit>>(DEFAULT_INHERIT);
  const [issues, setIssues] = useState<{ name: string | null; path: string | null }>({ name: null, path: null });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const suggested = suggestSpacePath(mainPath, name);
  const effectivePath = pathEdited ? path : suggested;
  const [inspection, setInspection] = useState<{ path: string; state: InspectSpacePathResponse['state'] } | null>(null);
  const pathState = inspection?.path === effectivePath.trim() ? inspection.state : undefined;
  const existingSpace = pathState === 'space';
  const api = homesApi(client);

  useEffect(() => {
    const location = effectivePath.trim();
    if (!isAbsolutePath(location)) return;
    let active = true;
    const timer = setTimeout(() => {
      void api.inspect({ path: location })
        .then(({ state }) => { if (active) setInspection({ path: location, state }); })
        .catch(() => { if (active) setInspection(null); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [api, effectivePath]);

  const submit = () => {
    const nextIssues = {
      name: !existingSpace && name.trim() === '' ? t('st.spaces.nameRequired') : null,
      path: !isAbsolutePath(effectivePath) ? t('st.spaces.pathRequired') : null,
    };
    setIssues(nextIssues);
    if (nextIssues.name !== null || nextIssues.path !== null || busy) return;
    setBusy(true);
    setFeedback(null);
    void api.create({ name: name.trim() || undefined, color, path: effectivePath.trim(), inherit })
      .then((record) => { onDone(record, canOpen, existingSpace); })
      .catch((error: unknown) => {
        setBusy(false);
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const browse = async () => {
    const picked = await host.pickDirectory?.().catch(() => null);
    if (picked !== undefined && picked !== null) {
      setPath(picked);
      setPathEdited(true);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
    <form id={formId} data-space-create className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <fieldset disabled={existingSpace} className={`grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] ${existingSpace ? 'opacity-50' : ''}`}>
          <div className="min-w-0">
            <label htmlFor={nameId} className={FORM_LABEL}>{t('st.spaces.name')}</label>
            <input id={nameId} data-autofocus data-space-name value={name} maxLength={80} autoComplete="off"
              aria-invalid={issues.name !== null} aria-describedby={issues.name !== null ? nameIssueId : undefined}
              onChange={(event) => { setName(event.target.value); setIssues((current) => ({ ...current, name: null })); }}
              className={`${INPUT} mt-1.5 text-[13px]`} />
            <FieldIssue id={nameIssueId} text={issues.name} />
          </div>
          <fieldset className="min-w-0">
            <legend className={FORM_LABEL}>{t('st.spaces.color')}</legend>
            <div className="mt-1.5 flex h-[34px] items-center gap-1" role="radiogroup" aria-label={t('st.spaces.color')}>
              {SPACE_COLORS.map((value, index) => (
                <button key={value} type="button" role="radio" aria-checked={color === value} data-space-color={value}
                  aria-label={t('st.spaces.colorOption', { n: index + 1 })}
                  onClick={() => { setColor(value); }}
                  className={`flex h-7 w-7 items-center justify-center rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-selected-ink/60 ${color === value ? 'ring-2 ring-ink/70 ring-offset-2 ring-offset-panel' : ''}`}>
                  <span aria-hidden className="h-4 w-4 rounded-full" style={{ backgroundColor: value }} />
                </button>
              ))}
            </div>
          </fieldset>
        </fieldset>

        <div className="mt-4">
          <label htmlFor={pathId} className={FORM_LABEL}>{t('st.spaces.location')}</label>
          <div className="mt-1.5 flex gap-2">
            <input id={pathId} data-space-path value={effectivePath} spellCheck={false} autoComplete="off"
              aria-invalid={issues.path !== null} aria-describedby={issues.path !== null ? pathIssueId : undefined}
              onChange={(event) => { setPath(event.target.value); setPathEdited(true); setIssues((current) => ({ ...current, path: null })); }}
              className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`} />
            {host.pickDirectory !== undefined ? (
              <button type="button" data-space-browse className={SECONDARY_BUTTON} onClick={() => { void browse(); }}>{t('st.spaces.browse')}</button>
            ) : null}
          </div>
          <FieldIssue id={pathIssueId} text={issues.path} />
          {pathState === 'nonempty' || existingSpace ? (
            <p role="status" data-space-location-note className="mt-2 text-[12px] leading-relaxed text-ink-soft">
              {t(existingSpace ? 'st.spaces.locationExistingSpace' : 'st.spaces.locationHasContent')}
            </p>
          ) : null}
        </div>

        <fieldset disabled={existingSpace} className={`mt-5 pt-4 ${existingSpace ? 'opacity-50' : ''}`} data-space-inherit>
          <legend className="sr-only">{t('st.spaces.inheritHeading')}</legend>
          <p aria-hidden className="text-[13px] font-medium text-ink">{t('st.spaces.inheritHeading')}</p>
          <div className="mt-2 divide-y divide-hairline">
            {FIRST_SCREEN_ROWS.map((row) => {
              const labelId = `${pathId}-inh-${row.key}`;
              return (
                <div key={row.key} data-space-inherit-row={row.key}
                  className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span id={labelId} className="text-[13px] text-ink">{t(row.labelKey)}</span>
                  <SettingsSegmented<string> ariaLabelledBy={labelId} dataAttr={`data-space-inherit-${row.key}`}
                    value={encode(inherit[row.key])} choices={choicesFor(row.key, t)}
                    onChange={(value) => { setInherit((current) => ({ ...current, [row.key]: decode(row.key, value) })); }} />
                </div>
              );
            })}
          </div>
          {/* The rest of the inheritance is one disclosure: it is how this
              space is wired later, not a decision made while naming it.
              Defaults and payload are unchanged. */}
          <AdvancedDetails summary={t('st.spaces.inheritMore')} data-space-inherit-more className="mt-1">
            <div className="divide-y divide-hairline">
              {FOLDED_ROWS.map((row) => {
                const labelId = `${pathId}-inh-${row.key}`;
                return (
                  <div key={row.key} data-space-inherit-row={row.key}
                    className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span id={labelId} className="text-[13px] text-ink">{t(row.labelKey)}</span>
                    <SettingsSegmented<string> ariaLabelledBy={labelId} dataAttr={`data-space-inherit-${row.key}`}
                      value={encode(inherit[row.key])} choices={choicesFor(row.key, t)}
                      onChange={(value) => { setInherit((current) => ({ ...current, [row.key]: decode(row.key, value) })); }} />
                  </div>
                );
              })}
            </div>
          </AdvancedDetails>
        </fieldset>

        <div className="mt-4"><FeedbackLine feedback={feedback} /></div>
    </form>
    <div className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] -mx-5 -mb-4 mt-4 flex justify-end gap-2 border-t border-hairline bg-panel px-5 py-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" form={formId} data-space-create-submit className={PRIMARY_BUTTON} disabled={busy}>
          {busy ? t('common.saving') : t(existingSpace
            ? canOpen ? 'st.spaces.attachAndOpen' : 'st.spaces.attachConfirm'
            : canOpen ? 'st.spaces.createAndOpen' : 'st.spaces.create')}
        </button>
    </div>
    </div>
  );
}

/** "Add existing space…": registers a folder that already has this main space as its base. */
export function SpaceAttachForm({ client: controlClient, onClose, onDone }: {
  client?: KikiClient;
  onClose: () => void;
  onDone: (record: SpaceRecord) => void;
}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
  const host = useHost();
  const { t, locale } = useI18n();
  const pathId = useId();
  const issueId = useId();
  const formId = useId();
  const [path, setPath] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const submit = () => {
    if (!isAbsolutePath(path)) { setIssue(t('st.spaces.pathRequired')); return; }
    setBusy(true);
    setFeedback(null);
    void homesApi(client).attach({ path: path.trim() })
      .then(onDone)
      .catch((error: unknown) => { setBusy(false); setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  return (
    <div className="flex min-h-full flex-col">
    <form id={formId} data-space-attach className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label htmlFor={pathId} className={FORM_LABEL}>{t('st.spaces.location')}</label>
        <div className="mt-1.5 flex gap-2">
          <input id={pathId} data-autofocus data-space-attach-path value={path} spellCheck={false} autoComplete="off"
            aria-invalid={issue !== null} aria-describedby={issue !== null ? issueId : undefined}
            onChange={(event) => { setPath(event.target.value); setIssue(null); }}
            className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`} />
          {host.pickDirectory !== undefined ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => {
              void host.pickDirectory?.().then((picked) => { if (picked !== null) { setPath(picked); setIssue(null); } }).catch(() => undefined);
            }}>{t('st.spaces.browse')}</button>
          ) : null}
        </div>
        <FieldIssue id={issueId} text={issue} />
        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>
    </form>
    <div className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] -mx-5 -mb-4 mt-4 flex justify-end gap-2 border-t border-hairline bg-panel px-5 py-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" form={formId} data-space-attach-submit className={PRIMARY_BUTTON} disabled={busy}>{busy ? t('common.saving') : t('st.spaces.attachConfirm')}</button>
    </div>
    </div>
  );
}

import { useId, useState } from 'react';

import type { CreateSpaceRequest, SpaceRecord } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { SPACE_COLORS, homesApi, isAbsolutePath, suggestSpacePath } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import type { KikiClient } from '../../../lib/client';
import { FeedbackLine, type Feedback } from '../../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
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

/**
 * §9.2 as one page: name and color, location, then what the space takes from
 * the main space. The "copy once" column of the wireframe is not offered: the
 * create contract only knows inherit or not.
 */
export function CreateSpaceDialog({ client: controlClient, mainPath, canOpen, onClose, onCreated }: {
  client?: KikiClient;
  mainPath: string;
  /** Desktop only: the primary action also opens the new space. */
  canOpen: boolean;
  onClose: () => void;
  onCreated: (record: SpaceRecord, open: boolean) => void;
}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
  const host = useHost();
  const { t, locale } = useI18n();
  const nameId = useId();
  const pathId = useId();
  const nameIssueId = useId();
  const pathIssueId = useId();
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

  const submit = () => {
    const nextIssues = {
      name: name.trim() === '' ? t('st.spaces.nameRequired') : null,
      path: !isAbsolutePath(effectivePath) ? t('st.spaces.pathRequired') : null,
    };
    setIssues(nextIssues);
    if (nextIssues.name !== null || nextIssues.path !== null || busy) return;
    setBusy(true);
    setFeedback(null);
    void homesApi(client).create({ name: name.trim(), color, path: effectivePath.trim(), inherit })
      .then((record) => { onCreated(record, canOpen); })
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
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={t('st.spaces.createTitle')} overlayId="space-create-dialog"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <form data-space-create onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2 className="font-display text-[18px] font-semibold text-ink">{t('st.spaces.createTitle')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
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
        </div>

        <div className="mt-4">
          <label htmlFor={pathId} className={FORM_LABEL}>{t('st.spaces.location')}</label>
          <div className="mt-1.5 flex gap-2">
            <input id={pathId} data-space-path value={effectivePath} spellCheck={false} autoComplete="off"
              aria-invalid={issues.path !== null} aria-describedby={issues.path !== null ? pathIssueId : undefined}
              onChange={(event) => { setPath(event.target.value); setPathEdited(true); setIssues((current) => ({ ...current, path: null })); }}
              className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`} />
            {host.pickDirectory !== undefined ? (
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void browse(); }}>{t('st.spaces.browse')}</button>
            ) : null}
          </div>
          <FieldIssue id={pathIssueId} text={issues.path} />
          {issues.path === null && pathEdited && path !== suggested ? <p className="mt-1 text-[12px] text-ink-faint">{t('st.spaces.locationHint', { path: suggested })}</p> : null}
        </div>

        <fieldset className="mt-5 border-t border-hairline pt-4" data-space-inherit>
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
          {/* The rest of the inheritance, and the always-separate note, are one
              disclosure: they are how this space is wired later, not a
              decision made while naming it. Defaults and payload are unchanged. */}
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
            <p className="mt-2 text-[12px] text-ink-faint">{t('st.spaces.alwaysSeparate')}</p>
          </AdvancedDetails>
        </fieldset>

        <div className="mt-4"><FeedbackLine feedback={feedback} /></div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-space-create-submit className={PRIMARY_BUTTON} disabled={busy}>
            {busy ? t('common.saving') : t(canOpen ? 'st.spaces.createAndOpen' : 'st.spaces.create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

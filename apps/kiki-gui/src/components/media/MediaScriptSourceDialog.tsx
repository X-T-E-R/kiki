/**
 * Add a custom script source — plain fields, one informed consent.
 *
 * A script source is a command the reader already has on this machine, which
 * the media plugin runs for a generation and reads a file path or a JSON
 * answer from. That is the entire model, and it is deliberately not a code
 * editor, a per-invocation approval, or a budget field: a reader who wants
 * the tool to stop and ask about every run should wrap their command, not fill
 * in a second form.
 *
 * What the copy owes the reader, and where it lives:
 *
 *  - The command runs with the reader's own privileges and full network
 *    access, because that is what running a local command means. It is said
 *    once, here, at the moment the reader chooses to trust a command — the
 *    same place the plugin install flow says what a package may do. Repeating
 *    it on every row of the list, or on the source's own detail afterwards,
 *    would be a wall of warnings around a decision already made.
 *  - `environment` is optional and is stored as a secret: it is the place a
 *    key goes, and a key is never read back. An empty one is never written, so
 *    adding a source cannot quietly clear a value a reader set later.
 *
 * A failed save keeps the whole draft. Losing a typed command line to a typo in
 * the id is the kind of small betrayal that makes a form feel hostile, and
 * there is nothing to gain by discarding it.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n, type Locale } from '../../i18n';
import { useMediaScriptSourceAdd, type MediaScriptSourceInput, type MediaSourceWriteResult } from '../../lib/mediaSources';
import { useConnection } from '../../state/connection';
import { FeedbackLine } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

const MEDIA_KINDS = ['image', 'video', 'tts'] as const;

/** The id the host will accept, as a check the reader can see and fix. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

interface Draft {
  readonly id: string;
  readonly label: string;
  readonly kinds: ReadonlySet<string>;
  readonly command: string;
  /** One argument per line: what a shell would take, without a shell. */
  readonly args: string;
  readonly cwd: string;
  readonly protocol: 'file' | 'json';
  readonly format: string;
  readonly mime: string;
  readonly environment: string;
}

const EMPTY: Draft = {
  id: '',
  label: '',
  kinds: new Set<string>(['image']),
  command: '',
  args: '',
  cwd: '',
  protocol: 'file',
  format: '',
  mime: '',
  environment: '',
};

export function MediaScriptSourceDialog({
  onClose,
  onAdded,
}: {
  readonly onClose: () => void;
  /** The new source's provider id, so the page can open it immediately. */
  readonly onAdded: (provider: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const add = useMediaScriptSourceAdd(client);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const id = draft.id.trim();
  const label = draft.label.trim();
  const command = draft.command.trim();
  const kinds = MEDIA_KINDS.filter((kind) => draft.kinds.has(kind));

  /**
   * The client's own complaints, in the reader's terms.
   *
   * Checked here so the reader is told what to fix before the round trip, and
   * the host's own error still wins afterwards: this is a convenience, not a
   * second contract that could disagree with the one it mirrors.
   */
  const issues: readonly string[] = [
    ...(id === '' ? [t('cap.media.script.needId')] : ID_PATTERN.test(id) ? [] : [t('cap.media.script.badId')]),
    ...(label === '' ? [t('cap.media.script.needLabel')] : label.length > 200 ? [t('cap.media.script.longLabel')] : []),
    ...(kinds.length === 0 ? [t('cap.media.script.needKind')] : []),
    ...(command === '' ? [t('cap.media.script.needCommand')] : []),
    ...(issueOf(draft, t)),
  ];
  const ready = issues.length === 0 && !add.pending;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
  };

  const submit = () => {
    if (!ready) return;
    // The write is awaited and rejects when the host refuses, which is what
    // keeps the draft on screen and prints the reason. The catch sits here,
    // at the form, because an unhandled rejection from a submit handler is
    // not a way to report a refused save — and the hook has already recorded
    // it, so the line under the fields is the same either way.
    add.add(toInput(draft), onAdded).catch(() => undefined);
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('cap.media.script.title')}
      overlayId="media-script-source"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[min(92vh,760px)] overflow-y-auto`}
      overlayData={{ 'data-media-script-dialog': '' }}
    >
      <h2 className="font-display text-[18px] leading-6 text-ink">{t('cap.media.script.title')}</h2>
      <p className="mt-1 text-[13px] leading-5 text-ink-soft">{t('cap.media.script.body')}</p>
      {/* The one consent line, said once at the point of trust. A command
          already trusted does not get a warning on its row for the rest of
          its life. */}
      <p className="mt-2 text-[12px] leading-4 text-ink-faint" data-media-script-trust>
        {t('cap.media.script.trust')}
      </p>

      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <div className="grid gap-4 min-[560px]:grid-cols-2">
          <Field id="media-script-id" label={t('cap.media.script.id')}>
            <input
              id="media-script-id"
              data-autofocus
              data-media-script-field="id"
              className={`${INPUT} font-mono`}
              value={draft.id}
              spellCheck={false}
              autoComplete="off"
              placeholder="my-renderer"
              aria-invalid={id !== '' && !ID_PATTERN.test(id)}
              onChange={(event) => { set('id', event.target.value); }}
            />
          </Field>
          <Field id="media-script-label" label={t('cap.media.script.label')}>
            <input
              id="media-script-label"
              data-media-script-field="label"
              className={INPUT}
              value={draft.label}
              placeholder={t('cap.media.script.labelPlaceholder')}
              onChange={(event) => { set('label', event.target.value); }}
            />
          </Field>
        </div>

        <fieldset className="min-w-0" data-media-script-kinds>
          <legend className="text-[12px] font-medium text-ink-soft">{t('cap.media.script.kinds')}</legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {MEDIA_KINDS.map((kind) => (
              <label
                key={kind}
                className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-3 text-[13px] transition-colors ${
                  draft.kinds.has(kind) ? 'bg-ink/[0.08] font-medium text-ink' : 'bg-ink/[0.04] text-ink-soft hover:bg-ink/[0.07]'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  data-media-script-kind={kind}
                  checked={draft.kinds.has(kind)}
                  onChange={(event) => {
                    const next = new Set(draft.kinds);
                    if (event.target.checked) next.add(kind); else next.delete(kind);
                    set('kinds', next);
                  }}
                />
                <span aria-hidden className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border text-[10px] leading-none ${
                  draft.kinds.has(kind) ? 'border-selected-ink bg-selected-ink text-on-accent' : 'border-hairline-strong'
                }`}>
                  {draft.kinds.has(kind) ? '✓' : ''}
                </span>
                {t(`cap.media.kind.${kind}` as Parameters<typeof t>[0])}
              </label>
            ))}
          </div>
        </fieldset>

        <Field id="media-script-command" label={t('cap.media.script.command')}>
          <input
            id="media-script-command"
            data-media-script-field="command"
            className={`${INPUT} font-mono`}
            value={draft.command}
            spellCheck={false}
            autoComplete="off"
            placeholder="python"
            onChange={(event) => { set('command', event.target.value); }}
          />
        </Field>

        <Field id="media-script-args" label={t('cap.media.script.args')} hint={t('cap.media.script.argsHint')}>
          <textarea
            id="media-script-args"
            data-media-script-field="args"
            className={`${INPUT} min-h-[72px] resize-y font-mono`}
            value={draft.args}
            spellCheck={false}
            placeholder={'--model\n--out'}
            onChange={(event) => { set('args', event.target.value); }}
          />
        </Field>

        <div className="grid gap-4 min-[560px]:grid-cols-2">
          <Field id="media-script-cwd" label={t('cap.media.script.cwd')}>
            <input
              id="media-script-cwd"
              data-media-script-field="cwd"
              className={`${INPUT} font-mono`}
              value={draft.cwd}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('cap.media.script.cwdPlaceholder')}
              onChange={(event) => { set('cwd', event.target.value); }}
            />
          </Field>
          <Field id="media-script-protocol" label={t('cap.media.script.protocol')}>
            <select
              id="media-script-protocol"
              data-media-script-field="protocol"
              className={INPUT}
              value={draft.protocol}
              onChange={(event) => { set('protocol', event.target.value === 'json' ? 'json' : 'file'); }}
            >
              <option value="file">{t('cap.media.script.protocolFile')}</option>
              <option value="json">{t('cap.media.script.protocolJson')}</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-4 min-[560px]:grid-cols-2">
          <Field id="media-script-format" label={t('cap.media.script.format')}>
            <input
              id="media-script-format"
              data-media-script-field="format"
              className={`${INPUT} font-mono`}
              value={draft.format}
              spellCheck={false}
              autoComplete="off"
              placeholder="png"
              onChange={(event) => { set('format', event.target.value); }}
            />
          </Field>
          <Field id="media-script-mime" label={t('cap.media.script.mime')}>
            <input
              id="media-script-mime"
              data-media-script-field="mime"
              className={`${INPUT} font-mono`}
              value={draft.mime}
              spellCheck={false}
              autoComplete="off"
              placeholder="image/png"
              onChange={(event) => { set('mime', event.target.value); }}
            />
          </Field>
        </div>

        <Field id="media-script-environment" label={t('cap.media.script.environment')} hint={t('cap.media.script.environmentHint')}>
          <textarea
            id="media-script-environment"
            data-media-script-field="environment"
            className={`${INPUT} min-h-[72px] resize-y font-mono`}
            value={draft.environment}
            spellCheck={false}
            placeholder={'{\n  "RENDER_API_KEY": "…"\n}'}
            onChange={(event) => { set('environment', event.target.value); }}
          />
        </Field>

        {issues.length > 0 ? (
          <ul className="space-y-0.5" role="alert" data-media-script-issues>
            {issues.map((issue) => <li key={issue} className="text-[12px] text-danger">{issue}</li>)}
          </ul>
        ) : null}

        {/* The host's own answer, and the draft is still exactly as typed
            above it: a save that fails costs the reader nothing. */}
        <FeedbackLine feedback={addOutcome(add.outcome, locale, t)} />

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={PRIMARY_BUTTON} disabled={!ready} data-media-script-submit>
            {add.pending ? t('cap.media.saving') : t('cap.media.script.add')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-ink-soft">{label}</label>
      {children}
      {hint !== undefined ? <p className="text-[12px] leading-4 text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** The optional fields' own rules, checked before the round trip. */
function issueOf(draft: Draft, t: ReturnType<typeof useI18n>['t']): readonly string[] {
  const format = draft.format.trim();
  const issues: string[] = [];
  if (format !== '' && !/^[a-z0-9]+$/.test(format)) issues.push(t('cap.media.script.badFormat'));
  if (draft.environment.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(draft.environment);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) issues.push(t('cap.media.script.badEnvironment'));
      else if (Object.values(parsed).some((value) => typeof value !== 'string')) issues.push(t('cap.media.script.badEnvironment'));
    } catch {
      issues.push(t('cap.media.script.badEnvironment'));
    }
  }
  return issues;
}

/**
 * The draft as the host's own input shape.
 *
 * Optional fields are omitted rather than sent empty: an empty `format` is a
 * value the runtime would have to guess about, and an empty `environment`
 * would be a write that could clear something. The command is passed as its
 * own value, never through a shell, so an argument containing a space stays
 * one argument.
 */
export function toInput(draft: Draft): MediaScriptSourceInput {
  const args = draft.args.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const environment = draft.environment.trim();
  const parsedEnvironment = environment === '' ? undefined : JSON.parse(environment) as Record<string, string>;
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    kinds: MEDIA_KINDS.filter((kind) => draft.kinds.has(kind)) as MediaScriptSourceInput['kinds'],
    command: draft.command.trim(),
    ...(args.length === 0 ? {} : { args }),
    ...(draft.cwd.trim() === '' ? {} : { cwd: draft.cwd.trim() }),
    protocol: draft.protocol,
    ...(draft.format.trim() === '' ? {} : { format: draft.format.trim() }),
    ...(draft.mime.trim() === '' ? {} : { mime: draft.mime.trim() }),
    ...(parsedEnvironment === undefined ? {} : { environment: parsedEnvironment }),
  };
}

function addOutcome(
  outcome: MediaSourceWriteResult | null,
  locale: Locale,
  t: ReturnType<typeof useI18n>['t'],
): { tone: 'success' | 'error'; text: string } | null {
  if (outcome === null) return null;
  if (!outcome.ok) return { tone: 'error', text: errorText(locale, outcome.error) };
  return { tone: 'success', text: t('cap.media.script.added', { label: outcome.source.label }) };
}

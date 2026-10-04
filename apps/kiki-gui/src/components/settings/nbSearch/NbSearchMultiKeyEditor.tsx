/**
 * Multi-key editor for one search service.
 *
 * The engine stores a provider's keys as one ordered, comma-separated value in
 * a single environment variable, so this field keeps the same transaction shape
 * as `SecretField`: `keep` leaves the stored value alone, `set` writes the keys
 * currently listed, `clear` removes the value saved in Kiki. Revealing a stored
 * value is a read-only peek; editing it is an explicit step, so looking at the
 * keys never marks the page dirty.
 *
 * Rows stay flat: hairline separators and whitespace carry the grouping, no
 * rounded surface per key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NbSearchManagedCredentialView, SecretSource } from '@kiki/protocol';
import {
  NB_SEARCH_MAX_KEYS,
  formatMultiKey,
  parseMultiKey,
  validateKeyList,
} from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { copyTextToClipboard } from '../../../lib/clipboard';
import { Icon } from '../../icons';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { SECRET_ICON_BUTTON, SECRET_MASK, SecretSourceLine, type SecretDraft } from '../SecretField';
import { FieldIssue } from '../SettingsPrimitives';

export interface KeyDraftBase {
  readonly version: string;
  readonly binding: string;
}

export type KeyDraft =
  | { readonly mode: 'keep' }
  | { readonly mode: 'set'; readonly keys: readonly string[]; readonly base?: KeyDraftBase }
  | { readonly mode: 'clear'; readonly base?: KeyDraftBase };

export const KEEP_KEYS: KeyDraft = { mode: 'keep' };

/** The transaction shape `SecretField` understands, for callers that share one. */
export function keyDraftToSecretDraft(draft: KeyDraft): SecretDraft {
  if (draft.mode === 'set') return { mode: 'set', value: formatMultiKey(draft.keys) };
  return draft;
}

/** The keys a pending write would store, or `null` for "clear". */
export function pendingKeyValue(draft: KeyDraft): string | null | undefined {
  if (draft.mode === 'keep') return undefined;
  if (draft.mode === 'clear') return null;
  const keys = parseMultiKey(formatMultiKey(draft.keys));
  return keys.length === 0 ? undefined : formatMultiKey(keys);
}

export interface KeyValidation {
  readonly ok: boolean;
  readonly message: string | null;
}

/** Save-blocking problems with a key list, phrased for the field that owns it. */
export function keyDraftIssue(t: ReturnType<typeof useI18n>['t'], draft: KeyDraft): string | null {
  if (draft.mode !== 'set') return null;
  const report = validateKeyList(draft.keys);
  if (report.empty) return t('st.nbSearch.keys.emptyKey');
  if (report.tooMany) {
    return t('st.nbSearch.keys.tooMany', {
      count: draft.keys.length,
      max: NB_SEARCH_MAX_KEYS,
      extra: draft.keys.length - NB_SEARCH_MAX_KEYS,
    });
  }
  if (report.duplicates.length > 0) return t('st.nbSearch.keys.duplicate');
  return null;
}

export function useKeyValidation(draft: KeyDraft): KeyValidation {
  const { t } = useI18n();
  const message = keyDraftIssue(t, draft);
  return { ok: message === null, message };
}

const TEXT_BUTTON = `${SECONDARY_BUTTON} min-h-8 pointer-coarse:min-h-11`;
const ICON_BUTTON = `${SECRET_ICON_BUTTON} h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11`;

export function NbSearchMultiKeyEditor({
  instanceId,
  source,
  envName,
  draft,
  onChange,
  read,
  disabled = false,
}: {
  instanceId: string;
  source: SecretSource;
  envName?: string;
  draft: KeyDraft;
  onChange: (draft: KeyDraft) => void;
  /** Reveals the effective stored value, on explicit request only. */
  read: (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<readonly string[] | null>(null);
  const [revealFailed, setRevealFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const request = useRef(0);
  const observedBase = useRef<KeyDraftBase | undefined>(undefined);

  const validation = useKeyValidation(draft);

  // A different service, or a finished save, makes any peeked value stale.
  useEffect(() => {
    request.current++;
    observedBase.current = undefined;
    setRevealed(null);
    setRevealFailed(false);
    setNewKey('');
    setShown(new Set());
    setBusy(false);
  }, [instanceId, source, envName]);
  useEffect(() => {
    if (draft.mode !== 'keep') return;
    request.current++;
    observedBase.current = undefined;
    setRevealed(null);
    setShown(new Set());
    setBusy(false);
  }, [draft.mode]);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => { setCopied(null); }, 1600);
    return () => { clearTimeout(timer); };
  }, [copied]);

  const hasStored = source !== 'none';
  const editing = draft.mode === 'set';
  const rows: readonly string[] = editing ? draft.keys : (revealed ?? []);
  const showRows = editing || revealed !== null;

  const reveal = useCallback(async () => {
    const revision = ++request.current;
    setBusy(true);
    setRevealFailed(false);
    try {
      const view = await read(instanceId, true);
      if (request.current !== revision) return;
      const base = { version: view.version, binding: view.binding_version };
      observedBase.current = base;
      setRevealed(view.value === undefined ? [] : parseMultiKey(view.value));
      // Explicit rereading accepts a new server base, not a replacement of the user's pending keys.
      if (draft.mode !== 'keep') onChange({ ...draft, base });
    } catch {
      if (request.current === revision) setRevealFailed(true);
    } finally {
      if (request.current === revision) setBusy(false);
    }
  }, [instanceId, read, draft, onChange]);

  const startEdit = async (mode: 'set' | 'clear') => {
    const revision = ++request.current;
    setBusy(true);
    setRevealFailed(false);
    try {
      let base = observedBase.current;
      if (base === undefined) {
        const view = await read(instanceId, false);
        if (request.current !== revision) return;
        base = { version: view.version, binding: view.binding_version };
        observedBase.current = base;
      }
      onChange(mode === 'set' ? { mode, keys: revealed ?? [], base } : { mode, base });
    } catch {
      if (request.current === revision) setRevealFailed(true);
    } finally {
      if (request.current === revision) setBusy(false);
    }
  };

  const write = (keys: readonly string[]) => {
    onChange({ mode: 'set', keys, base: draft.mode === 'set' ? draft.base : observedBase.current });
  };

  const addKeys = () => {
    const additions = parseMultiKey(newKey);
    if (additions.length === 0) return;
    const base = editing ? draft.keys : (revealed ?? []);
    // A key the user just pasted stays readable: masking their own input hides
    // a typo they are still in a position to fix.
    const added = additions.map((_, offset) => base.length + offset);
    write([...base, ...additions]);
    setShown((current) => new Set([...current, ...added]));
    setNewKey('');
  };

  const removeKey = (index: number) => {
    const next = [...rows];
    next.splice(index, 1);
    write(next);
  };

  const moveKey = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const item = next[from];
    if (item === undefined) return;
    next.splice(from, 1);
    next.splice(to, 0, item);
    write(next);
  };

  const toggleShown = (index: number) => {
    setShown((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const copy = (index: number, key: string) => {
    void copyTextToClipboard(key).then(() => { setCopied(index); }, () => { setCopied(null); });
  };

  const canAdd = rows.length < NB_SEARCH_MAX_KEYS;
  const countText = t('st.nbSearch.keys.count', { count: rows.length, max: NB_SEARCH_MAX_KEYS });

  return (
    <div className="min-w-0 space-y-2" data-nb-search-keys={instanceId} data-keys-mode={draft.mode}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-ink">{t('st.nbSearch.keys.label')}</span>
        {showRows ? (
          <span className="text-[12px] tabular-nums text-ink-faint" data-keys-count>{countText}</span>
        ) : null}
      </div>

      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-snug">
        <SecretSourceLine source={source} envName={envName} />
        {draft.mode === 'clear' ? <span className="text-amber-ink">· {t('st.secret.clearPending')}</span> : null}
        {editing ? <span className="text-ink-faint">· {t('st.nbSearch.keys.editingHint')}</span> : null}
        {revisedRowsHint(rows, editing) ? (
          <span className="text-ink-faint">· {t('st.nbSearch.keys.orderHint')}</span>
        ) : null}
        {revealFailed ? <span role="alert" className="text-danger">· {t('st.nbSearch.keys.showFailed')}</span> : null}
      </p>

      {showRows ? (
        rows.length === 0 ? (
          <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.keys.empty')}</p>
        ) : (
          <ul className="min-w-0 border-t border-hairline" role="list">
            {rows.map((key, index) => (
              <li
                // Position is the identity here: the same key may legitimately
                // repeat while the user is editing, and order is the value.
                key={index}
                data-key-row={index}
                className="flex min-w-0 items-center gap-2 border-b border-hairline py-1 pl-1 pr-1 last:border-b-0"
              >
                <span aria-hidden className="w-5 shrink-0 text-[11px] tabular-nums text-ink-faint">
                  {index + 1}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[12px] ${shown.has(index) ? 'select-all text-ink' : 'tracking-[0.12em] text-ink-soft'}`}
                  data-key-value={shown.has(index) ? 'visible' : 'masked'}
                >
                  {shown.has(index) ? key : SECRET_MASK}
                </span>
                <span className="flex shrink-0 items-center">
                  {editing && rows.length > 1 ? (
                    <>
                      <button type="button" className={ICON_BUTTON} disabled={disabled || busy || index === 0}
                        aria-label={t('st.nbSearch.keys.moveUp', { n: index + 1 })}
                        title={t('st.nbSearch.keys.moveUp', { n: index + 1 })}
                        data-key-up={index} onClick={() => { moveKey(index, index - 1); }}>
                        <Icon name="arrowUp" size={12} />
                      </button>
                      <button type="button" className={ICON_BUTTON} disabled={disabled || busy || index === rows.length - 1}
                        aria-label={t('st.nbSearch.keys.moveDown', { n: index + 1 })}
                        title={t('st.nbSearch.keys.moveDown', { n: index + 1 })}
                        data-key-down={index} onClick={() => { moveKey(index, index + 1); }}>
                        <Icon name="arrowDown" size={12} />
                      </button>
                    </>
                  ) : null}
                  <button type="button" className={ICON_BUTTON} disabled={disabled || busy}
                    aria-pressed={shown.has(index)}
                    aria-label={t(shown.has(index) ? 'st.nbSearch.keys.hide' : 'st.nbSearch.keys.reveal', { n: index + 1 })}
                    title={t(shown.has(index) ? 'st.nbSearch.keys.hide' : 'st.nbSearch.keys.reveal', { n: index + 1 })}
                    data-key-reveal={index} onClick={() => { toggleShown(index); }}>
                    <Icon name={shown.has(index) ? 'eyeOff' : 'eye'} size={12} />
                  </button>
                  <button type="button" className={ICON_BUTTON} disabled={disabled || busy}
                    aria-label={t('st.secret.copyLabel', { label: t('st.nbSearch.keys.label') })}
                    title={t('st.secret.copyLabel', { label: t('st.nbSearch.keys.label') })}
                    data-key-copy={index} onClick={() => { copy(index, key); }}>
                    <Icon name={copied === index ? 'check' : 'copy'} size={12} className={copied === index ? 'text-success' : ''} />
                  </button>
                  {editing ? (
                    <button type="button" className={`${ICON_BUTTON} hover:text-danger`} disabled={disabled || busy}
                      aria-label={t('st.nbSearch.keys.remove', { n: index + 1 })}
                      title={t('st.nbSearch.keys.remove', { n: index + 1 })}
                      data-key-remove={index} onClick={() => { removeKey(index); }}>
                      <Icon name="close" size={12} />
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {validation.message !== null ? <FieldIssue id={`${instanceId}-keys-issue`} text={validation.message} /> : null}

      {editing ? (
        <button type="button" className={TEXT_BUTTON} disabled={disabled || busy}
          data-key-show onClick={() => { void reveal(); }}>
          {busy ? t('st.nbSearch.keys.loading') : t('st.nbSearch.keys.show')}
        </button>
      ) : null}

      {editing || !hasStored ? (
        canAdd ? (
          <div className="flex min-w-0 items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              disabled={disabled || busy}
              value={newKey}
              aria-label={t('st.nbSearch.keys.placeholder')}
              placeholder={t('st.nbSearch.keys.placeholder')}
              data-key-input
              className={`${INPUT} min-w-0 flex-1 font-mono`}
              onChange={(event) => { setNewKey(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addKeys();
              }}
            />
            <button type="button" className={TEXT_BUTTON} disabled={disabled || busy || newKey.trim() === ''}
              data-key-add onClick={addKeys}>
              {t('st.nbSearch.keys.add')}
            </button>
          </div>
        ) : null
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={TEXT_BUTTON} disabled={disabled || busy}
            data-key-show onClick={() => { void reveal(); }}>
            {busy ? t('st.nbSearch.keys.loading') : t('st.nbSearch.keys.show')}
          </button>
          <button type="button" className={TEXT_BUTTON} disabled={disabled || busy}
            data-key-replace onClick={() => { void startEdit('set'); }}>
            {t('st.nbSearch.keys.replace')}
          </button>
          {source === 'kiki' ? (
            <button type="button" className={TEXT_BUTTON} disabled={disabled || busy}
              data-key-clear onClick={() => { void startEdit('clear'); }}>
              {t('st.secret.clear')}
            </button>
          ) : null}
        </div>
      )}

      {draft.mode === 'clear' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[12px] text-amber-ink">{t('st.secret.clearPending')}</span>
          <button type="button" className={TEXT_BUTTON} disabled={disabled || busy}
            data-key-undo onClick={() => { onChange(KEEP_KEYS); }}>
            {t('st.secret.undoClear')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function revisedRowsHint(rows: readonly string[], editing: boolean): boolean {
  return editing && rows.length > 1;
}

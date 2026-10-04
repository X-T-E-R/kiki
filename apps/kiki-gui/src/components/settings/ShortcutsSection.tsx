/**
 * Settings › Shortcuts: every remappable action with its current chords, per
 * client platform. Click a chord to record a new one (Esc cancels, Backspace
 * disables the action), reset one row, or reset the whole platform. Writes go
 * to the connected server's `gui.toml` (`shortcuts.v1`) and land in the
 * runtime store at once, so the keys work before the page is left.
 *
 * Conflicts are checked here first with the same rules the server applies, so a
 * clash is named before anything is sent. The server remains the authority: it
 * validates every platform, so its `details.conflicts` rejection is mapped back
 * onto the offending row instead of showing the raw envelope message.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { ApiError } from '@kiki/session-core/transport';
import {
  SHORTCUT_CATALOG,
  SHORTCUT_DEFINITIONS,
  detectShortcutConflicts,
  shortcutPreferencesSchema,
  type ShortcutAction,
  type ShortcutChord,
  type ShortcutConflict,
  type ShortcutDefinition,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@kiki/session-core/settings/shortcuts';
import { shortcutConflictSchema, type ShortcutResponse } from '@kiki/protocol';
import { settingsServerSnapshot, settingsSnapshot, subscribeSettings } from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  applyShortcutPreferences,
  beginShortcutRecording,
  chordFromEvent,
  chordKeys,
  detectShortcutPlatform,
  sameChord,
} from '../../lib/shortcuts';
import { SHORTCUTS_QUERY_KEY } from '../../lib/useShortcutPreferences';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const PLATFORMS: readonly ShortcutPlatform[] = ['windows', 'macos', 'linux'];
const PLATFORM_LABEL: Record<ShortcutPlatform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

type Context = ShortcutDefinition['context'];
const CONTEXT_ORDER: readonly Context[] = ['global', 'session', 'composer', 'approval', 'terminal'];
const CONTEXT_TITLE: Record<Context, I18nKey> = {
  global: 'shortcuts.group.global',
  session: 'shortcuts.group.session',
  composer: 'st.shortcuts.group.composer',
  approval: 'shortcuts.group.approvals',
  terminal: 'shortcuts.group.terminal',
};

/** Labels the catalog shares between two actions get a disambiguating line. */
const ACTION_NOTE: Partial<Record<ShortcutAction, I18nKey>> = {
  shortcuts: 'st.shortcuts.note.anywhere',
  'shortcuts-help': 'st.shortcuts.note.outsideFields',
  approve: 'st.shortcuts.note.outsideFields',
  reject: 'st.shortcuts.note.outsideFields',
};

function withOverride(
  preferences: ShortcutPreferences,
  platform: ShortcutPlatform,
  action: ShortcutAction,
  chords: readonly ShortcutChord[],
): ShortcutPreferences {
  const next = shortcutPreferencesSchema.parse(structuredClone(preferences));
  next.overrides[platform] = { ...next.overrides[platform], [action]: [...chords] };
  return next;
}

/** Recording target: replace chord `index`, or append when `index` is the length. */
interface Recording {
  readonly action: ShortcutAction;
  readonly index: number;
}

interface RowIssue {
  readonly action: ShortcutAction;
  readonly text: string;
}

export function conflictText(
  conflicts: readonly ShortcutConflict[],
  action: ShortcutAction,
  chord: ShortcutChord,
  platform: ShortcutPlatform,
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
): string | null {
  const keys = chordKeys(chord, platform).join('+');
  const mine = conflicts.filter((conflict) => conflict.actions.includes(action));
  const reserved = mine.find((conflict) => conflict.kind === 'reserved');
  if (reserved !== undefined) return t('st.shortcuts.conflictReserved', { keys });
  const other = mine.find((conflict) => conflict.kind === 'duplicate' && conflict.actions.length === 2);
  if (other !== undefined) {
    const otherId = other.actions.find((candidate) => candidate !== action) ?? action;
    const labelKey = SHORTCUT_DEFINITIONS.find((definition) => definition.id === otherId)?.labelKey;
    return t('st.shortcuts.conflictUsed', { keys, action: labelKey === undefined ? otherId : t(labelKey as I18nKey) });
  }
  if (mine.length > 0) return t('st.shortcuts.conflictSelf', { keys });
  return null;
}

/**
 * The conflicts a rejected write or reset carries in `details.conflicts`
 * (kap-server answers `VALIDATION_FAILED` with them). A response without them —
 * an older server, a different failure — yields an empty list, and the caller
 * falls back to the envelope message.
 */
export function rejectedConflicts(error: unknown): readonly ShortcutConflict[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details;
  if (details === null || typeof details !== 'object' || !('conflicts' in details)) return [];
  const parsed = shortcutConflictSchema.array().safeParse(details.conflicts);
  return parsed.success ? parsed.data : [];
}

/**
 * Server-side text for the clash that involves `action`. The server checks
 * every platform, so its conflicts can name a platform other than the one on
 * screen; those are reported after the edited platform's own. The chord comes
 * back as a bare key, which is all the rejection carries.
 */
export function serverConflictText(
  conflicts: readonly ShortcutConflict[],
  action: ShortcutAction,
  platform: ShortcutPlatform,
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
): string | null {
  const mine = conflicts.filter((conflict) => conflict.actions.includes(action));
  const conflict = mine.find((candidate) => candidate.platform === platform) ?? mine[0];
  if (conflict === undefined) return null;
  if (conflict.kind === 'reserved') return t('st.shortcuts.conflictReserved', { keys: conflict.key });
  const otherId = conflict.actions.find((candidate) => candidate !== action);
  if (otherId === undefined) return t('st.shortcuts.conflictSelf', { keys: conflict.key });
  const labelKey = SHORTCUT_DEFINITIONS.find((definition) => definition.id === otherId)?.labelKey;
  return t('st.shortcuts.conflictUsed', {
    keys: conflict.key,
    action: labelKey === undefined ? otherId : t(labelKey as I18nKey),
  });
}

export function ShortcutsSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const host = useHost();
  const desktop = host.kind === 'tauri';
  const queryClient = useQueryClient();
  const ownPlatform = useMemo(detectShortcutPlatform, []);
  const [platform, setPlatform] = useState<ShortcutPlatform>(ownPlatform);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [issue, setIssue] = useState<RowIssue | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, ping] = useSavedTick();
  const [error, setError] = useState<Feedback>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Clashes the server reported on the last rejected write, so the rows they
  // name stay marked until the next accepted write.
  const [rejected, setRejected] = useState<readonly ShortcutConflict[]>([]);

  const query = useQuery({
    queryKey: [...SHORTCUTS_QUERY_KEY, platform],
    queryFn: () => client.readShortcuts(platform),
    staleTime: 60_000,
    retry: false,
  });

  const accept = (response: ShortcutResponse) => {
    // Every platform's answer carries the full preferences; the query for
    // the other platforms re-resolves from them on next read.
    queryClient.setQueryData([...SHORTCUTS_QUERY_KEY, platform], response);
    void queryClient.invalidateQueries({ queryKey: SHORTCUTS_QUERY_KEY, predicate: (entry) => entry.queryKey[1] !== platform });
    applyShortcutPreferences(response.preferences);
  };

  const commit = async (
    write: () => Promise<ShortcutResponse>,
    target?: { readonly action: ShortcutAction },
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      accept(await write());
      setRejected([]);
      ping();
      return true;
    } catch (cause) {
      const conflicts = rejectedConflicts(cause);
      setRejected(conflicts);
      const text = target === undefined ? null : serverConflictText(conflicts, target.action, platform, t);
      if (target !== undefined && text !== null) {
        setIssue({ action: target.action, text });
        return false;
      }
      setIssue(null);
      setError({ tone: 'error', text: errorText(locale, cause) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const data = query.data;
  const preferences = data?.preferences;
  const bindings = data?.bindings;

  const setChords = async (action: ShortcutAction, chords: readonly ShortcutChord[], recorded?: ShortcutChord) => {
    if (preferences === undefined) return;
    const next = withOverride(preferences, platform, action, chords);
    const conflicts = detectShortcutConflicts(next, platform);
    const text = recorded === undefined ? null : conflictText(conflicts, action, recorded, platform, t);
    if (text !== null || conflicts.some((conflict) => conflict.actions.includes(action))) {
      setIssue({ action, text: text ?? t('st.shortcuts.conflictGeneric') });
      return;
    }
    setIssue(null);
    await commit(() => client.writeShortcuts(platform, next), { action });
  };

  const record = (target: Recording, chord: ShortcutChord) => {
    setRecording(null);
    const current = bindings?.[target.action] ?? [];
    if (current.some((existing, index) => index !== target.index && sameChord(existing, chord))) {
      setIssue({ action: target.action, text: t('st.shortcuts.conflictSelf', { keys: chordKeys(chord, platform).join('+') }) });
      return;
    }
    const chords = [...current];
    chords.splice(target.index, target.index < current.length ? 1 : 0, chord);
    void setChords(target.action, chords, chord);
  };

  const removeChord = (action: ShortcutAction, index: number) => {
    const chords = (bindings?.[action] ?? []).filter((_, position) => position !== index);
    void setChords(action, chords);
  };

  const resetAction = (action: ShortcutAction) => {
    setIssue(null);
    void commit(() => client.resetShortcuts(platform, { platform, action }), { action });
  };

  const resetPlatform = () => {
    setConfirmReset(false);
    setIssue(null);
    void commit(() => client.resetShortcuts(platform, { platform }));
  };

  const overridden = (action: ShortcutAction) => preferences?.overrides[platform]?.[action] !== undefined;
  const anyOverride = Object.keys(preferences?.overrides[platform] ?? {}).length > 0;
  const serverConflicts = [...(data?.conflicts ?? []), ...rejected];

  const grouped = CONTEXT_ORDER.map((context) => ({
    context,
    definitions: SHORTCUT_DEFINITIONS.filter((definition) => definition.context === context),
  })).filter((group) => group.definitions.length > 0);

  return (
    <>
      <SectionCard id="st-card-shortcuts" title={t('st.shortcuts.title')} scope="server">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="mr-auto max-w-[52ch] text-[13px] leading-5 text-ink-soft">{t('st.shortcuts.intro')}</p>
            <SaveStatus saving={saving} saved={saved} />
            <SettingsSegmented<ShortcutPlatform>
              ariaLabel={t('st.shortcuts.platform')}
              dataAttr="data-shortcut-platform"
              value={platform}
              onChange={(next) => { setPlatform(next); setRecording(null); setIssue(null); setError(null); }}
              choices={PLATFORMS.map((value) => ({
                value,
                label: value === ownPlatform ? t('st.shortcuts.platformThis', { name: PLATFORM_LABEL[value] }) : PLATFORM_LABEL[value],
              }))}
            />
          </div>
          {platform !== ownPlatform ? (
            <p data-shortcut-other-platform className="text-[12px] text-ink-faint">
              {t('st.shortcuts.otherPlatform', { name: PLATFORM_LABEL[platform] })}
            </p>
          ) : null}
          {query.isLoading ? <Hint>{t('st.shortcuts.loading')}</Hint> : null}
          {query.isError ? (
            <div className="space-y-1">
              <InlineError error={query.error} />
              <Hint>{t('st.shortcuts.loadFailed')}</Hint>
            </div>
          ) : null}
          {bindings !== undefined ? grouped.map((group) => (
            <div key={group.context} data-shortcut-group={group.context}>
              <p className="pb-1 text-[12px] font-medium text-section-ink">{t(CONTEXT_TITLE[group.context])}</p>
              <ul className="divide-y divide-hairline border-y border-hairline">
                {group.definitions.map((definition) => (
                  <ShortcutRow
                    key={definition.id}
                    definition={definition}
                    platform={platform}
                    chords={bindings[definition.id] ?? []}
                    overridden={overridden(definition.id)}
                    desktop={desktop}
                    busy={saving}
                    recordingIndex={recording?.action === definition.id ? recording.index : null}
                    issue={issue?.action === definition.id ? issue.text : null}
                    serverConflict={serverConflicts.some((conflict) => conflict.actions.includes(definition.id))}
                    onRecord={(index) => { setIssue(null); setError(null); setRecording({ action: definition.id, index }); }}
                    onRecorded={(chord) => { if (recording !== null) record(recording, chord); }}
                    onCancel={() => { setRecording(null); }}
                    onRemove={(index) => { removeChord(definition.id, index); }}
                    onReset={() => { resetAction(definition.id); }}
                  />
                ))}
              </ul>
            </div>
          )) : null}
          <FeedbackLine feedback={error} />
          {bindings !== undefined ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button type="button" data-shortcut-reset-all className={SECONDARY_BUTTON}
                disabled={saving || !anyOverride} onClick={() => { setConfirmReset(true); }}>
                {t('st.shortcuts.resetAll', { name: PLATFORM_LABEL[platform] })}
              </button>
              {!anyOverride ? <span className="text-[12px] text-ink-faint">{t('st.shortcuts.allDefault')}</span> : null}
            </div>
          ) : null}
        </div>
        <ConfirmDialog
          open={confirmReset}
          overlayId="confirm-shortcuts-reset"
          title={t('st.shortcuts.resetAllTitle', { name: PLATFORM_LABEL[platform] })}
          body={t('st.shortcuts.resetAllBody', { name: PLATFORM_LABEL[platform] })}
          confirmLabel={t('st.shortcuts.resetAll', { name: PLATFORM_LABEL[platform] })}
          busy={saving}
          onConfirm={resetPlatform}
          onCancel={() => { setConfirmReset(false); }}
        />
      </SectionCard>
      <FixedKeysCard platform={platform} desktop={desktop} />
    </>
  );
}

function Keycaps({ keys }: { keys: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className="min-w-[1.4rem] rounded-[4px] border border-hairline bg-paper px-1.5 py-px text-center font-mono text-[11px] font-medium text-ink shadow-[0_1px_0_var(--color-hairline-strong)]">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  definition, platform, chords, overridden, desktop, busy, recordingIndex, issue, serverConflict,
  onRecord, onRecorded, onCancel, onRemove, onReset,
}: {
  definition: ShortcutDefinition;
  platform: ShortcutPlatform;
  chords: readonly ShortcutChord[];
  overridden: boolean;
  desktop: boolean;
  busy: boolean;
  recordingIndex: number | null;
  issue: string | null;
  serverConflict: boolean;
  onRecord: (index: number) => void;
  onRecorded: (chord: ShortcutChord) => void;
  onCancel: () => void;
  onRemove: (index: number) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const label = t(definition.labelKey as I18nKey);
  const note = ACTION_NOTE[definition.id];
  const issueId = `shortcut-issue-${definition.id}`;
  const canAdd = chords.length < 4 && recordingIndex === null;
  return (
    <li data-shortcut-row={definition.id} data-shortcut-overridden={overridden ? 'true' : 'false'}
      className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:pt-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink">
          <span>{label}</span>
          {overridden ? (
            <span data-shortcut-custom className="inline-flex items-center gap-1 text-[11.5px] text-selected-ink">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-selected-ink" />
              {t('st.shortcuts.custom')}
            </span>
          ) : null}
          {definition.desktopOnly && !desktop ? <span className="text-[11.5px] text-ink-faint">{t('shortcuts.desktopOnly')}</span> : null}
        </p>
        {note !== undefined ? <p className="text-[12px] text-ink-faint">{t(note)}</p> : null}
        {serverConflict && issue === null ? <p className="text-[12px] text-amber-ink">{t('st.shortcuts.savedConflict')}</p> : null}
        {issue !== null ? <p id={issueId} role="alert" data-shortcut-issue className="mt-0.5 text-[12px] text-danger">{issue}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
        {chords.length === 0 && recordingIndex === null ? (
          <span data-shortcut-disabled className="text-[12px] text-ink-faint">{t('st.shortcuts.disabled')}</span>
        ) : null}
        {chords.map((chord, index) => recordingIndex === index ? (
          <ChordRecorder key={`rec-${index}`} platform={platform} describedBy={issue === null ? undefined : issueId}
            onRecorded={onRecorded} onCancel={onCancel} onDisable={() => { onCancel(); onRemove(index); }} />
        ) : (
          <button key={`${chord.key}-${chord.modifier}-${index}`} type="button" data-shortcut-chord={index}
            disabled={busy || recordingIndex !== null}
            aria-label={t('st.shortcuts.changeAria', { action: label, keys: chordKeys(chord, platform).join('+') })}
            onClick={() => { onRecord(index); }}
            className="inline-flex min-h-8 items-center rounded-md px-1.5 transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11">
            <Keycaps keys={chordKeys(chord, platform)} />
          </button>
        ))}
        {recordingIndex !== null && recordingIndex >= chords.length ? (
          <ChordRecorder platform={platform} describedBy={issue === null ? undefined : issueId}
            onRecorded={onRecorded} onCancel={onCancel} />
        ) : null}
        {canAdd ? (
          <button type="button" data-shortcut-add disabled={busy}
            aria-label={t('st.shortcuts.addAria', { action: label })} title={t('st.shortcuts.add')}
            onClick={() => { onRecord(chords.length); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11">
            <span aria-hidden className="text-[15px] leading-none">+</span>
          </button>
        ) : null}
        {overridden ? (
          <button type="button" data-shortcut-reset disabled={busy || recordingIndex !== null} onClick={onReset}
            aria-label={t('st.shortcuts.resetAria', { action: label })}
            className="h-8 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 pointer-coarse:h-11">
            {t('st.shortcuts.reset')}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Listening state for one chord slot. It holds focus and owns every keydown
 * until a full chord arrives: app shortcuts are suspended, Esc cancels,
 * Backspace/Delete clears the slot, and leaving the field cancels.
 */
function ChordRecorder({ platform, describedBy, onRecorded, onCancel, onDisable }: {
  platform: ShortcutPlatform;
  describedBy?: string;
  onRecorded: (chord: ShortcutChord) => void;
  onCancel: () => void;
  onDisable?: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  useEffect(() => {
    const release = beginShortcutRecording();
    ref.current?.focus();
    return release;
  }, []);
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        ref={ref}
        type="button"
        data-shortcut-recording
        aria-describedby={describedBy}
        aria-label={t('st.shortcuts.recordingAria')}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
          if (event.key === 'Escape' && bare) { onCancel(); return; }
          if ((event.key === 'Backspace' || event.key === 'Delete') && bare && onDisable !== undefined) { onDisable(); return; }
          const result = chordFromEvent(event, platform);
          if (result.kind === 'pending') return;
          if (result.kind === 'unsupported') { setUnsupported(result.key); return; }
          onRecorded(result.chord);
        }}
        className="inline-flex min-h-8 min-w-[9rem] items-center justify-center gap-1.5 rounded-md bg-selected px-3 text-[12px] font-medium text-selected-ink outline-2 outline-selected-ink/60 [outline-style:solid] pointer-coarse:min-h-11"
      >
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-selected-ink motion-reduce:animate-none" />
        {t('st.shortcuts.recording')}
      </button>
      <span className="text-[11px] text-ink-faint">
        {unsupported !== null ? t('st.shortcuts.unsupported', { key: unsupported })
          : onDisable !== undefined ? t('st.shortcuts.recordHintClear') : t('st.shortcuts.recordHint')}
      </span>
    </span>
  );
}

/** Keys that are part of how a control works, listed so the table is complete. */
function FixedKeysCard({ platform, desktop }: { platform: ShortcutPlatform; desktop: boolean }) {
  const { t } = useI18n();
  const sendShortcut = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot).sendShortcut;
  const enter: ShortcutChord = { key: 'Enter', modifier: 'none', shift: false, alt: false };
  // Send and newline follow General › "Send with", not the catalog defaults.
  const sendRows = [
    { id: 'send', labelKey: 'shortcuts.send', chords: [sendShortcut === 'cmd-enter' ? { ...enter, modifier: 'mod' as const } : enter] },
    { id: 'newline', labelKey: 'shortcuts.newline', chords: [sendShortcut === 'cmd-enter' ? enter : { ...enter, shift: true }] },
  ];
  const seen = new Set<string>();
  const otherRows = SHORTCUT_CATALOG
    .filter((entry) => 'managedBy' in entry && entry.managedBy !== 'sendShortcut' && (desktop || !entry.desktopOnly))
    .map((entry) => ({ id: entry.id, labelKey: entry.labelKey, chords: [...entry.defaults] }))
    .filter((entry) => {
      const id = `${entry.labelKey}:${entry.chords.map((chord) => chordKeys(chord, platform).join('+')).join(',')}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  return (
    <SectionCard id="st-card-shortcuts-fixed" title={t('st.shortcuts.fixedTitle')} scope="app">
      <p className="mb-3 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.shortcuts.fixedHint')}</p>
      <ul className="divide-y divide-hairline border-y border-hairline">
        {[...sendRows, ...otherRows].map((entry) => (
          <li key={entry.id} data-shortcut-fixed={entry.id} className="flex items-center justify-between gap-4 py-2">
            <span className="min-w-0 text-[12.5px] text-ink-soft">{t(entry.labelKey as I18nKey)}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {entry.chords.map((chord, index) => <Keycaps key={index} keys={chordKeys(chord, platform)} />)}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

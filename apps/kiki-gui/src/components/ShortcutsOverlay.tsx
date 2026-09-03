/**
 * ShortcutsOverlay — the Ctrl+/ (or `?`) keyboard map, built on the shared
 * Dialog primitive. Rows reflect the bindings actually wired in code:
 * App.tsx global keys, Composer's textarea keys, SessionView's Esc/y/n, and
 * TerminalPanel's Ctrl+Shift+C/V; the desktop show/hide hotkey only appears
 * in the desktop runtime, and browser-reserved combos (Ctrl+N, Ctrl+Tab —
 * App.tsx never registers them there) carry a "desktop only" badge.
 */

import { useSyncExternalStore } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type SendShortcut,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { Dialog } from './Dialog';

interface ShortcutRow {
  readonly keys: readonly string[];
  readonly labelKey: I18nKey;
  /** The combo is browser-reserved (preventDefault cannot intercept it), so
   * the binding exists only in the desktop runtime; browsers show the badge. */
  readonly desktopOnly?: boolean;
}

interface ShortcutGroup {
  readonly titleKey: I18nKey;
  readonly rows: readonly ShortcutRow[];
}

function sendKeys(shortcut: SendShortcut): readonly string[] {
  return shortcut === 'cmd-enter' ? ['⌘/Ctrl', 'Enter'] : ['Enter'];
}

function newlineKeys(shortcut: SendShortcut): readonly string[] {
  return shortcut === 'cmd-enter' ? ['Enter'] : ['Shift', 'Enter'];
}

/** Exported for tests: the runtime- and preference-aware keyboard map. */
export function shortcutsGroups(shortcut: SendShortcut, desktop: boolean): readonly ShortcutGroup[] {
  const globalRows: ShortcutRow[] = [
    { keys: ['Ctrl', 'N'], labelKey: 'shortcuts.newSession', desktopOnly: true },
    { keys: ['Ctrl', 'K'], labelKey: 'shortcuts.switcher' },
    { keys: ['Ctrl', 'Tab'], labelKey: 'shortcuts.nextSession', desktopOnly: true },
    { keys: ['Ctrl', ','], labelKey: 'shortcuts.settings' },
    { keys: ['Ctrl', '/'], labelKey: 'shortcuts.thisPanel' },
    { keys: ['?'], labelKey: 'shortcuts.thisPanel' },
  ];
  if (desktop) {
    globalRows.push({ keys: ['Ctrl', 'Shift', 'K'], labelKey: 'shortcuts.showHide' });
  }
  return [
    { titleKey: 'shortcuts.group.global', rows: globalRows },
    {
      titleKey: 'shortcuts.group.session',
      rows: [
        { keys: sendKeys(shortcut), labelKey: 'shortcuts.send' },
        { keys: newlineKeys(shortcut), labelKey: 'shortcuts.newline' },
        // Esc is layered, highest priority first: an open dialog or menu
        // swallows it, an open terminal panel is next, and only otherwise
        // does it abort the running turn (SessionView wires that order).
        { keys: ['Esc'], labelKey: 'shortcuts.escOverlay' },
        { keys: ['Esc'], labelKey: 'shortcuts.escTerminal' },
        { keys: ['Esc'], labelKey: 'shortcuts.escAbort' },
        { keys: ['/'], labelKey: 'shortcuts.slashMenu' },
        { keys: ['@'], labelKey: 'shortcuts.fileMention' },
      ],
    },
    {
      titleKey: 'shortcuts.group.approvals',
      rows: [
        { keys: ['y'], labelKey: 'shortcuts.approve' },
        { keys: ['n'], labelKey: 'shortcuts.reject' },
      ],
    },
    {
      titleKey: 'shortcuts.group.terminal',
      rows: [
        { keys: ['Ctrl', '`'], labelKey: 'shortcuts.termToggle' },
        { keys: ['Ctrl', 'Shift', 'C'], labelKey: 'shortcuts.termCopy' },
        { keys: ['Ctrl', 'Shift', 'V'], labelKey: 'shortcuts.termPaste' },
        { keys: ['Esc'], labelKey: 'shortcuts.termEsc' },
        { keys: ['Esc'], labelKey: 'shortcuts.termClose' },
      ],
    },
  ];
}

function Kbd({ label }: { label: string }) {
  return (
    <kbd className="rounded-md border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink-soft shadow-[0_1px_0_rgba(28,25,23,0.08)]">
      {label}
    </kbd>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const host = useHost();
  const { t } = useI18n();
  const desktop = host.kind === 'tauri';
  const sendShortcut = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).sendShortcut;
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('shortcuts.title')}
      overlayId="shortcuts-overlay"
      panelClassName="anim-enter w-full max-w-[440px] rounded-2xl border border-hairline bg-panel p-5 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
    >
      <h2 className="font-display text-[16px] font-semibold text-ink">{t('shortcuts.title')}</h2>
      <div className="mt-3 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {shortcutsGroups(sendShortcut, desktop).map((group) => (
          <section key={group.titleKey}>
            <h3 className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
              {t(group.titleKey)}
            </h3>
            <ul className="space-y-1">
              {group.rows.map((row) => (
                <li
                  key={`${row.labelKey}-${row.keys.join('+')}`}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-1"
                >
                  <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                    {t(row.labelKey)}
                    {row.desktopOnly === true && !desktop ? (
                      <span className="rounded-sm border border-hairline bg-paper px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-faint uppercase">
                        {t('shortcuts.desktopOnly')}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.keys.map((key) => (
                      <Kbd key={key} label={key} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-3 border-t border-hairline pt-2 text-center text-[10.5px] text-ink-faint">
        {t('shortcuts.hint')}
      </p>
    </Dialog>
  );
}

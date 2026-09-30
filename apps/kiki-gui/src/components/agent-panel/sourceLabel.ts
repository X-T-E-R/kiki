import type { I18nKey } from '@kiki/session-core/i18n';
import { agentProfileSourceLabelKey } from '@kiki/session-core/settings';

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** Where a capability comes from, in the words the rail uses. */
export type SourceTone = 'workspace' | 'global' | 'builtin' | 'plugin' | 'other';

export interface SourceLabel {
  readonly text: string;
  readonly tone: SourceTone;
  /** Hover detail: the root or file it was found under. */
  readonly title?: string;
}

/**
 * One label for a skill's or a dispatch target's origin. Skills report
 * `project | user | extra | builtin` (plus `source_kind: plugin`); targets
 * report `builtin | plugin | user | extra | workspace`. Both collapse onto the
 * same four words: Workspace, Global (user and extra roots; extra says so),
 * Plugin, Built-in. An unknown id falls back to the profile source label,
 * then to the raw id.
 */
export function capabilitySourceLabel(
  t: Translate,
  input: {
    readonly source?: string;
    readonly sourceKind?: string;
    readonly sourceRoot?: string;
    readonly sourceFile?: string;
    readonly scope?: 'workspace' | 'global';
  },
): SourceLabel | undefined {
  const where = input.sourceRoot ?? input.sourceFile;
  const title = where === undefined || where === '' ? undefined : t('rail.source.from', { path: where });
  const kind = input.sourceKind === 'plugin' ? 'plugin' : input.source;
  switch (kind) {
    case 'plugin':
      return { text: t('rail.source.plugin'), tone: 'plugin', title };
    case 'builtin':
      return { text: t('rail.source.builtin'), tone: 'builtin', title };
    case 'project':
    case 'workspace':
      return { text: t('rail.source.workspace'), tone: 'workspace', title };
    case 'user':
      return { text: t('rail.source.global'), tone: 'global', title };
    case 'extra':
      return { text: t('rail.source.globalExtra'), tone: 'global', title };
    case undefined:
    case '':
      if (input.scope === 'workspace') return { text: t('rail.source.workspace'), tone: 'workspace', title };
      if (input.scope === 'global') return { text: t('rail.source.global'), tone: 'global', title };
      return undefined;
    default: {
      const key = agentProfileSourceLabelKey(kind);
      return { text: key === undefined ? kind : t(key), tone: 'other', title };
    }
  }
}

/** Label chip classes: every source is a neutral tag; the label text says which. */
export const SOURCE_TONE_CLASS: Readonly<Record<SourceTone, string>> = {
  workspace: 'bg-ink/[0.06] text-ink-soft',
  global: 'bg-ink/[0.06] text-ink-soft',
  plugin: 'bg-ink/[0.06] text-ink-soft',
  builtin: 'text-ink-faint',
  other: 'bg-ink/[0.06] text-ink-soft',
};

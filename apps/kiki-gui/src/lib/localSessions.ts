/**
 * Local Claude / Codex history: which executors can browse it and how the
 * server's machine codes read. Mirrors kap-server's `localSessionEngine`
 * (claude-acp → claude; codex-app-server / codex-acp → codex) so the GUI never
 * offers a catalog the route would refuse.
 */

import type { ExecutorCatalogItem, LocalSessionSummary } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

export type LocalSessionEngine = LocalSessionSummary['engine'];

const ENGINE_OF: Readonly<Record<string, LocalSessionEngine>> = {
  'claude-acp': 'claude',
  'codex-app-server': 'codex',
  'codex-acp': 'codex',
};

/** Preferred executor per engine when several can read the same history. */
const PREFERENCE = ['claude-acp', 'codex-app-server', 'codex-acp'];

export function localSessionEngine(executorId: string): LocalSessionEngine | undefined {
  return ENGINE_OF[executorId];
}

export interface LocalSessionSource {
  readonly engine: LocalSessionEngine;
  readonly executorId: string;
  readonly label: string;
}

/** One source per engine, from the registered executors, in a stable order. */
export function localSessionSources(catalog: readonly ExecutorCatalogItem[]): LocalSessionSource[] {
  const byEngine = new Map<LocalSessionEngine, LocalSessionSource>();
  for (const id of PREFERENCE) {
    const item = catalog.find((entry) => entry.id === id);
    const engine = ENGINE_OF[id];
    if (item === undefined || engine === undefined || byEngine.has(engine)) continue;
    byEngine.set(engine, { engine, executorId: item.id, label: item.label });
  }
  return [...byEngine.values()];
}

const REASON_KEYS: Readonly<Record<string, I18nKey>> = {
  working_directory_missing: 'localSessions.reason.working_directory_missing',
  source_identity_mismatch: 'localSessions.reason.source_identity_mismatch',
  protocol_unsupported: 'localSessions.reason.protocol_unsupported',
  engine_resume_unsupported: 'localSessions.reason.engine_resume_unsupported',
};

/** Translation key for a `resume.reason` code; unknown codes fall back to a generic line. */
export function resumeReasonKey(reason: string | undefined): I18nKey {
  return (reason !== undefined ? REASON_KEYS[reason] : undefined) ?? 'localSessions.reason.unknown';
}

const WARNING_KEYS: Readonly<Record<string, I18nKey>> = {
  transcript_sampled: 'localSessions.warning.transcript_sampled',
  messages_truncated: 'localSessions.warning.messages_truncated',
  content_truncated: 'localSessions.warning.content_truncated',
  unsupported_content: 'localSessions.warning.unsupported_content',
  invalid_jsonl_record: 'localSessions.warning.invalid_jsonl_record',
  inherited_history_not_loaded: 'localSessions.warning.inherited_history_not_loaded',
  source_identity_mismatch: 'localSessions.warning.source_identity_mismatch',
};

/** Translation key for a preview warning, or undefined to show the raw code. */
export function previewWarningKey(warning: string): I18nKey | undefined {
  return WARNING_KEYS[warning];
}

/** What a row is called: its title, else its last prompt's first line, else the vendor id. */
export function localSessionName(summary: LocalSessionSummary): string {
  const title = summary.title?.trim();
  if (title !== undefined && title !== '') return title;
  const prompt = summary.last_prompt?.split(/\r?\n/).find((line) => line.trim() !== '')?.trim();
  return prompt !== undefined && prompt !== '' ? prompt : summary.external_id;
}

/** Last path segment of a working directory, for the row's second line. */
export function folderName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}

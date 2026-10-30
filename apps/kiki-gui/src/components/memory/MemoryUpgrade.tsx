/**
 * The automatic storage upgrade, as the page shows it while it runs.
 *
 * Starting Kiki upgrades a file store to SQLite on its own; nothing here
 * starts it. While it runs, ordinary memory reads and writes wait, so this
 * view is what the page has to say: which step, how many scopes are done,
 * and, if it stopped, which sources need repair. Progress is counted in the
 * scopes the store reports; it is not turned into a percentage it cannot
 * know.
 *
 * Retry always sends the operation id the store reported. After a lost or
 * failed answer the status is read again first, so a retry that already
 * finished is recognised instead of being sent twice.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { MemoryAuthorityState, MemoryMigrationIssue } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { SECONDARY_BUTTON } from '../ui';
import { MEMORY_AUTHORITY_QUERY_KEY, useMemoryAuthority } from './memoryAuthority';

type Migration = NonNullable<MemoryAuthorityState['migration']>;

const ISSUE_TEXT: Partial<Record<string, I18nKey>> = {
  legacy_inventory_incomplete: 'memory.upgrade.issue.inventoryIncomplete',
  duplicate_legacy_identity: 'memory.upgrade.issue.duplicateIdentity',
  current_revision_preserved: 'memory.upgrade.issue.revisionMismatch',
  source_lineage_preserved: 'memory.upgrade.issue.sourceLineagePreserved',
  forgotten_source_rejected: 'memory.upgrade.issue.forgottenSourceRejected',
  unmatched_shadow_head: 'memory.upgrade.issue.unmatchedCopy',
  legacy_head_missing: 'memory.upgrade.issue.missingEntry',
  legacy_journal_head_mismatch: 'memory.upgrade.issue.historyMismatch',
  unmatched_shadow_namespace: 'memory.upgrade.issue.unmatchedScope',
};
const VISIBLE_ISSUES = 5;
/** Progress that has not moved for this long is offered a same-operation continue. */
const STALL_MS = 30_000;

/** Which step the store reports, read only from fields it actually sent. */
export function upgradeStep(migration: Migration | undefined): 'discovering' | 'importing' | 'validating' | 'failed' {
  if (migration?.phase === 'failed') return 'failed';
  if (migration?.phase === 'validating') return 'validating';
  if (migration === undefined || migration.namespaces.length === 0) return 'discovering';
  return 'importing';
}

export function MemoryUpgradeStatus() {
  const { t, tp } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const authority = useMemoryAuthority();
  const migration = authority.state?.migration;
  const step = upgradeStep(migration);
  const [showAll, setShowAll] = useState(false);
  const [retryUnconfirmed, setRetryUnconfirmed] = useState(false);
  const stalled = useStall(migration);

  const reread = () => queryClient.invalidateQueries({ queryKey: MEMORY_AUTHORITY_QUERY_KEY });
  const retry = useMutation({
    mutationFn: (operationId: string) => client.retryMemoryMigration(operationId),
    onSuccess: (state) => { setRetryUnconfirmed(false); queryClient.setQueryData(MEMORY_AUTHORITY_QUERY_KEY, state); },
    // The retry may have run even though its answer was lost: read the status
    // before saying anything, and let that status decide what is shown.
    onError: () => { setRetryUnconfirmed(true); void reread(); },
  });
  if (migration === undefined) {
    return (
      <div data-memory-upgrade="starting" role="status" className="space-y-1">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink"><span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('memory.upgrade.title.running')}</p>
        <p className="text-[13px] leading-relaxed text-ink-soft">{t('memory.upgrade.runningLead')}</p>
      </div>
    );
  }

  const total = migration.namespaces.length;
  const done = Math.min(migration.index, total);
  const currentScope = migration.namespaces[migration.index];
  const issues = migration.issues;
  const shown = showAll ? issues : issues.slice(0, VISIBLE_ISSUES);
  const failureText = migration.failure === undefined ? undefined
    : migration.failure.code === 'memory.source_invalid' ? tp('memory.upgrade.failure.sources', issues.length)
    : t('memory.upgrade.failure.other');
  const offerRetry = step === 'failed' || stalled;

  return (
    <div data-memory-upgrade={step} data-memory-upgrade-operation={migration.id} role="status" className="space-y-3">
      <div className="space-y-1">
        <p className={`text-[13px] font-medium ${step === 'failed' ? 'text-amber-ink' : 'text-ink'}`}>{t(`memory.upgrade.title.${step === 'failed' ? 'failed' : 'running'}`)}</p>
        <p className="text-[13px] leading-relaxed text-ink-soft">{t(step === 'failed' ? 'memory.upgrade.failedLead' : 'memory.upgrade.runningLead')}</p>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-ink-faint">{t('memory.upgrade.step')}</dt>
        <dd data-memory-upgrade-step={step} className="flex min-w-0 items-center gap-2 text-ink-soft">
          {step !== 'failed' ? <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
          {t(`memory.upgrade.step.${step}`)}
        </dd>
        {total > 0 ? (
          <>
            <dt className="text-ink-faint">{t('memory.upgrade.scopes')}</dt>
            <dd data-memory-upgrade-progress={`${done}/${total}`} className="text-ink-soft tabular-nums">{t('memory.upgrade.scopesDone', { done, total })}</dd>
          </>
        ) : null}
        {step === 'importing' && currentScope !== undefined ? (
          <>
            <dt className="text-ink-faint">{t('memory.upgrade.current')}</dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-ink-soft" title={migration.after === undefined ? currentScope : `${currentScope} · ${migration.after}`}>
              {currentScope}{migration.after === undefined ? '' : ` · ${migration.after}`}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-faint">{t('memory.upgrade.operation')}</dt>
        <dd className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={migration.id}>{migration.id}</dd>
      </dl>

      {failureText !== undefined ? (
        <p data-memory-upgrade-failure={migration.failure!.code} className="text-[12px] leading-relaxed text-amber-ink">
          {failureText}
          {migration.failure!.code === 'memory.source_invalid' ? null : <span className="ml-1 font-mono text-[11px]">{migration.failure!.code}</span>}
        </p>
      ) : null}

      {issues.length > 0 ? (
        <div data-memory-upgrade-issues={issues.length} className="space-y-1.5">
          <ul className="divide-y divide-hairline border-y border-hairline">
            {shown.map((issue, index) => (
              <li key={`${issue.scope}:${issue.key}:${issue.issue}:${index}`} data-memory-upgrade-issue={issue.issue} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[12px]">
                <span className="min-w-0 text-ink">{ISSUE_TEXT[issue.issue] === undefined ? t('memory.upgrade.issue.other') : t(ISSUE_TEXT[issue.issue]!)}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={`${issue.scope} ${issue.key}`}>
                  {issue.scope}{issue.key === '' ? '' : ` · ${issue.key}`}
                </span>
                {ISSUE_TEXT[issue.issue] === undefined ? <span className="font-mono text-[11px] text-ink-faint">{issue.issue}</span> : null}
              </li>
            ))}
          </ul>
          {issues.length > VISIBLE_ISSUES ? (
            <button type="button" data-memory-upgrade-issues-toggle onClick={() => { setShowAll((value) => !value); }} className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
              {showAll ? t('memory.upgrade.issuesFewer') : tp('memory.upgrade.issuesAll', issues.length)}
            </button>
          ) : null}
        </div>
      ) : null}

      {retryUnconfirmed && !retry.isPending ? (
        <p role="alert" data-memory-upgrade-retry-unconfirmed className="text-[12px] text-ink-soft">{t('memory.upgrade.retryUnconfirmed')}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {offerRetry ? (
          <button type="button" data-memory-upgrade-retry disabled={retry.isPending} onClick={() => { if (!retry.isPending) retry.mutate(migration.id); }} className={SECONDARY_BUTTON}>
            {t(retry.isPending ? 'memory.upgrade.retrying' : step === 'failed' ? 'memory.upgrade.retry' : 'memory.upgrade.continue')}
          </button>
        ) : null}
        <button type="button" data-memory-upgrade-check onClick={() => { void reread(); }} className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
          {t('memory.upgrade.check')}
        </button>
      </div>
    </div>
  );
}

export function MemoryMigrationIssues({ issues }: { readonly issues: readonly MemoryMigrationIssue[] }) {
  const { t, tp } = useI18n();
  const [showAll, setShowAll] = useState(false);
  if (issues.length === 0) return null;
  const shown = showAll ? issues : issues.slice(0, VISIBLE_ISSUES);
  return (
    <section data-memory-migration-issues={issues.length} role="status" aria-label={t('memory.migrationIssues.title')} className="mb-4 space-y-2 border-l-2 border-amber-rule pl-3">
      <div className="space-y-1">
        <h2 className="text-[13px] font-medium text-ink">{t('memory.migrationIssues.title')}</h2>
        <p className="text-[12px] leading-relaxed text-ink-soft">{t('memory.migrationIssues.lead')}</p>
      </div>
      <ul className="divide-y divide-hairline border-y border-hairline">
        {shown.map((issue, index) => (
          <li key={`${issue.scope}:${issue.key}:${issue.issue}:${index}`} data-memory-migration-issue={issue.issue} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[12px]">
            <span className="min-w-0 text-ink">{ISSUE_TEXT[issue.issue] === undefined ? t('memory.upgrade.issue.other') : t(ISSUE_TEXT[issue.issue]!)}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={`${issue.scope} ${issue.key}`}>
              {issue.scope}{issue.key === '' ? '' : ` · ${issue.key}`}
            </span>
            {ISSUE_TEXT[issue.issue] === undefined ? <span className="font-mono text-[11px] text-ink-faint">{issue.issue}</span> : null}
          </li>
        ))}
      </ul>
      {issues.length > VISIBLE_ISSUES ? (
        <button type="button" data-memory-migration-issues-toggle onClick={() => { setShowAll((value) => !value); }} className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
          {showAll ? t('memory.upgrade.issuesFewer') : tp('memory.upgrade.issuesAll', issues.length)}
        </button>
      ) : null}
    </section>
  );
}

/** True once the reported progress has stood still for `STALL_MS`. */
function useStall(migration: Migration | undefined): boolean {
  const mark = migration === undefined ? '' : JSON.stringify([migration.id, migration.phase, migration.index, migration.after, migration.namespaces.length, migration.issues.length]);
  const [stalled, setStalled] = useState(false);
  const since = useRef(mark);
  useEffect(() => {
    since.current = mark;
    setStalled(false);
    if (mark === '' || migration?.phase === 'failed') return undefined;
    const timer = setTimeout(() => { if (since.current === mark) setStalled(true); }, STALL_MS);
    return () => { clearTimeout(timer); };
  }, [mark, migration?.phase]);
  return stalled;
}

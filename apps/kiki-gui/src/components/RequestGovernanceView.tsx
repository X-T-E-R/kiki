import { useI18n } from '../i18n';
import { useRequestGovernance } from '../lib/useRequestGovernance';

export function RequestGovernanceBadge({ compact = false }: { compact?: boolean }) {
  const { snapshot, stale } = useRequestGovernance();
  const { t } = useI18n();
  const title = snapshot === undefined
    ? t('usage.governance.unavailable')
    : `${t('usage.governance.badge', { active: snapshot.active, queued: snapshot.queued })}${stale ? ` · ${t('usage.governance.stale', { time: snapshot.asOf })}` : ''}`;
  return (
    <span
      data-request-governance-badge
      data-stale={stale || undefined}
      title={title}
      aria-label={title}
      className={compact
        ? 'absolute -right-2 -bottom-1 rounded bg-paper px-0.5 font-mono text-[9px] leading-3 text-ink-faint tabular-nums'
        : 'ml-auto shrink-0 font-mono text-[11px] text-ink-faint tabular-nums'}
    >
      {snapshot === undefined ? '—' : `${snapshot.active}${!compact && snapshot.queued > 0 ? ` · +${snapshot.queued}` : ''}`}
      {!compact && stale && snapshot !== undefined ? ' ◦' : ''}
    </span>
  );
}

export function RequestGovernanceView({ view }: { view: 'realtime' | 'limits' }) {
  const { snapshot, stale, loading } = useRequestGovernance();
  const { t, time } = useI18n();
  if (snapshot === undefined) {
    return <p className="py-8 text-sm text-ink-faint" role="status">{t(loading ? 'usage.governance.loading' : 'usage.governance.unavailable')}</p>;
  }
  return (
    <section data-request-governance className="space-y-6 py-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
        <span>{t('usage.governance.domain')} · {snapshot.runtimeEpoch.slice(0, 8)}</span>
        <span role="status" data-governance-stale={stale || undefined}>
          {stale
            ? t('usage.governance.stale', { time: time.absoluteTime(snapshot.asOf) ?? snapshot.asOf })
            : t('usage.governance.connected')}
        </span>
        <span>{t('usage.governance.external')}</span>
      </div>
      {view === 'realtime' ? (
        <>
          <div className="flex gap-10">
            <div>
              <div className="text-xs text-ink-faint">{t('usage.governance.requests')}</div>
              <div data-governance-active className="text-3xl font-mono tabular-nums">{snapshot.active}</div>
            </div>
            <div>
              <div className="text-xs text-ink-faint">{t('usage.governance.waiting')}</div>
              <div data-governance-queued className="text-3xl font-mono tabular-nums">{snapshot.queued}</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-faint">
                <tr>
                  <th className="py-2">{t('usage.governance.target')}</th>
                  <th>{t('usage.governance.requests')}</th>
                  <th>{t('usage.governance.waiting')}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.dimensions.map((row) => (
                  <tr key={`${row.dimension}:${row.id}`} className="border-t border-hairline">
                    <td className="py-2">{t(`usage.governance.${row.dimension}`)} · {row.id}</td>
                    <td className="font-mono tabular-nums">{row.active}</td>
                    <td className="font-mono tabular-nums">{row.queued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {snapshot.waiting.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('usage.governance.waiting')}</h3>
              {snapshot.waiting.map((row) => (
                <div key={row.attemptId} className="flex flex-wrap gap-x-4 text-xs text-ink-soft">
                  <span>{row.modelId} · {row.sessionId ?? 'system'} / {row.agentId ?? 'system'}</span>
                  <span>{row.purpose}</span>
                  <span>{row.blockingRules.join(', ')}</span>
                  <span className="font-mono">{time.formatDuration(row.waitedMs)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-xs text-ink-faint">{t('usage.governance.readonly')}</p>
          {snapshot.rules.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('usage.governance.noRules')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-left text-sm">
                <thead className="text-xs text-ink-faint">
                  <tr>
                    <th className="py-2 pr-4">ID</th>
                    <th className="pr-4">{t('usage.governance.scope')}</th>
                    <th className="pr-4">{t('usage.governance.target')}</th>
                    <th className="whitespace-nowrap pr-4">{t('usage.governance.cap')}</th>
                    <th className="whitespace-nowrap">{t('usage.governance.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.rules.map((rule) => (
                    <tr key={rule.id} className="border-t border-hairline">
                      <td className="py-3 pr-4">{rule.id}</td>
                      <td className="pr-4">{t(rule.scope === 'global' ? 'usage.governance.global' : 'usage.governance.eachSession')}</td>
                      <td className="pr-4">
                        {[
                          rule.models?.join(', '),
                          rule.providers === undefined ? undefined : `${t('usage.governance.provider')}: ${rule.providers.join(', ')}`,
                          rule.subagentsOnly ? t('usage.governance.children') : undefined,
                        ].filter(Boolean).join(' · ') || t('usage.governance.all')}
                      </td>
                      <td className="pr-4 font-mono">{rule.maxConcurrent ?? t('usage.governance.unlimited')}</td>
                      <td>{t(rule.overflow === 'queue' ? 'usage.governance.queue' : 'usage.governance.reject')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

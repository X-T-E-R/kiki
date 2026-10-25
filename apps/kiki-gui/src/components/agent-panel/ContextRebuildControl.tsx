import { useEffect, useState } from 'react';
import type { ContextRebuildControl as ContextRebuildSnapshot } from '@kiki/klient';
import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { Icon, Spinner } from '../icons';

const SURFACES = ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'] as const;

const CHANGE_KEY = {
  profile: 'profile',
  prompt_fields: 'promptFields',
  skills: 'skills',
  instructions: 'instructions',
  plugins: 'plugins',
  mcp: 'mcp',
  injections: 'injections',
} as const;

export function ContextRebuildControl({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const { t } = useI18n();
  const klient = useOptionalConnection()?.klient;
  const readable = klient !== undefined && typeof (klient as { session?: unknown }).session === 'function';
  const [control, setControl] = useState<ContextRebuildSnapshot | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!readable || klient === undefined) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await klient.session(sessionId).agent(agentId).contextRebuildControl();
        if (!cancelled) {
          setControl(next);
          setLoadError(undefined);
        }
      } catch (error) {
        if (!cancelled) setLoadError(messageOf(error));
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, klient, readable, sessionId, tick]);

  if (!readable || klient === undefined) return null;
  const agent = () => klient.session(sessionId).agent(agentId);
  const error = actionError ?? control?.error ?? loadError;
  const failed = error !== undefined || control?.outcome === 'failed';
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setActionError(undefined);
    void work().then(() => {
      setTick((value) => value + 1);
    }, (failure: unknown) => {
      setActionError(messageOf(failure));
      setTick((value) => value + 1);
    }).finally(() => {
      setBusy(false);
    });
  };

  return <section className="min-w-0 border-t border-ink/10 pt-4" data-context-rebuild>
    <div className="flex min-w-0 items-center gap-2" data-context-rebuild-switch>
      <div className="min-w-0 flex-1">
        <Toggle layout="row" label={t('agentPanel.rebuild.switch')} checked={control?.enabled === true} disabled={busy || control === undefined}
          onChange={(enabled) => { run(() => agent().setContextRebuildEnabled(enabled)); }} />
      </div>
      {busy || (control === undefined && error === undefined) ? <span data-context-rebuild-mark="busy">
        <Spinner size={14} label={t(busy ? 'agentPanel.rebuild.retrying' : 'agentPanel.rebuild.loading')} />
      </span> : null}
      {!busy && error === undefined && control?.outcome === 'applied' ? <span role="status" data-context-rebuild-mark="applied" className="inline-flex text-success" aria-label={control.trigger !== undefined ? t(`agentPanel.rebuild.trigger.${control.trigger}`) : t('agentPanel.rebuild.outcome.applied')}>
        <Icon name="check" size={14} />
      </span> : null}
    </div>
    {failed ? <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
      <p role="alert" className="min-w-0 break-words text-[12px] leading-5 text-danger" data-context-rebuild-error>{error ?? t('agentPanel.rebuild.outcome.failed')}</p>
      <button type="button" data-context-rebuild-retry disabled={busy} onClick={() => { run(() => agent().rebuildContext().then(() => undefined)); }}
        className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-50">
        {t(busy ? 'agentPanel.rebuild.retrying' : 'agentPanel.rebuild.retry')}
      </button>
    </div> : null}
    {control?.outcome !== undefined ? <details className="mt-1 min-w-0" data-context-rebuild-sources>
      <summary className="cursor-pointer rounded text-[12px] text-ink-faint outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">{t('agentPanel.rebuild.sources')}</summary>
      <div className="space-y-2 pt-2">
        <p className="text-[12px] text-ink-soft" data-context-rebuild-outcome={control.outcome}>
          {t(`agentPanel.rebuild.outcome.${control.outcome}`)}
          {control.trigger !== undefined ? ` · ${t(`agentPanel.rebuild.trigger.${control.trigger}`)}` : ''}
          {control.at !== undefined ? ` · ${t('agentPanel.rebuild.when', { when: new Date(control.at).toLocaleString() })}` : ''}
        </p>
        <ul className="space-y-1">
          {SURFACES.map((surface) => {
            const unsupported = control.unsupported.find((item) => item.surface === surface);
            const finished = control.rebuilt.includes(surface);
            const status = unsupported !== undefined ? 'unsupported' : finished ? (control.changes?.[CHANGE_KEY[surface]] === true ? 'updated' : 'unchanged') : 'unfinished';
            return <li key={surface} className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-5" data-context-rebuild-surface={surface} data-context-rebuild-status={status}>
              <span className="text-ink-soft">{t(`agentPanel.rebuild.surface.${surface}`)}</span>
              <span className={status === 'unsupported' || status === 'unfinished' ? 'text-amber-ink' : 'text-ink-faint'}>{t(`agentPanel.rebuild.${status}`)}</span>
              {unsupported !== undefined ? <span className="w-full text-[11.5px] text-ink-faint">{unsupported.reason}</span> : null}
            </li>;
          })}
          {control.unsupported.filter((item) => item.surface === 'executor_session').map((item) => <li key={item.surface} className="text-[12px] leading-5" data-context-rebuild-surface={item.surface} data-context-rebuild-status="unsupported">
            <span className="text-ink-soft">{t('agentPanel.rebuild.surface.executor_session')}</span>
            {' '}
            <span className="text-amber-ink">{t('agentPanel.rebuild.unsupported')}</span>
            <span className="mt-0.5 block text-[11.5px] text-ink-faint">{item.reason}</span>
          </li>)}
        </ul>
      </div>
    </details> : null}
  </section>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

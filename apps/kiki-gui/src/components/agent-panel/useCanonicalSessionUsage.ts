import { useEffect, useRef, useState } from 'react';
import type { SessionUsage } from '@kiki/protocol';
import { useOptionalConnection } from '../../state/connection';

type SessionAccountingUsage = Pick<SessionUsage, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens' | 'total_cost_usd' | 'accounting'>;

export function useCanonicalSessionUsage(open: boolean, sessionId?: string, agentId?: string) {
  const connection = useOptionalConnection();
  const client = connection?.client;
  const identity = `${connection?.spaceKey ?? ''}:${connection?.scopeId ?? ''}:${connection?.meta?.server_id ?? ''}:${sessionId ?? ''}`;
  const [read, setRead] = useState<{ identity: string; usage?: SessionAccountingUsage; error: boolean }>();
  const clientRef = useRef(client);
  clientRef.current = client;
  const active = open && agentId === undefined && sessionId !== undefined && client !== undefined;
  useEffect(() => {
    if (!active || sessionId === undefined) return;
    const controller = new AbortController();
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (running || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => { void refresh(); }, 15_000); return; }
      running = true;
      let delay = 15_000;
      try {
        const rest = clientRef.current!.klient.rest;
        if (rest === undefined) throw new Error('Session usage is unavailable on this transport');
        const accounting = await rest.sessionUsageAccounting(sessionId, { signal: controller.signal });
        const usage: SessionAccountingUsage = { input_tokens: accounting.tokens.input_other, output_tokens: accounting.tokens.output, cache_read_tokens: accounting.tokens.input_cache_read, cache_creation_tokens: accounting.tokens.input_cache_creation, total_cost_usd: accounting.cost_usd_estimated, accounting };
        if (!controller.signal.aborted) setRead({ identity, usage, error: false });
        if (!accounting.complete || accounting.freshness === 'stale') delay = 250;
      } catch {
        if (!controller.signal.aborted) setRead((old) => ({ identity, usage: old?.identity === identity ? old.usage : undefined, error: true }));
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, delay);
      }
    };
    const subscription = clientRef.current!.klient.events.on('session.metaUpdated', (event) => {
      if (event.sessionId !== sessionId) return;
      setRead((old) => old?.identity === identity && old.usage?.accounting !== undefined
        ? { ...old, usage: { ...old.usage, accounting: { ...old.usage.accounting, freshness: 'stale' } } } : old);
      void refresh();
    });
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); subscription.dispose(); };
  }, [active, identity, sessionId]);
  const current = read?.identity === identity ? read : undefined;
  return { active, usage: current?.usage, loading: active && current === undefined, error: active && current?.error === true };
}

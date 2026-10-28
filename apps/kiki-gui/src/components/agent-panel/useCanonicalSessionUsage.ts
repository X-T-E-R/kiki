import { useEffect, useRef, useState } from 'react';
import type { SessionUsage } from '@kiki/protocol';
import { useOptionalConnection } from '../../state/connection';

export function useCanonicalSessionUsage(open: boolean, sessionId?: string, agentId?: string) {
  const connection = useOptionalConnection();
  const client = connection?.client;
  const identity = `${connection?.spaceKey ?? ''}:${connection?.scopeId ?? ''}:${sessionId ?? ''}`;
  const [read, setRead] = useState<{ identity: string; usage?: SessionUsage; error: boolean }>();
  const clientRef = useRef(client);
  clientRef.current = client;
  const active = open && agentId === undefined && sessionId !== undefined && client !== undefined;
  useEffect(() => {
    if (!active || sessionId === undefined) return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        const session = await clientRef.current!.getSession(sessionId, { signal: controller.signal });
        if (!controller.signal.aborted) setRead({ identity, usage: session.usage, error: session.usage_error === 'read-failed' && session.usage?.accounting === undefined });
      } catch {
        if (!controller.signal.aborted) setRead({ identity, error: true });
      } finally { running = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 15_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [active, identity, sessionId]);
  const current = read?.identity === identity ? read : undefined;
  return { active, usage: current?.usage, loading: active && current === undefined, error: active && current?.error === true };
}

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { resolveSettingsRoute } from '../lib/settings';

/**
 * /capabilities retired in the batch-3 settings split (redesign §10.2 rule
 * 3): its content now lives under Settings → Skills / MCP. A precise card
 * hash still follows the card to its new leaf; a bare visit lands on Skills
 * with the split signpost (`from=capabilities`) — and any deep-link query
 * (server/token/workspace) survives the redirect. Replace, never push, so
 * Back doesn't bounce through the shim.
 */
export function CapabilitiesShim() {
  const { hash, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const resolution = resolveSettingsRoute('capabilities', hash);
    const params = new URLSearchParams(search);
    const section = resolution.status === 'ok' ? resolution.section : 'skills';
    const cardId = resolution.status === 'ok' ? resolution.cardId : undefined;
    if (resolution.status === 'ok' && resolution.tab !== undefined) {
      params.set('tab', resolution.tab);
    }
    if (cardId === undefined) params.set('from', 'capabilities');
    const query = params.toString();
    navigate(
      `/settings/${section}${query === '' ? '' : `?${query}`}${cardId === undefined ? '' : `#${cardId}`}`,
      { replace: true },
    );
  }, [hash, search, navigate]);
  return null;
}

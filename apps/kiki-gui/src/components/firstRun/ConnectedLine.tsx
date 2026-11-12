/**
 * The line under the composer right after the connect card gave way to it:
 * what got connected, and which model new conversations now use. It belongs to
 * this visit only (the page holds it in state), and says nothing it cannot
 * name: without a default model there is no line.
 */

import { useQuery } from '@tanstack/react-query';

import { resolveCatalogModel } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';

export function ConnectedLine({ name, model }: {
  /** What the person connected, when the way they used knows it. */
  readonly name: string | undefined;
  /** The model id new conversations resolve to. */
  readonly model: string | undefined;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  // The catalog the composer already reads; no request of its own.
  const models = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  if (model === undefined) return null;
  const item = resolveCatalogModel(models.data?.items ?? [], model);
  // A connection made elsewhere (another agent, another window) has no name
  // here; the provider behind the default model is the honest stand-in.
  const connected = name ?? item?.provider_id;
  if (connected === undefined) return null;
  return (
    <p data-first-run-connected role="status" className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] text-left text-[12.5px] leading-relaxed text-ink-soft">
      {t('firstRun.connected', { name: connected, model: item?.display_name ?? model })}
    </p>
  );
}

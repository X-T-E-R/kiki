/**
 * Where a bridged message came from, in the reader's terms.
 *
 * A bridged message crossed a machine: the row says which home and which host
 * it started on, and whether that hop stayed on this machine or went over the
 * network. The line is only a way in when this window can really open that
 * home — a space registered here for browsing. A bridge-only or unknown source
 * is stated, not offered as a link, so the reader never follows a source into
 * the local home that happens to share its id.
 */

import type { UserBlock } from '@kiki/session-core/session';
import type { RemoteConnection } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useHost } from '../../host';
import { useConnection } from '../../state/connection';
import { useRemoteConnections } from '../../lib/remoteConnections';
import { remoteSpaceScope } from '../../lib/remoteConnections';
import { requestScopeNavigation } from '../../lib/navScope';
import { pushToast } from '../../lib/toasts';
import { Icon } from '../icons';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** A browsable remote space this window already holds, or nothing. */
export function browsableSourceSpace(
  block: UserBlock,
  records: readonly RemoteConnection[] | undefined,
): RemoteConnection | undefined {
  const sourceHomeId = block.bridgedPeer?.sourceHomeId;
  if (sourceHomeId === undefined || sourceHomeId === '') return undefined;
  return records?.find((record) => record.enabled && record.state !== 'disabled' &&
    record.purposes.includes('gui') && record.target.homeId === sourceHomeId);
}

/**
 * The line as the transcript renders it: the source read from this home's own
 * connection records, so the offer to open it is a fact about this window.
 */
export function BridgedOriginRow({ block }: { block: UserBlock }) {
  const { localClient } = useConnection();
  const enter = useBridgedSourceEntry();
  const records = useRemoteConnections(localClient).data;
  return <BridgedOriginLine block={block} records={records} onOpen={enter} />;
}

export function BridgedOriginLine({ block, records, onOpen }: {
  block: UserBlock;
  /** The local home's connection records; absent while they load. */
  records?: readonly RemoteConnection[];
  onOpen?: (record: RemoteConnection) => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const bridge = block.bridgedPeer;
  if (bridge === undefined) return null;
  // The host name is what a person recognises; the home id is the exact
  // address, so it stays in the hover title instead of crowding the row.
  const hostId = bridge.source?.hostId;
  const hostName = hostId === undefined || hostId === '' ? undefined : hostId;
  const home = bridge.sourceHomeId === undefined || bridge.sourceHomeId === '' ? undefined : bridge.sourceHomeId;
  const where = hostName ?? t('transcript.bridgedOriginUnknown');
  const address = [home, hostName].filter((part): part is string => part !== undefined).join(' · ');
  const line = t('transcript.bridgedOrigin', {
    where,
    location: t(bridge.location === 'network' ? 'transcript.bridgedLocation.network' : 'transcript.bridgedLocation.local'),
  });
  const detail = address === where ? line : `${line}
${address}`;
  // A remote window has no control home to switch the directory with, so the
  // source is stated there rather than offered as a way in.
  const target = host.kind === 'tauri' ? browsableSourceSpace(block, records) : undefined;

  return (
    <div data-bridged-origin className="flex min-w-0 items-center gap-2">
      <span className="w-6 shrink-0 max-sm:w-5"><Icon name="thread" size={12} className="text-ink-faint" /></span>
      {target === undefined ? (
        <span className="min-w-0 truncate text-[12px] text-ink-faint" data-bridged-origin-text title={detail}>{line}</span>
      ) : (
        <button
          type="button"
          onClick={() => { onOpen?.(target); }}
          data-bridged-origin-open={target.id}
          title={`${t('transcript.bridgedOpen', { label: target.label })}
${address}`}
          className="-ml-1.5 flex min-h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="min-w-0 truncate" data-bridged-origin-text>{line}</span>
          <Icon name="chevron" size={12} className="shrink-0" />
        </button>
      )}
    </div>
  );
}

/** The guarded entry a source line runs, once per click, with the failure said. */
export function useBridgedSourceEntry() {
  const { t } = useI18n();
  return (record: RemoteConnection) => {
    void requestScopeNavigation(remoteSpaceScope(record.id)).catch((error: unknown) => {
      if (isAbort(error)) return;
      pushToast({ tone: 'error', text: t('sidebar.space.remoteFailed', { name: record.label }) });
    });
  };
}

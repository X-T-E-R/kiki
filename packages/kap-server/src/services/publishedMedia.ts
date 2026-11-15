import { ISessionIndex, type Scope } from '@kiki/agent-core-v2';
import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';

import { openPublishedInlineMedia } from './inlineMedia';
import { openPersistedToolMedia } from './persistedToolMedia';
import type { TranscriptService } from './transcript/transcriptService';
import { readSessionViewCanonicalEntity } from '../transport/klient/sessionViewReads';

export type PublishedMediaReader = (fileId: string) => Promise<SessionMediaFile | undefined>;

export function publishedInlineMediaReader(core: Scope, service: TranscriptService, sessionId: string, signal?: AbortSignal): PublishedMediaReader {
  return (fileId) => openPublishedInlineMedia(fileId,
    (agentId, source) => readSessionViewCanonicalEntity(service, sessionId, { agentId, ref: { source }, signal }),
    async (id) => {
      signal?.throwIfAborted();
      const summary = await core.accessor.get(ISessionIndex).get(sessionId);
      return summary === undefined ? undefined : openPersistedToolMedia(core, sessionId, summary.workspaceId, id);
    }, signal);
}

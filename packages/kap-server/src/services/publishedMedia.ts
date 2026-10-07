import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';

import { openPublishedInlineMedia } from './inlineMedia';
import type { TranscriptService } from './transcript/transcriptService';
import { readSessionViewCanonicalEntity } from '../transport/klient/sessionViewReads';

export type PublishedMediaReader = (fileId: string) => Promise<SessionMediaFile | undefined>;

export function publishedInlineMediaReader(service: TranscriptService, sessionId: string, signal?: AbortSignal): PublishedMediaReader {
  return (fileId) => openPublishedInlineMedia(fileId,
    (agentId, source) => readSessionViewCanonicalEntity(service, sessionId, { agentId, ref: { source }, signal }));
}

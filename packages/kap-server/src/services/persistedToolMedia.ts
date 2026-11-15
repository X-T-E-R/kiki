import { IBootstrapService, type Scope } from '@kiki/agent-core-v2';
import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { parseMediaBlobRef } from '@kiki/transcript';

export async function openPersistedToolMedia(core: Scope, sessionId: string, workspaceId: string, fileId: string): Promise<SessionMediaFile | undefined> {
  const ref = parseMediaBlobRef(fileId);
  if (ref?.kind !== 'agent') return undefined;
  const sessionScope = sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), workspaceId), sessionId);
  const blobs = core.accessor.get(IBlobStore);
  const scope = `${agentScopeOf(sessionScope, ref.agentId)}/blobs`;
  const bytes = blobs.size === undefined ? await blobs.get(scope, ref.hash) : undefined;
  const size = blobs.size === undefined ? bytes?.byteLength : await blobs.size(scope, ref.hash);
  if (size === undefined) return undefined;
  return {
    name: 'tool-result.bin',
    mediaType: 'application/octet-stream',
    size,
    stream: bytes === undefined
      ? (range) => blobs.getStream(scope, ref.hash, range)
      : async function* (range) { yield range === undefined ? bytes : bytes.subarray(range.start, range.end + 1); },
  };
}

import { IHistoryArchive, type Scope, type ScopeSeed } from '@kiki/agent-core-v2';
import { isPlainAgentId, type TranscriptTurn } from '@kiki/transcript';

import { IGlobalSearchService } from '../search/searchService';
import type { TranscriptService } from './transcript/transcriptService';

export function historyArchiveSeed(getCore: () => Scope, getTranscript: () => TranscriptService): ScopeSeed {
  const archive: IHistoryArchive = {
    _serviceBrand: undefined,
    search: ({ query, mode, workspaceId, sessionId, agentId, role, pageSize, pageToken }) =>
      getCore().accessor.get(IGlobalSearchService).search({
        query, mode, workspaceId, indexOnly: true,
        container: sessionId === undefined && agentId === undefined
          ? undefined : { sessionId, agentId }, role, pageSize, pageToken,
      }),
    async readTurn(sessionId, agentId, ordinal, stepId) {
      if (!isPlainAgentId(agentId)) throw new Error('Invalid agent id.');
      const transcript = getTranscript();
      const store = transcript.forSessionLive(sessionId);
      let turn: TranscriptTurn | undefined;
      if (store !== undefined) {
        await transcript.whenReady(sessionId);
        await transcript.ensureAgentHistory(sessionId, agentId);
        turn = store.getAgent(agentId)?.snapshot().items.find(
          (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
        );
      }
      if (turn === undefined) {
        const snapshot = await transcript.readColdSnapshot(sessionId, agentId);
        turn = snapshot?.items.find(
          (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
        );
      }
      if (turn === undefined) return undefined;
      const steps = stepId === undefined ? turn.steps : turn.steps.filter((step) => step.stepId === stepId);
      if (stepId !== undefined && steps.length === 0) return undefined;
      return JSON.stringify({
        turn: turn.ordinal,
        state: turn.state,
        origin: turn.origin,
        ...(stepId === undefined ? { user: turn.prompt } : {}),
        steps: steps.map((step) => ({
          step_id: step.stepId,
          frames: step.frames.filter((frame) => frame.kind === 'text' || frame.kind === 'tool').map((frame) =>
            frame.kind === 'text' ? { role: frame.role, text: frame.text } :
              { role: 'tool', name: frame.name, input: frame.input, output: frame.output, error: frame.error }),
        })),
      });
    },
  };
  return [[IHistoryArchive, archive]];
}

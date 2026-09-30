import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { IBootstrapService, IAgentLifecycleService, ISessionContext, ISessionIndex, ISessionManager, IWireService, type Scope } from '@kiki/agent-core-v2';
import { decodeHistoryDirectoryCursor, encodeHistoryDirectoryCursor, type IHistoryDirectory, type HistoryDirectoryRequest, type HistoryDirectoryPage, type HistoryDirectoryTurn } from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter, isPlainAgentId } from '@kiki/transcript';
import { streamWireRecords } from '@kiki/transcript-live/wireRecords';

const MAX_BYTES = 2 << 20;
const MAX_RECORDS = 10_000;
const MAX_LINE_BYTES = 256 << 10;
const MAX_AGENT_ENTRIES = 256;

export function createPrintHistoryDirectory(getApp: () => Scope): IHistoryDirectory {
  return {
    _serviceBrand: undefined,
    async list(request) {
      request.signal?.throwIfAborted();
      const { cursor: cursorText, signal, ...selection } = request;
      const cursor = cursorText === undefined ? undefined : decodeHistoryDirectoryCursor(cursorText);
      if (cursor !== undefined && (['workspaceId', 'sessionId', 'kind', 'agentId', 'beforeTurn', 'afterTurn', 'at', 'order', 'limit'] as const)
        .some((key) => cursor.request[key] !== selection[key])) throw new Error('HistoryList cursor conflicts with the requested directory.');
      const app = getApp();
      const live = app.accessor.get(ISessionManager).get(request.sessionId);
      const context = live?.accessor.get(ISessionContext);
      const summary = context === undefined ? await app.accessor.get(ISessionIndex).get(request.sessionId, request.workspaceId) : undefined;
      const workspaceId = context?.workspaceId ?? summary?.workspaceId;
      if (workspaceId !== request.workspaceId || !safeId(workspaceId) || !safeId(request.sessionId)) return unavailable(request, 'session_unavailable');
      const sessionDir = context?.sessionDir ?? join(app.accessor.get(IBootstrapService).sessionsDir, workspaceId, request.sessionId);
      if (request.kind === 'agents') {
        const entries: string[] = [];
        try {
          const directory = await opendir(join(sessionDir, 'agents'));
          let inspected = 0;
          for await (const entry of directory) {
            signal?.throwIfAborted();
            if (entry.isDirectory() && isPlainAgentId(entry.name)) entries.push(entry.name);
            inspected += 1;
            if (inspected >= MAX_AGENT_ENTRIES) break;
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          return unavailable(request, ioGap(error));
        }
        const ordered = entries.toSorted((left, right) => left.localeCompare(right));
        if (request.order === 'newest') ordered.reverse();
        const after = cursor?.afterAgent?.agentId;
        const filtered = after === undefined ? ordered : ordered.filter((id) => request.order === 'newest' ? id.localeCompare(after) < 0 : id.localeCompare(after) > 0);
        const page = filtered.slice(0, request.limit);
        return {
          status: 'partial', source: 'transcript', target: { workspaceId, sessionId: request.sessionId },
          coverage: { complete: false, domain: 'directory', gaps: ['navigation_unavailable', 'bounded_agent_roster'] },
          agents: page.map((agentId) => ({ agentId, indexed: false })),
          nextCursor: filtered.length > page.length ? encodeHistoryDirectoryCursor({ v: 1, request: selection, afterAgent: { agentId: page.at(-1)! } }) : undefined,
        };
      }
      const agentId = request.agentId;
      if (agentId === undefined || !isPlainAgentId(agentId)) return unavailable(request, 'agent_unavailable');
      const transcript = new AgentTranscriptDraft(agentId);
      const reducer = new TranscriptFactReducer(transcript);
      const adapter = new TranscriptWireAdapter(agentId, {
        turn: (turnId) => transcript.getTurn(turnId),
        tool: (toolCallId) => transcript.getToolCall(toolCallId),
        task: (taskId) => transcript.getTask(taskId),
      });
      try {
        const agent = live?.accessor.get(IAgentLifecycleService).get(agentId);
        await agent?.accessor.get(IWireService).flush();
        signal?.throwIfAborted();
        const read = await streamWireRecords(join(sessionDir, 'agents', agentId, 'wire.jsonl'), {
          maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS, maxLineBytes: MAX_LINE_BYTES, chunkBytes: 64 << 10, signal,
          onRecord: (record) => reducer.apply(adapter.add(record)),
        });
        reducer.apply(adapter.finish());
        const all: HistoryDirectoryTurn[] = transcript.snapshot().items.flatMap((item) => item.kind !== 'turn' ? [] : [{
          turn: item.ordinal, startedAt: item.startedAt, promptExcerpt: excerpt(item.prompt),
          answerExcerpt: excerpt(item.steps.flatMap((step) => step.frames).flatMap((frame) => frame.kind === 'text' && frame.role === 'assistant' ? [frame.text] : []).join(' ')),
          stepCount: item.steps.length, toolCount: item.steps.flatMap((step) => step.frames).filter((frame) => frame.kind === 'tool').length,
        }]);
        let filtered = all.filter((turn) => (request.beforeTurn === undefined || turn.turn < request.beforeTurn) &&
          (request.afterTurn === undefined || turn.turn > request.afterTurn))
          .toSorted((left, right) => request.order === 'newest' ? right.turn - left.turn : left.turn - right.turn);
        if (request.at !== undefined) {
          let nearest: number | undefined;
          let distance = Infinity;
          filtered.forEach((turn, index) => {
            if (turn.startedAt === undefined) return;
            const difference = Math.abs(Date.parse(turn.startedAt) - request.at!);
            if (difference < distance) { nearest = index; distance = difference; }
          });
          filtered = nearest === undefined ? [] : filtered.slice(nearest);
        }
        const after = cursor?.afterTurn;
        if (after !== undefined) filtered = filtered.filter((turn) => request.order === 'newest' ? turn.turn < after : turn.turn > after);
        const page = filtered.slice(0, request.limit);
        const ordinals = all.map((turn) => turn.turn);
        return {
          status: 'partial', source: 'transcript', target: { workspaceId, sessionId: request.sessionId, agentId },
          coverage: { complete: false, domain: 'directory', gaps: ['navigation_unavailable', 'refs_unavailable', 'bounded_cold_read', ...(read.incompleteReason === undefined ? [] : [read.incompleteReason])],
            scanned: { bytes: read.bytesRead, records: read.recordCount, turns: ordinals.length > 0 ? [Math.min(...ordinals), Math.max(...ordinals)] : undefined } },
          turns: page,
          nextCursor: filtered.length > page.length ? encodeHistoryDirectoryCursor({ v: 1, request: selection, afterTurn: page.at(-1)!.turn }) : undefined,
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return unavailable(request, ioGap(error));
      }
    },
  };
}

function unavailable(request: HistoryDirectoryRequest, gap: string): HistoryDirectoryPage {
  return {
    status: 'unavailable', source: 'transcript',
    target: { workspaceId: request.workspaceId, sessionId: request.sessionId, agentId: request.agentId },
    coverage: { complete: false, domain: 'directory', gaps: [gap] },
    turns: request.kind === 'turns' ? [] : undefined, agents: request.kind === 'agents' ? [] : undefined,
  };
}

function safeId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function ioGap(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? `wire_read_${error.code}` : 'wire_read_failed';
}

function excerpt(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
}

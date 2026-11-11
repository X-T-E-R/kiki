import { CodexClientError, type CodexAppServerClient, type CodexThreadForkParams, type CodexThreadResult } from '@kiki/codex-client';
import { isUndoAnchorOrigin } from '#/agent/contextMemory/conversationTime';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

export interface CodexRecordedTurn {
  readonly kikiTurnId: number;
  readonly codexTurnId: string;
  readonly isAnchor: boolean;
}

export type CodexRewindClient = Pick<CodexAppServerClient,
  'connect' | 'status' | 'resumeThread' | 'readThreadHistory' | 'readThreadHistoryMode' | 'forkThread' | 'rollbackThread'>;

export interface RewindCodexThreadInput {
  readonly client: CodexRewindClient;
  readonly threadId: string;
  readonly recordedTurns: readonly CodexRecordedTurn[];
  readonly journal: () => AsyncIterable<WireRecord>;
  readonly undoCount: number;
  readonly baseTurnCount?: number;
  readonly cwd: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly instructions: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface RewindCodexThreadResult {
  readonly threadId?: string;
  readonly survivingTurns: readonly CodexRecordedTurn[];
  readonly baseTurnCount: number;
  readonly approvalPolicy?: CodexThreadResult['approvalPolicy'];
  readonly sandbox?: CodexThreadResult['sandbox'];
  readonly model?: string;
  readonly modelProvider?: string;
}

export function readCodexTurnHistory(
  ref: { readonly ref: Readonly<Record<string, unknown>> } | undefined,
): CodexRecordedTurn[] {
  const raw = ref?.ref['kikiTurnHistory'];
  if (!Array.isArray(raw)) return [];
  const out: CodexRecordedTurn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kikiTurnId = record['kikiTurnId'];
    const codexTurnId = record['codexTurnId'];
    if (typeof kikiTurnId !== 'number' || !Number.isInteger(kikiTurnId) || kikiTurnId < 0 ||
        typeof codexTurnId !== 'string' || !codexTurnId) continue;
    out.push({ kikiTurnId, codexTurnId, isAnchor: record['isAnchor'] !== false });
  }
  return out;
}

/** Adapted from Paseo's Apache-2.0 rewind.ts for Kiki's durable undo facts and turn IDs. */
export async function rewindCodexThread(input: RewindCodexThreadInput): Promise<RewindCodexThreadResult> {
  let recordedTurns = input.recordedTurns;
  let baseTurnCount = input.baseTurnCount;
  if (baseTurnCount === undefined) {
    await input.client.connect(input.signal);
    const legacyTurns = await readLegacyTurns(input.journal(), input.threadId);
    const remoteTurns = new Map<string, string | undefined>();
    for await (const row of input.client.readThreadHistory(input.threadId, input.signal)) {
      if (row.turnId === undefined) continue;
      if (!remoteTurns.has(row.turnId)) remoteTurns.set(row.turnId, undefined);
      const item = row.item as { type?: string; content?: unknown } | undefined;
      if (item?.type === 'userMessage' && remoteTurns.get(row.turnId) === undefined) {
        remoteTurns.set(row.turnId, promptText(item.content));
      }
    }
    const remote = [...remoteTurns];
    baseTurnCount = remote.length - legacyTurns.length;
    const knownIds = new Map(recordedTurns.map((turn) => [turn.kikiTurnId, turn.codexTurnId]));
    recordedTurns = legacyTurns.map(({ kikiTurnId, isAnchor, text }, index) => {
      const match = remote[baseTurnCount! + index];
      const knownId = knownIds.get(kikiTurnId);
      if (match === undefined || (knownId !== undefined ? match[0] !== knownId : !matchesLegacyPrompt(match[1], text))) {
        throw new CodexClientError('protocol', 'Codex history does not match the saved Kiki prompts');
      }
      return { kikiTurnId, isAnchor, codexTurnId: match[0] };
    });
  }
  const anchors = recordedTurns.flatMap((turn, index) => turn.isAnchor ? [index] : []);
  const cut = anchors.at(-input.undoCount);
  if (cut === undefined) throw new CodexClientError('protocol', 'Codex undo target has no matching Kiki prompt boundary');
  const removedCount = recordedTurns.length - cut;
  const beforeTurnId = recordedTurns[cut]!.codexTurnId;
  const survivingTurns = recordedTurns.slice(0, cut);
  if (baseTurnCount + cut === 0) return { survivingTurns: [], baseTurnCount: 0 };

  await input.client.connect(input.signal);
  const inherited = input.modelProvider === undefined
    ? await input.client.resumeThread({ threadId: input.threadId, excludeTurns: true }, input.signal)
    : undefined;
  const modelProvider = input.modelProvider ?? inherited?.modelProvider;
  const model = input.model ?? inherited?.model;
  const forkBase: CodexThreadForkParams = {
    threadId: input.threadId, cwd: input.cwd, model: model ?? null,
    modelProvider: modelProvider ?? null,
    config: modelProvider === undefined ? undefined : { model_provider: modelProvider },
    baseInstructions: input.instructions['baseInstructions'] ?? null,
    developerInstructions: input.instructions['developerInstructions'] ?? null,
    excludeTurns: true, persistExtendedHistory: true,
  };
  const historyMode = await input.client.readThreadHistoryMode(input.threadId, input.signal);
  const version = /^(\d+)\.(\d+)/.exec(input.client.status().agentVersion ?? '');
  const rollbackRemoved = version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 156);
  const forkAtTurn = historyMode === 'paginated' || rollbackRemoved;
  const forked = await input.client.forkThread({
    ...forkBase, beforeTurnId: forkAtTurn ? beforeTurnId : undefined,
  }, input.signal);
  if (modelProvider !== undefined && forked.modelProvider !== undefined && forked.modelProvider !== modelProvider) {
    throw new CodexClientError('protocol', 'Codex fork changed the selected model provider');
  }
  const threadId = forkAtTurn ? forked.thread.id : (await input.client.rollbackThread({
    threadId: forked.thread.id, numTurns: removedCount,
  }, input.signal)).thread.id;
  return {
    threadId, survivingTurns, baseTurnCount,
    approvalPolicy: forked.approvalPolicy, sandbox: forked.sandbox,
    model: forked.model ?? model, modelProvider: forked.modelProvider ?? modelProvider,
  };
}

interface LegacyCodexPrompt {
  readonly kikiTurnId: number;
  readonly isAnchor: boolean;
  readonly text: string | undefined;
}

async function readLegacyTurns(journal: AsyncIterable<WireRecord>, threadId: string): Promise<LegacyCodexPrompt[]> {
  const turns = new Map<number, LegacyCodexPrompt>();
  let prompt: LegacyCodexPrompt | undefined;
  for await (const record of journal) {
    if (record.type === 'turn.prompt' && typeof record['turnId'] === 'number') {
      prompt = { kikiTurnId: record['turnId'], isAnchor: isUndoAnchorOrigin(record['origin'] as PromptOrigin),
        text: promptText(record['input']) };
    }
    if (record.type !== 'executor.session.updated' || prompt === undefined || record['profileDeliveredSessionId'] !== threadId) continue;
    const sessionRef = record['sessionRef'] as { ref?: { threadId?: string } } | undefined;
    if (sessionRef?.ref?.threadId === threadId) turns.set(prompt.kikiTurnId, prompt);
  }
  return [...turns.values()];
}

function promptText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  return parts.flatMap((part: { type?: unknown; text?: unknown } | null) =>
    part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

function matchesLegacyPrompt(remote: string | undefined, local: string | undefined): boolean {
  return remote !== undefined && local !== undefined && (remote === local ||
    (remote.startsWith('--- BEGIN KIKI ') && remote.endsWith(`\n\n${local}`)));
}

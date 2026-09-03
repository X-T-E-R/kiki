import type { AgentTranscriptResponse } from '../../transport';
import type { Block, SpawnInstruction, ToolBlock } from './types';

function spawnInstructionFromToolArgs(args: unknown, agentId: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const prompt = record['prompt'] ?? record['instruction'];
  if (typeof prompt === 'string' && prompt.trim() !== '') return prompt.trim();
  const resumeMap = record['resume_agent_ids'];
  if (typeof resumeMap === 'object' && resumeMap !== null) {
    const resumed = (resumeMap as Record<string, unknown>)[agentId];
    if (typeof resumed === 'string' && resumed.trim() !== '') return resumed.trim();
  }
  const template = record['prompt_template'];
  if (typeof template === 'string' && template.trim() !== '') return template.trim();
  return undefined;
}

export function resolveSpawnInstruction(input: {
  response: AgentTranscriptResponse | undefined;
  blocks: readonly Block[];
  agentId: string;
  parentToolCallId: string | undefined;
}): SpawnInstruction | undefined {
  const firstTurn = input.response?.items.find((item) => item.kind === 'turn');
  const firstPromptTurn = input.response?.items.find(
    (item) => item.kind === 'turn' && typeof item.prompt === 'string' && item.prompt.trim() !== '',
  );
  if (firstPromptTurn !== undefined && firstPromptTurn.kind === 'turn' && typeof firstPromptTurn.prompt === 'string') {
    const rawTurnId = firstPromptTurn.turnId;
    const turnIds = [...new Set([rawTurnId, rawTurnId.replace(/^t/, '')])];
    const duplicateBlockIds: string[] = [];
    for (const turnId of turnIds) {
      for (const prefix of ['user-turn-', 'system-turn-', 'user-agent-turn-', 'system-agent-turn-']) {
        duplicateBlockIds.push(`${prefix}${turnId}-prompt`);
      }
    }
    return {
      text: firstPromptTurn.prompt.trim(),
      source: 'transcript',
      turnId: firstPromptTurn.turnId,
      duplicateBlockIds,
    };
  }
  const spawnCall = input.blocks.find(
    (block): block is ToolBlock =>
      block.kind === 'tool' &&
      ((input.parentToolCallId !== undefined && block.toolCallId === input.parentToolCallId) ||
        (block.agentRefs?.some((ref) => ref.agentId === input.agentId) ?? false)),
  );
  if (spawnCall === undefined) return undefined;
  const text = spawnInstructionFromToolArgs(spawnCall.args, input.agentId);
  if (text === undefined) return undefined;
  return {
    text,
    source: 'spawn-call',
    turnId: firstTurn?.kind === 'turn' ? firstTurn.turnId : undefined,
    duplicateBlockIds: [],
  };
}

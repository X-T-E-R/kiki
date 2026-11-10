export const SUBAGENT_PARENT_STEERING_VARIANT = 'subagent_parent_steering';

export function formatSubagentParentSteering(input: {
  readonly agentId?: string;
  readonly label?: string;
  readonly profile?: string;
  readonly delivery: 'return' | 'message';
  readonly content: string;
}): string {
  const body = input.content.trim();
  const who = [
    input.label !== undefined && input.label.trim().length > 0 ? `"${input.label.trim()}"` : undefined,
    input.profile !== undefined && input.profile.trim().length > 0 ? `profile: ${input.profile.trim()}` : undefined,
    input.agentId !== undefined && input.agentId.trim().length > 0 ? `id: ${input.agentId.trim()}` : undefined,
  ].filter((part): part is string => part !== undefined).join(', ');
  const header = input.delivery === 'message'
    ? `Subagent upward-message guidance${who.length > 0 ? ` (${who})` : ''}:`
    : `Subagent return guidance${who.length > 0 ? ` (${who})` : ''}:`;
  return `${header}\n${body}`;
}

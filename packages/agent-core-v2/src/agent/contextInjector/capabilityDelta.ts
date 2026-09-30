import type { ContextMessage } from '#/agent/contextMemory/types';

export const CAPABILITY_PROVIDERS = new Set(['loadable-tools', 'capabilities_rebuilt', 'profile_capabilities_changed', 'agent_profile_changes', 'plugin_change', 'plugin_session_start']);
export interface CapabilityDeltaPart { readonly variant: string; readonly content: string; readonly disclosure?: unknown }
export function capabilityDeltaParts(message: ContextMessage): readonly CapabilityDeltaPart[] {
  if (message.origin?.kind !== 'injection' || message.origin.variant !== 'capability_delta') return [];
  return (message.origin.disclosure as { parts?: readonly CapabilityDeltaPart[] } | undefined)?.parts ?? [];
}
export function capabilitySourceMessage(message: ContextMessage, variant: string): ContextMessage | undefined {
  if (message.origin?.kind === 'injection' && message.origin.variant === variant) return message;
  const part = capabilityDeltaParts(message).find((item) => item.variant === variant);
  return part === undefined ? undefined : { ...message,
    content: [{ type: 'text', text: `<system-reminder>\n${part.content}\n</system-reminder>` }],
    origin: { kind: 'injection', variant, disclosure: part.disclosure } };
}

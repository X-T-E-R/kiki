import { normalizeAgentProfile, type AgentProfile } from './agentProfile';

export function nativeTargetName(executorId: string): string {
  return `engine:${executorId}`;
}

export function isNativeTarget(profile: Pick<AgentProfile, 'name' | 'executor' | 'configuration'>): boolean {
  return profile.configuration === 'native' && profile.executor !== undefined
    && profile.executor !== 'native' && profile.name === nativeTargetName(profile.executor);
}

export function nativeTargets(descriptors: readonly { readonly id: string; readonly protocol: string; readonly label?: string }[]): readonly AgentProfile[] {
  return descriptors.filter((descriptor) => descriptor.protocol !== 'native').map((descriptor) => normalizeAgentProfile({
    name: nativeTargetName(descriptor.id),
    executor: descriptor.id,
    configuration: 'native',
    description: `${descriptor.label ?? descriptor.id} · Native. Use the engine's own configuration without a Kiki role profile.`,
    systemPrompt: () => '',
  }));
}

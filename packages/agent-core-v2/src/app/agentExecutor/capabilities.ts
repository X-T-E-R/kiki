import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type {
  ExecutorControlApplicability,
  ExecutorCapabilityControls,
} from '@kiki/agent-profiles/ports';
import type { AgentExecutorDescriptor, ExecutorPromptDelivery } from './agentExecutor';

export interface ExecutorCapabilities {
  readonly promptDeliveries: readonly ExecutorPromptDelivery[];
  readonly steer: 'native' | 'next_turn_preamble';
  readonly permission: AgentExecutorDescriptor['permission'];
  readonly modelBinding: string | undefined;
  readonly thinkingBinding: boolean;
}

export interface NegotiatedExecutorCapabilities {
  readonly agentVersion?: string;
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly fork?: boolean;
  readonly nativeSteering?: boolean;
  readonly questionForm?: boolean;
  readonly planApproval?: boolean;
  readonly models?: readonly string[];
  readonly thinkingLevels?: readonly string[];
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly compactionThreshold?: number;
  readonly controls?: {
    readonly modelSwitch?: boolean;
    readonly thinkingSwitch?: boolean;
    readonly manualCompact?: boolean;
  };
  readonly authMethods?: readonly string[];
  readonly resume?: boolean;
  readonly load?: boolean;
  readonly permissionModes?: readonly string[];
}

export function executorControlCapabilities(descriptor: AgentExecutorDescriptor): ExecutorCapabilityControls {
  const declared = descriptor.controlCapabilities;
  const control = (applicability: ExecutorControlApplicability | undefined, argvFallback = false) => {
    const effective = applicability ?? (argvFallback ? 'fresh_binding' : undefined);
    if (effective === undefined || effective === 'unknown') {
      return { applicability: 'unknown' as const, applyState: 'unknown' as const };
    }
    if (effective === 'unsupported') {
      return { advertised: false, applicability: effective, applyState: 'unsupported' as const };
    }
    return { advertised: true, applicability: effective, applyState: 'unknown' as const };
  };
  return {
    modelSwitch: control(declared?.modelSwitch, descriptor.modelBinding === 'argv'),
    thinkingSwitch: control(declared?.thinkingSwitch),
    manualCompact: control(declared?.manualCompact),
  };
}

export function executorCapabilities(descriptor: AgentExecutorDescriptor): ExecutorCapabilities {
  return {
    promptDeliveries: descriptor.promptDeliveries ?? (descriptor.protocol === 'codex-app-server'
      ? ['append', 'replace', 'preamble'] : descriptor.profileDelivery === 'system_prompt_override'
        ? ['replace', 'preamble'] : ['preamble']),
    steer: descriptor.steerDelivery ?? (descriptor.protocol === 'codex-app-server' ? 'native' : 'next_turn_preamble'),
    permission: descriptor.permission,
    modelBinding: descriptor.modelBinding ?? (descriptor.protocol === 'codex-app-server' ? 'turn_param' : undefined),
    thinkingBinding: descriptor.protocol === 'codex-app-server' || descriptor.thoughtConfigId !== undefined
      || descriptor.thoughtConfigCategory !== undefined,
  };
}

export function resolvePromptDelivery(descriptor: AgentExecutorDescriptor, binding: Pick<ProfileBindingSnapshot, 'executorPrompt'>): {
  readonly requested: ExecutorPromptDelivery;
  readonly actual: ExecutorPromptDelivery;
  readonly downgraded: boolean;
} {
  const explicit = binding.executorPrompt?.per_engine?.[descriptor.id]?.delivery ?? binding.executorPrompt?.delivery;
  const requested = explicit ?? (descriptor.profileDelivery === 'system_prompt_override' ? 'replace'
    : descriptor.protocol === 'codex-app-server' ? 'append' : 'preamble');
  const supported = executorCapabilities(descriptor).promptDeliveries;
  const actual = supported.includes(requested) ? requested : supported.includes('preamble') ? 'preamble' : supported[0];
  if (actual === undefined) throw new Error(`Executor ${descriptor.id} has no prompt delivery method`);
  return { requested, actual, downgraded: requested !== actual };
}

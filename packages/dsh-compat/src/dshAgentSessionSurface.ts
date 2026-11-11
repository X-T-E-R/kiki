import type { Branded } from './vendor/brand/src/index';
import { brandString } from './vendor/brand/src/index';
import type { DshLiveAgentFacade } from './index';

export type SessionId = Branded<'SessionId'>;
export type SessionSeq = Branded<'SessionSeq'>;

export function SessionId(id: string): SessionId {
  return brandString<SessionId>(id);
}

export function SessionSeq(seq: string): SessionSeq {
  return brandString<SessionSeq>(seq);
}

export type Agent = DshLiveAgentFacade & {
  readonly options: Readonly<{
    readonly provider?: string;
    readonly model?: string;
  }>;
};

export interface AgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
}

export type PreStepDecision =
  | { readonly kind: 'reject' }
  | {
      readonly kind: 'enter';
      readonly messages: unknown[];
      readonly startsRequestSeries?: true;
    };

export type Session = DshLiveAgentFacade['session'];
export type { UserMessage } from './vendor/llm/src/message';

export type FsTargetKey = Branded<'FsTargetKey'>;
export type FsVersion = Branded<'FsVersion'>;

export function FsTargetKey(key: string): FsTargetKey {
  return brandString<FsTargetKey>(key);
}

export function FsVersion(version: string): FsVersion {
  return brandString<FsVersion>(version);
}

export class SubprocessExecutableNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubprocessExecutableNotFoundError';
  }
}

export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
export const DSH_ENV_PREFIX = 'DSH_' as const;

export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) {
      env[key] = value;
    }
  }
  return env;
}

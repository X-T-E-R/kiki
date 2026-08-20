import { isAbsolute, join, normalize } from 'pathe';

import { TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { DelegatorRef } from '#/session/sessionMetadata/sessionMetadata';
import { isWithinDirectory } from '#/tool/path-access';

export type DelegationPosition = 'main' | 'sub' | 'independent';

export type DelegationNotice = 'auto' | 'off';

export type DelegationSlotConfig = string | false;

export interface AgentsDelegationConfig {
  readonly sub?: DelegationSlotConfig;
  readonly independent?: DelegationSlotConfig;
}

export const DELEGATION_CONTEXT_TOKEN = '${delegation_context}';

export const DEFAULT_INDEPENDENT_DELEGATION_NOTICE =
  'You are running as an independent agent invoked by an external host. There is no parent agent. Your final message is the deliverable the host will receive.';

export type DelegationFileErrorReason = 'missing' | 'escape' | 'absolute' | 'empty';

export class DelegationFileError extends Error {
  constructor(
    readonly reason: DelegationFileErrorReason,
    readonly slot: 'sub' | 'independent',
    readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationFileError';
  }
}

export function resolveDelegationPosition(
  agentId: string,
  delegator: DelegatorRef | undefined,
): DelegationPosition {
  if (agentId === MAIN_AGENT_ID) return 'main';
  if (delegator?.kind === 'external') return 'independent';
  return 'sub';
}

export function injectDelegationContext(text: string, snippet: string | undefined): string {
  if (snippet === undefined || snippet.length === 0) {
    if (!text.includes(DELEGATION_CONTEXT_TOKEN)) return text;
    return text.replaceAll(DELEGATION_CONTEXT_TOKEN, '').replace(/\n{3,}/g, '\n\n');
  }
  if (text.includes(DELEGATION_CONTEXT_TOKEN)) {
    return text.replaceAll(DELEGATION_CONTEXT_TOKEN, snippet);
  }
  return `${snippet}\n\n${text}`;
}

export async function resolveDelegationSnippet(input: {
  readonly position: DelegationPosition;
  readonly notice?: DelegationNotice;
  readonly config?: AgentsDelegationConfig;
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
  readonly pathClass: PathClass;
}): Promise<string | undefined> {
  if (input.position === 'main') return undefined;
  if (input.notice === 'off') return undefined;
  const slot = input.position;
  const declared = slot === 'sub' ? input.config?.sub : input.config?.independent;
  if (declared === false) return undefined;
  if (declared === undefined) {
    return slot === 'sub' ? TASK_AGENT_ROLE_PREFIX : DEFAULT_INDEPENDENT_DELEGATION_NOTICE;
  }
  return readDelegationFile(input.fs, input.homeDir, declared, input.pathClass, slot);
}

async function readDelegationFile(
  fs: IHostFileSystem,
  homeDir: string,
  ref: string,
  pathClass: PathClass,
  slot: 'sub' | 'independent',
): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new DelegationFileError('empty', slot, ref, `agents.delegation.${slot} path is empty`);
  }
  if (isAbsolute(trimmed)) {
    throw new DelegationFileError(
      'absolute',
      slot,
      trimmed,
      `agents.delegation.${slot} path "${trimmed}" must be relative to the Kiki home directory`,
    );
  }
  const home = normalize(homeDir);
  const lexical = normalize(join(home, trimmed));
  if (!isWithinDirectory(lexical, home, pathClass)) {
    throw new DelegationFileError(
      'escape',
      slot,
      trimmed,
      `agents.delegation.${slot} path "${trimmed}" escapes the Kiki home directory`,
    );
  }
  let real: string;
  try {
    real = normalize(await fs.realpath(lexical));
  } catch {
    throw new DelegationFileError(
      'missing',
      slot,
      trimmed,
      `agents.delegation.${slot} file "${trimmed}" was not found under the Kiki home directory`,
    );
  }
  if (!isWithinDirectory(real, home, pathClass)) {
    throw new DelegationFileError(
      'escape',
      slot,
      trimmed,
      `agents.delegation.${slot} path "${trimmed}" escapes the Kiki home directory`,
    );
  }
  const text = (await fs.readText(real)).trim();
  if (text.length === 0) {
    throw new DelegationFileError(
      'empty',
      slot,
      trimmed,
      `agents.delegation.${slot} file "${trimmed}" is empty`,
    );
  }
  return text;
}

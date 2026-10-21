import picomatch from 'picomatch';
import { isBrowserOperationToolName } from '@kiki/agent-profiles/toolPolicy';

export const OPTIONAL_CAPABILITY_IDS = ['browser', 'computer', 'memory', 'thread', 'web'] as const;
export type OptionalCapabilityId = typeof OPTIONAL_CAPABILITY_IDS[number];
export type CapabilityChoice = 'on' | 'off' | 'inherit';
export type ProfileToolsSource = 'declared' | 'inherited-default' | 'builtin-default';
export const LOCAL_CAPABILITY_HOST = 'local';
export const OPTIONAL_CAPABILITY_DOCUMENT_SCOPE = 'session-optional-capabilities';

export function optionalCapabilityDocumentKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}

const MEMORY_TOOLS = new Set(['MemoryRead', 'MemorySearch', 'MemoryWrite']);
const THREAD_TOOLS = new Set(['ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait', 'ThreadCreate']);
const WEB_TOOLS = new Set(['WebSearch', 'FetchURL']);
const GLOB_MAGIC = /[*?[\]{}]/;
const COMPUTER_SAMPLE = 'mcp__kiki-computer__screenshot';

export interface CapabilityAdmissionInput {
  readonly allowed: boolean;
  readonly hostLocked: boolean;
  readonly defaultOn: boolean;
  readonly sessionChoice: CapabilityChoice;
  readonly workspaceHardOff: boolean;
  readonly agentKind: 'main' | 'child';
  readonly toolsSource: ProfileToolsSource | undefined;
  readonly declaredTools: readonly string[] | undefined;
  readonly taskTools: readonly string[] | undefined;
  readonly unresolved: boolean;
}

export type CapabilityDenyReason =
  | 'host_locked'
  | 'allowed_off'
  | 'workspace_off'
  | 'session_off'
  | 'default_off'
  | 'origin_unreadable';

export interface CapabilityAdmission {
  readonly admitted: boolean;
  readonly reason: CapabilityDenyReason | 'admitted';
}

export function isOptionalCapabilityId(value: string): value is OptionalCapabilityId {
  return (OPTIONAL_CAPABILITY_IDS as readonly string[]).includes(value);
}

export function optionalCapabilityForTool(name: string): OptionalCapabilityId | undefined {
  if (name === 'BrowserConnections' || name === 'BrowserTabs' || name === 'browser__*' || isBrowserOperationToolName(name) || name.startsWith('browser__')) return 'browser';
  if (name.startsWith('mcp__kiki-computer__') || name.startsWith('mcp__kiki-computer')) return 'computer';
  if (MEMORY_TOOLS.has(name)) return 'memory';
  if (THREAD_TOOLS.has(name)) return 'thread';
  if (WEB_TOOLS.has(name)) return 'web';
  return undefined;
}

export function namesOptionalCapability(id: OptionalCapabilityId, tools: readonly string[] | undefined): boolean {
  if (tools === undefined) return false;
  return tools.some((pattern) => pattern !== '*' && namesPattern(id, pattern));
}

export function admitOptionalCapability(id: OptionalCapabilityId, input: CapabilityAdmissionInput): CapabilityAdmission {
  if (input.unresolved) return { admitted: false, reason: 'origin_unreadable' };
  if (input.hostLocked && !input.allowed) return { admitted: false, reason: 'host_locked' };
  if (!input.allowed) return { admitted: false, reason: 'allowed_off' };
  if (input.workspaceHardOff) return { admitted: false, reason: 'workspace_off' };
  if (input.sessionChoice === 'off') {
    if (input.agentKind === 'child' && namesOptionalCapability(id, input.taskTools)) return { admitted: true, reason: 'admitted' };
    return { admitted: false, reason: 'session_off' };
  }
  if (input.sessionChoice === 'on') return { admitted: true, reason: 'admitted' };
  if (input.defaultOn) return { admitted: true, reason: 'admitted' };
  const declared = input.toolsSource === 'declared' && namesOptionalCapability(id, input.declaredTools);
  if (declared || namesOptionalCapability(id, input.taskTools)) return { admitted: true, reason: 'admitted' };
  return { admitted: false, reason: 'default_off' };
}

function namesPattern(id: OptionalCapabilityId, pattern: string): boolean {
  if (id === 'browser') {
    return pattern === 'BrowserConnections' || pattern === 'BrowserTabs' || pattern === 'browser__*' || isBrowserOperationToolName(pattern);
  }
  if (id === 'computer') {
    if (pattern === 'mcp__*' || pattern.startsWith('mcp__kiki-computer')) return true;
    return pattern.startsWith('mcp__') && GLOB_MAGIC.test(pattern) && picomatch.isMatch(COMPUTER_SAMPLE, pattern);
  }
  if (id === 'memory') return MEMORY_TOOLS.has(pattern);
  if (id === 'thread') return THREAD_TOOLS.has(pattern);
  return WEB_TOOLS.has(pattern);
}

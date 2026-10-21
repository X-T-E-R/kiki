import picomatch from 'picomatch';
import { DEFAULT_AGENT_PROFILE_NAME } from '@kiki/agent-profiles/agentProfile';
import { isBrowserOperationToolName } from '@kiki/agent-profiles/toolPolicy';
import { qualifyMcpToolName, sanitizeMcpNamePart } from '#/mcpCore/tool-naming';

export const OPTIONAL_CAPABILITY_IDS = ['browser', 'computer', 'memory', 'thread', 'web'] as const;
export type OptionalCapabilityId = typeof OPTIONAL_CAPABILITY_IDS[number];
export type CapabilityChoice = 'on' | 'off' | 'inherit';
export type ProfileToolsSource = 'declared' | 'inherited-default' | 'builtin-default';
export const LOCAL_CAPABILITY_HOST = 'local';
export const OPTIONAL_CAPABILITY_DOCUMENT_SCOPE = 'session-optional-capabilities';

export function optionalCapabilityDocumentKey(hostId: string, sessionId: string): string {
  return `v1-${Buffer.from(JSON.stringify([hostId, sessionId]), 'utf8').toString('hex')}.json`;
}

const MEMORY_TOOLS = new Set(['MemoryRead', 'MemorySearch', 'MemoryWrite']);
const THREAD_TOOLS = new Set(['ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait']);
const WEB_TOOLS = new Set(['WebSearch', 'FetchURL']);
const GLOB_MAGIC = /[*?[\]{}]/;

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
  readonly computerServers?: readonly string[];
}

export type CapabilityDenyReason =
  | 'host_locked'
  | 'allowed_off'
  | 'workspace_off'
  | 'session_off'
  | 'default_off'
  | 'origin_unreadable'
  | 'unbound';

export interface CapabilityAdmission {
  readonly admitted: boolean;
  readonly reason: CapabilityDenyReason | 'admitted';
}

export function isOptionalCapabilityId(value: string): value is OptionalCapabilityId {
  return (OPTIONAL_CAPABILITY_IDS as readonly string[]).includes(value);
}

export function optionalCapabilityForTool(name: string, computerServers: readonly string[] = []): OptionalCapabilityId | undefined {
  if (name === 'BrowserConnections' || name === 'BrowserTabs' || name === 'browser__*' || isBrowserOperationToolName(name) || name.startsWith('browser__')) return 'browser';
  if (namesComputer(name, computerServers)) return 'computer';
  if (MEMORY_TOOLS.has(name)) return 'memory';
  if (THREAD_TOOLS.has(name)) return 'thread';
  if (WEB_TOOLS.has(name)) return 'web';
  return undefined;
}

export function capabilityToolsSource(
  source: ProfileToolsSource | undefined,
  profile: {
    readonly name?: string;
    readonly sourcePath?: string;
    readonly definitionId?: string;
    readonly tools?: readonly string[];
    readonly fileDefinition?: { readonly tools?: readonly string[] };
  } | undefined,
  isCleanDefaultPath: (path: string) => boolean,
): ProfileToolsSource | undefined {
  const path = profile?.sourcePath ?? profile?.definitionId;
  if (source !== 'declared' || profile?.name !== DEFAULT_AGENT_PROFILE_NAME || path === undefined || !isCleanDefaultPath(path)) return source;
  const fileTools = profile.fileDefinition?.tools;
  if (fileTools !== undefined && !sameToolNames(profile.tools, fileTools)) return source;
  return 'builtin-default';
}

function sameToolNames(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function namesOptionalCapability(
  id: OptionalCapabilityId,
  tools: readonly string[] | undefined,
  computerServers?: readonly string[],
): boolean {
  if (tools === undefined) return false;
  return tools.some((pattern) => pattern !== '*' && namesPattern(id, pattern, computerServers ?? []));
}

export function admitOptionalCapability(id: OptionalCapabilityId, input: CapabilityAdmissionInput): CapabilityAdmission {
  if (input.unresolved) return { admitted: false, reason: 'origin_unreadable' };
  if (input.hostLocked && !input.allowed) return { admitted: false, reason: 'host_locked' };
  if (!input.allowed) return { admitted: false, reason: 'allowed_off' };
  if (input.workspaceHardOff) return { admitted: false, reason: 'workspace_off' };
  if (input.sessionChoice === 'off') {
    if (input.agentKind === 'child' && namesOptionalCapability(id, input.taskTools, input.computerServers)) return { admitted: true, reason: 'admitted' };
    return { admitted: false, reason: 'session_off' };
  }
  if (input.sessionChoice === 'on') return { admitted: true, reason: 'admitted' };
  if (input.defaultOn) return { admitted: true, reason: 'admitted' };
  const declared = input.toolsSource === 'declared' && namesOptionalCapability(id, input.declaredTools, input.computerServers);
  if (declared || namesOptionalCapability(id, input.taskTools, input.computerServers)) return { admitted: true, reason: 'admitted' };
  return { admitted: false, reason: 'default_off' };
}

function namesPattern(id: OptionalCapabilityId, pattern: string, computerServers: readonly string[]): boolean {
  if (id === 'browser') {
    return pattern === 'BrowserConnections' || pattern === 'BrowserTabs' || pattern === 'browser__*' || isBrowserOperationToolName(pattern);
  }
  if (id === 'computer') return namesComputer(pattern, computerServers);
  if (id === 'memory') return MEMORY_TOOLS.has(pattern);
  if (id === 'thread') return THREAD_TOOLS.has(pattern);
  return WEB_TOOLS.has(pattern);
}

function namesComputer(pattern: string, servers: readonly string[]): boolean {
  if (pattern === '*' || servers.length === 0) return false;
  return servers.some((name) => {
    const qualified = sanitizeMcpNamePart(name);
    const sample = qualifyMcpToolName(name, 'screenshot');
    if (pattern === sample || pattern === `mcp__${qualified}` || pattern === `mcp__${qualified}__*`) return true;
    return pattern.startsWith('mcp__') && GLOB_MAGIC.test(pattern) && picomatch.isMatch(sample, pattern);
  });
}

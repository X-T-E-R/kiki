import { join } from 'pathe';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfile,
} from './agentProfile';
import { parseAgentFileText } from './agentFile';
import { agentProfileFromFile } from './agentProfileFromFile';
import { parseFrontmatter } from './frontmatter';
import type { SkippedAgentFile } from './agentFileTypes';
import type { HostFs } from './hostFs';
import { isHostFsUnavailable } from './hostFs';
import { isFilePath } from './paths';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

export async function loadSystemMdProfile(
  fs: HostFs,
  brandHome: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
  onError?: (failure: SkippedAgentFile) => void,
): Promise<AgentProfile | undefined> {
  const path = join(brandHome, SYSTEM_MD_FILENAME);
  const report = (phase: string, error: unknown): void => {
    const reason = `agent SYSTEM.md ${phase} failed: ${String(error)} [${path}]`;
    warn(reason);
    onError?.({ path, reason, code: 'agent_profile.system_invalid' });
  };
  let text: string;
  try {
    if (!(await isFilePath(fs, path))) return undefined;
    text = await fs.readFile(path);
  } catch (error) {
    if (isHostFsUnavailable(error)) throw error;
    report('load', error);
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  try {
    return parseSystemMdProfile(text, path, builtinDefault, warn);
  } catch (error) {
    report('parse', error);
    return undefined;
  }
}

export function parseSystemMdProfile(
  text: string,
  path: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): AgentProfile {
  return loadUpgradedSystemMd(text, path, builtinDefault, warn);
}

function loadUpgradedSystemMd(
  text: string,
  path: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): AgentProfile {
  const parsed = parseFrontmatter(text);
  if (!isRecord(parsed.data)) {
    throw new Error('SYSTEM.md requires frontmatter mapping');
  }
  const declaredName =
    typeof parsed.data['name'] === 'string' && parsed.data['name'].trim() !== ''
      ? parsed.data['name'].trim()
      : undefined;
  if (declaredName !== undefined && declaredName !== DEFAULT_AGENT_PROFILE_NAME) {
    warn(
      `agent SYSTEM.md name "${declaredName}" is ignored; using "${DEFAULT_AGENT_PROFILE_NAME}" [${path}]`,
    );
  }
  if (parsed.data['override'] === false) {
    warn(`agent SYSTEM.md override false is ignored; SYSTEM.md always overrides [${path}]`);
  }
  const definition = parseAgentFileText({
    path,
    source: 'user',
    text,
    warn,
    fallbackDescription: builtinDefault.description,
    forceName: DEFAULT_AGENT_PROFILE_NAME,
    forceOverride: true,
  });
  const main = definition.main ?? builtinDefault.main;
  if (main === true && definition.executor !== undefined && definition.executor !== 'native') {
    throw new Error(`External executor "${definition.executor}" is unsupported for main agent profile ${path}`);
  }
  return agentProfileFromFile(
    {
      ...definition,
      main,
      tools: Object.hasOwn(parsed.data, 'tools') ? definition.tools : builtinDefault.tools,
      disallowedTools: Object.hasOwn(parsed.data, 'disallowedTools')
        ? definition.disallowedTools
        : builtinDefault.disallowedTools,
      subagentDeclaration: definition.subagentPolicy === undefined
        ? undefined
        : Object.hasOwn(parsed.data, 'subagents')
          ? definition.subagentDeclaration
          : builtinDefault.subagentDeclaration ?? (builtinDefault.subagents === undefined
            ? { kind: 'all' }
            : { kind: 'set', names: builtinDefault.subagents }),
      subagents: Object.hasOwn(parsed.data, 'subagents')
        ? definition.subagents
        : builtinDefault.subagents,
      subagentLeases: Object.hasOwn(parsed.data, 'subagents')
        ? definition.subagentLeases
        : builtinDefault.subagentLeases,
      spawnConstraints: Object.hasOwn(parsed.data, 'spawn_constraints')
        ? definition.spawnConstraints
        : builtinDefault.spawnConstraints,
    },
    (context) => builtinDefault.renderSystemPrompt(context),
    (context) => builtinDefault.renderSystemPrompt(context),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

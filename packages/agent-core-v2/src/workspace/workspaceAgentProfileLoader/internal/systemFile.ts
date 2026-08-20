import { join } from 'pathe';

import { FrontmatterError, parseFrontmatter } from '#/_base/text/frontmatter';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  renderPromptTemplateResult,
  skillActiveFor,
} from '#/app/agentProfileCatalog/profile-shared';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { parseAgentFileText } from './agentFile';
import { agentProfileFromFile } from './agentProfileFromFile';
import { isFilePath } from './paths';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

export async function loadSystemMdProfile(
  fs: IHostFileSystem,
  brandHome: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): Promise<AgentProfile | undefined> {
  const path = join(brandHome, SYSTEM_MD_FILENAME);
  let text: string;
  try {
    if (!(await isFilePath(fs, path))) return undefined;
    text = await fs.readText(path);
  } catch (error) {
    if (
      error instanceof HostFsError &&
      error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE
    ) {
      throw error;
    }
    warn(`agent SYSTEM.md load failed: ${String(error)} [${path}]`);
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  if (isUpgradedSystemMd(text, path, warn)) {
    try {
      return loadUpgradedSystemMd(text, path, builtinDefault, warn);
    } catch (error) {
      warn(`agent SYSTEM.md parse failed: ${String(error)} [${path}]`);
      return undefined;
    }
  }
  return loadLegacySystemMd(text, builtinDefault);
}

function isUpgradedSystemMd(text: string, path: string, warn: (message: string) => void): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine !== '---') return false;
  try {
    const parsed = parseFrontmatter(text);
    if (isRecord(parsed.data)) return true;
    warn(
      `agent SYSTEM.md frontmatter is not a mapping; treating the file as a legacy prompt [${path}]`,
    );
    return false;
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    warn(
      `agent SYSTEM.md frontmatter parse failed (${detail}); treating the file as a legacy prompt [${path}]`,
    );
    return false;
  }
}

function loadUpgradedSystemMd(
  text: string,
  path: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): AgentProfile {
  const parsed = parseFrontmatter(text);
  if (!isRecord(parsed.data)) {
    throw new Error('SYSTEM.md upgraded sniff produced a non-mapping');
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
  return agentProfileFromFile(
    {
      ...definition,
      tools: Object.hasOwn(parsed.data, 'tools') ? definition.tools : builtinDefault.tools,
      disallowedTools: Object.hasOwn(parsed.data, 'disallowedTools')
        ? definition.disallowedTools
        : builtinDefault.disallowedTools,
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

function loadLegacySystemMd(text: string, builtinDefault: AgentProfile): AgentProfile {
  const skillActive =
    (builtinDefault.tools === undefined || skillActiveFor(builtinDefault.tools)) &&
    !(builtinDefault.disallowedTools ?? []).includes('Skill');
  return normalizeAgentProfile({
    name: DEFAULT_AGENT_PROFILE_NAME,
    description: builtinDefault.description,
    override: true,
    tools: builtinDefault.tools,
    disallowedTools: builtinDefault.disallowedTools,
    subagents: builtinDefault.subagents,
    subagentLeases: builtinDefault.subagentLeases,
    spawnConstraints: builtinDefault.spawnConstraints,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(
        text,
        context,
        { skillActive },
        (ctx) => builtinDefault.renderSystemPrompt(ctx),
        (ctx) => builtinDefault.renderSystemPrompt(ctx),
      ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import type { IPluginService } from '#/app/plugin/plugin';
import type { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { Error2, ErrorCodes } from '#/errors';

export async function assertPluginSkillUsage(
  path: string,
  workspaceId: string,
  plugins: IPluginService | undefined,
  usage: IPluginUsageService | undefined,
  sessionId?: string,
): Promise<void> {
  if (plugins === undefined || usage?.enabled() !== true) return;
  const pluginId = await plugins.pluginSkillOwner(path);
  if (pluginId === undefined) return;
  const info = await plugins.getPluginInfo({ id: pluginId });
  if (!info.enabled || info.state !== 'ok' || !await usage.allows(workspaceId, pluginId, sessionId)) {
    throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Plugin ${pluginId} skills are disabled in this workspace or session.`);
  }
}

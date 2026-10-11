import { afterEach, describe, expect, it } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginCommandDef } from '#/app/plugin/types';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';

import {
  IAgentPluginCommandService,
  PluginCommandActivated,
} from '#/agent/pluginCommand/pluginCommand';

import { appService, createTestAgent, sessionService, type TestAgentContext } from '../../harness';

const DEPLOY_COMMAND: PluginCommandDef = {
  pluginId: 'demo',
  name: 'deploy',
  description: 'Deploy',
  body: 'Deploy body',
  path: '/plugins/demo/deploy.md',
};

function pluginServiceStub(commands: readonly PluginCommandDef[]): IPluginService {
  return {
    _serviceBrand: undefined,
    onWillChange: () => ({ dispose: () => {} }),
    onDidReload: () => ({ dispose: () => {} }),
    onDidMutate: () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    previewPlugin: async () => { throw new Error('unused'); },
    installPlugin: async () => ({ id: '' }) as never,
    rollbackPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async ({ id }) => ({ id, enabled: true, globalEnabled: true, state: 'ok' as const, manifest: undefined }) as never,
    listPluginCommands: async () => commands,
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginSkillOwner: async () => undefined,
    pluginAgentRoots: async () => [],
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    mcpServerEntries: async () => [],
    enabledHooks: async () => [],
    enabledHookRules: async () => [],
    hasLoadedSnapshot: () => true,
  };
}

describe('AgentPluginCommandService', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function agentWithDeployCommand(sessionUsage?: ISessionPluginUsageService): TestAgentContext {
    return createTestAgent(
      appService(IPluginService, pluginServiceStub([DEPLOY_COMMAND])),
      ...(sessionUsage === undefined ? [] : [sessionService(ISessionPluginUsageService, sessionUsage)]),
    );
  }

  it('publishes the activation event, enqueues the expanded body, and updates metadata', async () => {
    ctx = agentWithDeployCommand();
    ctx.mockNextResponse({ type: 'text', text: 'deployed' });

    const events: PluginCommandActivated[] = [];
    const sub = ctx
      .get(IEventBus)
      .subscribe(PluginCommandActivated, (event) => events.push(event));

    await ctx
      .get(IAgentPluginCommandService)
      .activate({ pluginId: 'demo', commandName: 'deploy', args: 'prod' });
    await sub.dispose();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'plugin_command.activated',
      pluginId: 'demo',
      commandName: 'deploy',
      commandArgs: 'prod',
      trigger: 'user-slash',
    });

    await ctx.untilTurnEnd();
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('Deploy body');
    expect(llmInput).toContain('ARGUMENTS: prod');

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('/demo:deploy prod');
    expect(metadata.lastPrompt).toBe('/demo:deploy prod');
  });

  it('enables only the current session before applying an explicit command', async () => {
    const enabled: string[] = [];
    const sessionUsage: ISessionPluginUsageService = {
      _serviceBrand: undefined,
      read: async () => ({ workspaceId: 'workspace-a', sessionId: 'session-a', revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      set: async (pluginId, override) => {
        expect(override).toBe('on');
        enabled.push(pluginId);
        return { workspaceId: 'workspace-a', sessionId: 'session-a', revision: 1, overrides: { [pluginId]: true }, applyState: 'applied' as const, errors: [] };
      },
    };
    ctx = agentWithDeployCommand(sessionUsage);
    ctx.mockNextResponse({ type: 'text', text: 'deployed' });
    await ctx.get(IAgentPluginCommandService).activate({ pluginId: 'demo', commandName: 'deploy' });
    expect(enabled).toEqual(['demo']);
  });

  it('rejects an unknown command with request.invalid', async () => {
    ctx = agentWithDeployCommand();

    await expect(
      ctx
        .get(IAgentPluginCommandService)
        .activate({ pluginId: 'demo', commandName: 'missing' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
  });
});

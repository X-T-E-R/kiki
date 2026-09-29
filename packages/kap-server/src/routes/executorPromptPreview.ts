import type { AgentProfile, Scope } from '@kiki/agent-core-v2';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { IAgentIdentity } from '@kiki/agent-core-v2/app/agentIdentity/agentIdentity';
import { IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { IAgentExecutorRegistry } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import { resolvePromptDelivery } from '@kiki/agent-core-v2/app/agentExecutor/capabilities';
import { MEMORY_SECTION, type MemoryConfig } from '@kiki/agent-core-v2/app/memory/configSection';
import { renderMemorySnapshot } from '@kiki/agent-core-v2/app/memory/memorySnapshot';
import { IMemoryStore } from '@kiki/agent-core-v2/app/memory/memoryStore';
import { PROMPT_SECTION, type PromptConfig } from '@kiki/agent-core-v2/app/prompt/configSection';
import { IPromptFieldRegistry } from '@kiki/agent-core-v2/app/promptField/promptFieldRegistry';
import { applyMatchedModelProfilePrompt } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import { IModelService } from '@kiki/agent-core-v2/kosong/model/model';
import { renderExternalPromptBlocks } from '@kiki/agent-core-v2/agent/profile/externalPrompt';
import { resolveProfilePromptFields } from '@kiki/agent-core-v2/agent/profile/promptFieldSnapshot';
import { prepareSystemPromptContext } from '@kiki/agent-core-v2/agent/profile/context';
import { isToolActiveComposed } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { IHostClock } from '@kiki/agent-core-v2/os/interface/hostClock';
import type { ExecutorPromptPreviewResponse } from '@kiki/protocol';
import type { WorkspaceInstance } from '@kiki/agent-core-v2/workspace/workspaceInstance/workspaceInstance';

export async function previewExecutorPrompt(
  core: Scope,
  instance: WorkspaceInstance,
  profile: AgentProfile,
  executorId: string,
): Promise<ExecutorPromptPreviewResponse> {
  const registry = core.accessor.get(IAgentExecutorRegistry);
  const descriptor = registry.get(executorId);
  if (descriptor === undefined || descriptor.protocol === 'native') throw new Error(`Unknown external executor: ${executorId}`);
  const selectedProfile = { ...profile, executor: executorId };
  const config = core.accessor.get(IConfigService);
  const promptConfig = config.get<PromptConfig>(PROMPT_SECTION);
  const alias = profile.modelAlias ?? '';
  const fields = await resolveProfilePromptFields(selectedProfile, alias,
    profile.main === true ? 'main' : 'sub', config, core.accessor.get(IModelService),
    core.accessor.get(IPromptFieldRegistry));
  const bootstrap = core.accessor.get(IBootstrapService);
  const clock = core.accessor.get(IHostClock);
  const program = instance.program;
  await program.instructions.ready;
  const lease = instance.runtimes.acquire(program.binding, ['fs']);
  let context;
  try {
    const runtime = lease.runtime;
    const workDir = runtime.workspace.mapRoots({ workDir: instance.root }).workDir;
    context = {
      ...await prepareSystemPromptContext({ fs: runtime.fs!, homeDir: runtime.environment.homeDir },
        workDir, bootstrap.homeDir, { preloadedAgentsMd: {
          content: program.instructions.snapshot.agentsMd ?? '',
          warning: program.instructions.snapshot.agentsMdWarning,
          paths: program.instructions.snapshot.agentsMdPaths ?? [],
        } }),
      cwd: workDir,
      osKind: runtime.environment.osKind,
      shellName: runtime.environment.shellName,
      shellPath: runtime.environment.shellPath,
      now: clock.now().toISOString(),
      timeZone: clock.timeZone(),
      skills: program.skills.catalog.getModelSkillListing(),
      memory: (await renderMemorySnapshot(config.get<MemoryConfig>(MEMORY_SECTION), instance.id,
        core.accessor.get(IMemoryStore))).text,
      skillActive: isToolActiveComposed({ profile: selectedProfile, global: config.get('tools') }, 'Skill'),
      productName: (await core.accessor.get(IAgentIdentity).resolved()).displayName,
      replyStyleGuide: bootstrap.args.replyStyleGuide,
      promptVariables: promptConfig?.variables,
      promptFields: fields.values,
    };
  } finally {
    lease.dispose();
  }
  const rendered = profile.renderSystemPrompt(context);
  const fallback = applyMatchedModelProfilePrompt(rendered.text, profile.modelProfiles, alias, (id) => id);
  const blocks = renderExternalPromptBlocks(selectedProfile, context, fields, fallback);
  return {
    executor: executorId,
    delivery: resolvePromptDelivery(descriptor, { executorPrompt: profile.executorPrompt }),
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
  };
}

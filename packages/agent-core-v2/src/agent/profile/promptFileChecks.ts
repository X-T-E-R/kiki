import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { modelPromptLayers } from '@kiki/agent-profiles/modelProfileOverlay';
import type { PromptOverrides } from '@kiki/agent-profiles/promptOverrides';
import type { AgentPromptDiagnostics } from '@kiki/protocol';

import { cognitionPathRefs, readCognitionSlot } from '#/agent/cognition/cognitionFiles';
import { readPromptOverrideFile } from '#/app/promptField/promptOverrideFile';
import type { ModelRecord } from '#/kosong/model/model';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

type FileCheck = NonNullable<AgentPromptDiagnostics['file_checks']>[number];

export async function checkPromptFiles(input: {
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
  readonly pathClass: PathClass;
  readonly profile: Pick<AgentProfile, 'promptOverrideLayers' | 'promptOverrides' | 'modelPromptLayers' | 'modelProfiles' | 'modelPromptBase' | 'sourcePath'>;
  readonly model?: ModelRecord;
  readonly modelAlias: string;
  readonly global?: PromptOverrides;
}): Promise<readonly FileCheck[]> {
  const checks: FileCheck[] = [];
  async function check(declaration: Omit<FileCheck, 'status' | 'reason'>, read: () => Promise<unknown>): Promise<void> {
    if (input.model?.recipe !== undefined && ['model', 'profile-model', 'caller-lease-model', 'model-cognition'].includes(declaration.surface)) return;
    try {
      await read();
      checks.push({ ...declaration, status: 'ok' });
    } catch (error) {
      checks.push({ ...declaration, status: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  async function overrides(surface: string, value: PromptOverrides | readonly PromptOverrides[] | undefined, modelAlias?: string): Promise<void> {
    const declarations = value === undefined ? [] : Array.isArray(value) ? value : [value as PromptOverrides];
    for (const declaration of declarations) {
      for (const branch of ['common', 'main', 'independent'] as const) {
        const content = branch === 'common' ? declaration : declaration[branch];
        if (typeof content !== 'object') continue;
        for (const path of content.files ?? []) await check({ surface, branch, channel: 'prompt_overrides', path, model_alias: modelAlias },
          () => readPromptOverrideFile(input.fs, input.homeDir, path, input.pathClass));
      }
    }
  }
  await overrides('global', input.global);
  await overrides('model', input.model?.promptOverrides, input.modelAlias);
  await overrides('profile', input.profile.promptOverrideLayers ?? input.profile.promptOverrides);
  const layers = modelPromptLayers(input.profile);
  const omitted = (input.profile.modelPromptBase ?? []).filter((base) => !layers.includes(base) && !layers.some((layer) => layer.source === base.source && layer.entries === base.entries));
  for (const layer of [...omitted, ...layers]) for (const entry of layer.entries) {
    await overrides(layer.source === 'lease' ? 'caller-lease-model' : 'profile-model', entry.promptOverrides, entry.alias);
  }
  const cognition = input.model?.cognition;
  for (const branch of ['common', 'main', 'independent'] as const) {
    const content = branch === 'common' ? cognition : cognition?.[branch];
    if (typeof content !== 'object') continue;
    for (const slot of ['overlay', 'steering', 'anchor'] as const) for (const path of cognitionPathRefs(content[slot])) {
      await check({ surface: 'model-cognition', branch, channel: `cognition_${slot}`, path, model_alias: input.modelAlias },
        () => readCognitionSlot(input.fs, input.homeDir, slot, [path], input.pathClass));
    }
  }
  return checks;
}

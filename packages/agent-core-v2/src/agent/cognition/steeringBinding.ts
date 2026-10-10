import { mergeModelSteeringSources, modelSteeringSourceIds, type ModelSteeringSources, type ResolvedRecipeBranch } from '@kiki/protocol';
import type { CognitionContent } from '#/kosong/model/model';
import { readCognitionContent } from './cognitionFiles';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { PathClass } from '#/os/interface/hostEnvironment';

export async function loadSteeringSources(fs: IHostFileSystem, homeDir: string, config: CognitionContent | undefined, recipe: ResolvedRecipeBranch | undefined, pathClass: PathClass): Promise<ModelSteeringSources<string> | undefined> {
  const native: ModelSteeringSources<string> | undefined = config?.steeringSources === undefined ? undefined : {};
  for (const source of modelSteeringSourceIds) {
    const setting = config?.steeringSources?.[source];
    if (setting === undefined) continue;
    const overridden = recipe?.steering_sources?.[source]?.custom?.steering !== undefined;
    const steering = (recipe?.steering_sources?.[source]?.mode ?? setting.mode) === 'custom' && !overridden ? await readCognitionContent(fs, homeDir, 'steering', setting.custom?.steering, pathClass) : undefined;
    native![source] = { mode: setting.mode, custom: setting.custom === undefined ? undefined : { ...setting.custom, steering } };
  }
  return mergeModelSteeringSources(native, recipe?.steering_sources);
}

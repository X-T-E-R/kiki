import type { IModelService } from '#/kosong/model/model';

export function resolveEffectiveSessionModel(
  models: IModelService,
  binding: { readonly modelAlias?: string; readonly executorId?: string },
  selected?: { readonly modelAlias?: string; readonly executor?: string },
): { model: string | undefined; executorId: string } {
  const executorId = binding.executorId ?? selected?.executor ?? 'native';
  const alias = binding.modelAlias || ((selected?.executor ?? 'native') === executorId ? selected?.modelAlias : undefined);
  if (executorId !== 'native') return { model: alias || undefined, executorId };
  return { model: alias ? models.resolveId(alias) ?? alias : models.getDefaultModel(), executorId };
}

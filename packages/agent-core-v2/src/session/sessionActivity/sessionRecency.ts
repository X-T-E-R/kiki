import { createDecorator } from '#/_base/di/instantiation';

export interface ISessionRecencyStore {
  readonly _serviceBrand: undefined;
  propagate(parentId: string, at: number, visited: ReadonlySet<string>): Promise<void>;
}

export const ISessionRecencyStore = createDecorator<ISessionRecencyStore>('sessionRecencyStore');

export function activityParentId(id: string, custom: Record<string, unknown> | undefined): string | undefined {
  const creator = custom?.['created_by_session_id'];
  const parent = typeof creator === 'string' && creator !== '' ? creator
    : custom?.['child_session_kind'] === 'child' ? custom['parent_session_id'] : undefined;
  return typeof parent === 'string' && parent !== '' && parent !== id && parent !== '.' && parent !== '..' && !/[\\/]/.test(parent)
    ? parent : undefined;
}

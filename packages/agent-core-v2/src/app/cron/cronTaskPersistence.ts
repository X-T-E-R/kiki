import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { CronTask } from './cronTask';

export interface CronTaskQuery {
  readonly workspaceId: string;
}

export interface ICronTaskPersistence {
  readonly _serviceBrand: undefined;
  readonly onDidChange?: Event<void>;

  get(workspaceId: string, taskId: string): Promise<CronTask | undefined>;
  list(query: CronTaskQuery): Promise<readonly CronTask[]>;
  listWorkspaceIds(): Promise<readonly string[]>;
  save(workspaceId: string, task: CronTask): Promise<void>;
  delete(workspaceId: string, taskId: string): Promise<void>;
}

export const ICronTaskPersistence = createDecorator<ICronTaskPersistence>('cronTaskPersistence');

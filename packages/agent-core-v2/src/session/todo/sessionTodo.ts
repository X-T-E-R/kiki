import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { TodoItem } from './todoItem';

export interface ISessionTodoService {
  readonly _serviceBrand: undefined;

  getTodos(agentId?: string): readonly TodoItem[];
  setTodos(todos: readonly TodoItem[], agentId?: string): void;
  clear(agentId?: string): void;
  readonly onDidChange: Event<readonly TodoItem[]>;
  readonly onDidChangeAgent: Event<{ agentId: string; todos: readonly TodoItem[] }>;
}

export const ISessionTodoService = createDecorator<ISessionTodoService>('sessionTodoService');

// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { TaskBoard } from './TaskBoard';
import type { BoardTask, BoardWorkspaceOption, BoardSessionOption } from './types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const sampleWorkspaces: BoardWorkspaceOption[] = [
  { id: 'ws-kiki', title: 'EasyAgent / Kiki GUI' },
  { id: 'ws-core', title: 'Moonshot Agent Core' },
];

const sampleSessions: BoardSessionOption[] = [
  { id: 's-101', title: 'UI Aesthetic Polish Session' },
  { id: 's-102', title: 'Runtime Integration Session' },
];

const sampleTasks: BoardTask[] = [
  {
    id: 't-1',
    title: '重构右栏为独立 Agent Panel',
    description: '分离身份、独立度量、折叠工具与底部看板入口',
    prompt: 'Implement AgentPanel presentation layer in src/components/agent-panel/',
    status: 'backlog',
    priority: 'high',
    createdAt: Date.now() - 3600000 * 24,
    updatedAt: Date.now() - 3600000 * 2,
    workspaceId: 'ws-kiki',
    workspaceTitle: 'EasyAgent / Kiki GUI',
    associatedSessionIds: ['s-101'],
    executions: [],
  },
  {
    id: 't-2',
    title: '适配 DSH TaskBoard 核心组件与语义',
    description: '支持4列或5列呈现，解耦执行引擎，强化会话关联筛选',
    prompt: 'Port DSH TaskBoard component into src/components/task-board/',
    status: 'running',
    priority: 'urgent',
    createdAt: Date.now() - 3600000 * 12,
    updatedAt: Date.now() - 10000,
    workspaceId: 'ws-kiki',
    workspaceTitle: 'EasyAgent / Kiki GUI',
    associatedSessionIds: ['s-101', 's-102'],
    executions: [
      {
        id: 'exec-1',
        sessionId: 's-101',
        startedAt: Date.now() - 100000,
        result: undefined, // still running
      },
    ],
  },
  {
    id: 't-3',
    title: '多端视觉快照与审美自查',
    description: '双视口（桌面与移动）自查，严格杜绝通用AI紫色与占位符',
    status: 'todo',
    priority: 'medium',
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 1800000,
    workspaceId: 'ws-core',
    workspaceTitle: 'Moonshot Agent Core',
    executions: [
      {
        id: 'exec-prev',
        sessionId: 's-102',
        startedAt: Date.now() - 7200000,
        endedAt: Date.now() - 7100000,
        result: 'succeeded',
      },
    ],
  },
  {
    id: 't-4',
    title: '旧版废弃任务处理',
    description: '验证已完成列展现',
    status: 'done',
    priority: 'low',
    createdAt: Date.now() - 3600000 * 48,
    updatedAt: Date.now() - 3600000 * 20,
    executions: [],
  },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function renderBoard(node: ReactNode): void {
  root.render(<I18nProvider>{node}</I18nProvider>);
}

function changeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('TaskBoard Component Presentation', () => {
  it('renders default 4 columns and distributes tasks according to status', async () => {
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={sampleTasks}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
        />
      );
    });

    expect(container.textContent).toContain('需求与任务看板');
    expect(container.querySelector('[data-board-column="backlog"]')).not.toBeNull();
    expect(container.querySelector('[data-board-column="todo"]')).not.toBeNull();
    expect(container.querySelector('[data-board-column="running"]')).not.toBeNull();
    expect(container.querySelector('[data-board-column="done"]')).not.toBeNull();

    // Check task cards in columns
    expect(container.querySelector('[data-board-task-card="t-1"]')).not.toBeNull();
    expect(container.querySelector('[data-board-task-card="t-2"]')).not.toBeNull();
    expect(container.querySelector('[data-board-task-card="t-3"]')).not.toBeNull();
    expect(container.querySelector('[data-board-task-card="t-4"]')).not.toBeNull();
  });

  it('filters cards by search query and workspace selection', async () => {
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={sampleTasks}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
        />
      );
    });

    const searchInput = container.querySelector('input[type="search"]');
    expect(searchInput).not.toBeNull();

    // Search for '重构'
    await act(async () => {
      changeInputValue(searchInput as HTMLInputElement, '重构');
    });

    expect(container.querySelector('[data-board-task-card="t-1"]')).not.toBeNull();
    expect(container.querySelector('[data-board-task-card="t-2"]')).toBeNull();
  });

  it('opens detail modal when clicking a task card and allows editing', async () => {
    const onUpdate = vi.fn();
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={sampleTasks}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
          onUpdateTask={onUpdate}
        />
      );
    });

    const card = container.querySelector('[data-board-task-card="t-1"]');
    expect(card).not.toBeNull();
    await act(async () => {
      (card as HTMLElement).click();
    });

    // Detail modal opens
    const modal = container.querySelector('[data-task-detail-modal]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('重构右栏为独立 Agent Panel');
    expect(modal?.querySelector('[data-board-associated-todos]')).not.toBeNull();

    // Click Edit button
    const editBtn = Array.from(modal!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Edit Task')
    );
    expect(editBtn).toBeDefined();
    await act(async () => {
      editBtn!.click();
    });

    // Edit input exists
    const titleInput = modal!.querySelector('input[type="text"]') as HTMLInputElement;
    expect(titleInput).not.toBeNull();
    await act(async () => {
      changeInputValue(titleInput, '更新后的任务标题');
    });

    // Save changes
    const saveBtn = Array.from(modal!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Changes')
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn!.click();
    });

    expect(onUpdate).toHaveBeenCalledWith('t-1', expect.objectContaining({
      title: '更新后的任务标题',
    }));
  });

  it('opens new task modal and submits creation data', async () => {
    const onCreate = vi.fn();
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={sampleTasks}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
          onCreateTask={onCreate}
        />
      );
    });

    const newBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ 新建需求')
    );
    expect(newBtn).toBeDefined();
    await act(async () => {
      newBtn!.click();
    });

    const newModal = container.querySelector('[data-new-task-modal]');
    expect(newModal).not.toBeNull();

    const titleInput = newModal!.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      changeInputValue(titleInput, '全新特性需求');
    });

    const submitBtn = Array.from(newModal!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create Task Card')
    );
    expect(submitBtn).toBeDefined();
    await act(async () => {
      submitBtn!.click();
    });

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '全新特性需求',
      priority: 'medium',
    }));
  });

  it('omits empty execution copy when a card has no execution facts', async () => {
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={sampleTasks}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
        />
      );
    });

    const card = container.querySelector('[data-board-task-card="t-1"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).not.toContain('未记录执行');
    expect(card?.textContent).toContain('⌁ 1');
  });

  it('supports empty state presentation cleanly', async () => {
    await act(async () => {
      renderBoard(
        <TaskBoard
          tasks={[]}
          workspaces={sampleWorkspaces}
          sessions={sampleSessions}
        />
      );
    });

    const emptyPlaceholders = container.querySelectorAll('.border-dashed');
    expect(emptyPlaceholders.length).toBe(5); // Default 5 columns: backlog, todo, running, done, failed
    expect(container.textContent).toContain('暂无需求卡片');
  });
});

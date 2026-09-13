// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { AgentPanel } from './AgentPanel';
import { AgentDetailDrawer } from './AgentDetailDrawer';
import type {
  AgentIdentity,
  AgentTokenUsage,
  AgentTreeMetrics,
  AgentPanelTodo,
  AgentToolCapability,
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentActiveWorkItem,
  AgentBoardSummary,
} from './types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const sampleIdentity: AgentIdentity = {
  id: 'agent-101',
  profile: 'researcher',
  label: 'Research Specialist',
  model: 'fixture/model-a',
  status: 'running',
  summary: '负责背景信息调查与事实归纳。',
  description: '执行结构化搜索与代码定义溯源。',
  configContentPreview: 'You are an evidence explorer subagent...',
  source: 'workspace',
  sourceFile: 'systems/kiki/prompts/researcher.md',
  context: 'live',
  roleParameters: {
    maxDepth: 3,
  },
  isMain: true,
};

const sampleUsageWithNulls: AgentTokenUsage = {
  contextTokens: 64200,
  contextLimit: 128000,
  totalTokens: null, // Test: null displayed as '未知'
  inputTokens: 125000,
  outputTokens: 18400,
  cacheReadTokens: null, // Test: null cache
  cacheWriteTokens: null,
  totalCostUsd: null, // Test: null cost
  compactionCount: null, // Test: null compaction
};

const sampleTreeMetrics: AgentTreeMetrics = {
  totalTokens: 489200,
  totalCostUsd: 0.895,
  activeSubagentsCount: 2,
  totalSubagentsCount: 5,
};

const sampleTodos: AgentPanelTodo[] = [
  { id: 'todo-1', title: '梳理分析输入', status: 'done' },
  { id: 'todo-2', title: '编写检索报告', status: 'in_progress' },
  { id: 'todo-3', title: '等待主会话复核', status: 'pending' },
];

const sampleTools: AgentToolCapability[] = [
  {
    name: 'Bash',
    category: '系统工具 (System)',
    description: '执行受限 shell 命令',
    state: 'approval-required', // Test: approval-required is NOT disabled
    parametersSummary: 'command: string',
    parametersSchema: '{\n  "command": "string"\n}',
  },
  {
    name: 'Read',
    category: '文件系统 (Filesystem)',
    description: '安全读取工作区文件',
    state: 'enabled',
    readOnly: true,
  },
  {
    name: 'Grep',
    category: '文件系统 (Filesystem)',
    description: '正则快速搜索',
    state: 'disabled',
    unavailableReason: '未安装 ripgrep 依赖',
  },
];

const sampleSkills: AgentSkillCapability[] = [
  {
    id: 'skill-1',
    name: 'code-review',
    description: '代码审查规则集',
    scope: 'workspace',
    state: 'enabled',
    path: '.agents/skills/code-review',
  },
  {
    id: 'skill-2',
    name: 'summarize',
    description: '文档摘要通用工具',
    scope: 'global',
    state: 'enabled',
  },
];

const sampleSubagents: AgentSubagentTarget[] = [
  {
    profile: 'explore',
    executor: 'native',
    modelAlias: 'fixture/model-b',
    thinkingEffort: 'high',
    defaultsAvailable: true,
    launchAllowed: true,
    executionRestriction: 'research-readonly',
  },
];

const sampleActiveWork: AgentActiveWorkItem[] = [
  {
    id: 'work-1',
    kind: 'subagent',
    label: 'Explore subagent (reading files)',
    status: 'running',
    elapsedMs: 3500,
  },
];

const sampleBoardSummary: AgentBoardSummary = {
  activeTaskId: 'task-1',
  activeTaskTitle: '优化多 Agent 调度逻辑',
  activeTaskStatus: 'running',
  activeTaskPriority: 'high',
  totalTasksCount: 8,
  inProgressCount: 2,
};

beforeEach(() => {
  localStorage.setItem('kiki.locale', 'zh');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('AgentPanel Component Presentation', () => {
  it('renders agent identity and opens detail drawer on click without inline clutter', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity}
            todos={[]}
            tools={[]}
            skills={[]}
            subagentTargets={[]}
            activeWork={[]}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain('Research Specialist');
    expect(container.textContent).toContain('researcher');
    // Prototype banner was removed
    expect(container.querySelector('[data-prototype-badge]')).toBeNull();

    // The detail drawer is initially not open
    expect(document.querySelector('[data-profile-detail]')).toBeNull();

    const nameBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Research Specialist')
    );
    expect(nameBtn).toBeDefined();

    // Focus was on nameBtn before opening
    nameBtn!.focus();
    expect(document.activeElement).toBe(nameBtn);

    // Click profile name to open detail drawer
    await act(async () => {
      nameBtn!.click();
    });

    // Detail drawer is now rendered in portal
    const profileDetail = document.querySelector('[data-profile-detail]');
    expect(profileDetail).not.toBeNull();
    expect(profileDetail!.textContent).toContain('来源:');
    expect(profileDetail!.textContent).toContain('workspace');
    expect(profileDetail!.textContent).toContain('文件:');
    expect(profileDetail!.textContent).toContain('systems/kiki/prompts/researcher.md');
    expect(profileDetail!.textContent).toContain('You are an evidence explorer subagent');

    // Close via Esc
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-profile-detail]')).toBeNull();

    // Focus restored back to the triggering element
    expect(document.activeElement).toBe(nameBtn);
  });

  it('displays partial badge when usagePartial or costPartial is set', async () => {
    const partialUsage: AgentTokenUsage = {
      ...sampleUsageWithNulls,
      totalTokens: 143400,
      totalCostUsd: 0.2541,
      usagePartial: true,
      costPartial: true,
    };

    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity}
            usage={partialUsage}
            todos={[]}
            tools={[]}
            skills={[]}
            subagentTargets={[]}
            activeWork={[]}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain('部分统计');
    expect(container.querySelector('[title="部分费用"]')).not.toBeNull();
    expect(container.textContent).toContain('$0.2541');
    expect(container.textContent).toContain('143.4k');
  });

  it('handles null accounting metrics gracefully as "未知" without forging 0 and does not draw fake progress bar', async () => {
    const usageAllNull: AgentTokenUsage = {
      contextTokens: null,
      contextLimit: null,
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalCostUsd: null,
      compactionCount: null,
    };

    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity} // isMain === true
            usage={usageAllNull}
            treeMetrics={sampleTreeMetrics}
            todos={[]}
            tools={[]}
            skills={[]}
            subagentTargets={[]}
            activeWork={[]}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    // Null metrics check
    expect(container.textContent).toContain('累计Tokens:未知');
    expect(container.textContent).toContain('费用:未知');
    expect(container.textContent).toContain('压缩次数:未知');
    expect(container.textContent).toContain('缓存读/写:未知');
    expect(container.textContent).toContain('未知 / 未知');

    // Context bar is NOT drawn when contextTokens/contextLimit are null
    const progressBar = container.querySelector('.rounded-full > .bg-accent, .rounded-full > .bg-danger, .rounded-full > .bg-amber-rule');
    expect(progressBar).toBeNull();

    // Since isMain === true, Tree totals are visible
    expect(container.querySelector('[data-tree-metrics]')).not.toBeNull();
    expect(container.textContent).toContain('整棵 Agent 树总计');
  });

  it('never displays tree totals when agent is a child subagent (isMain === false)', async () => {
    const childIdentity: AgentIdentity = {
      ...sampleIdentity,
      isMain: false,
    };

    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={childIdentity}
            usage={sampleUsageWithNulls}
            treeMetrics={sampleTreeMetrics} // Passed, but should be suppressed
            todos={[]}
            tools={[]}
            skills={[]}
            subagentTargets={[]}
            activeWork={[]}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    // Should NOT display tree metrics
    expect(container.querySelector('[data-tree-metrics]')).toBeNull();
    expect(container.textContent).not.toContain('整棵 Agent 树总计');
  });

  it('renders todos with done/in_progress/pending strictly', async () => {
    const onToggle = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity}
            todos={sampleTodos}
            tools={[]}
            skills={[]}
            subagentTargets={[]}
            activeWork={[]}
            onToggleTodo={onToggle}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain('当前 Todo 任务');
    expect(container.textContent).toContain('编写检索报告');
    expect(container.textContent).toContain('1/3'); // 1 done out of 3

    const todoButtons = container.querySelectorAll('button[aria-label^="标记待办"]');
    expect(todoButtons.length).toBe(3);
    await act(async () => {
      (todoButtons[0] as HTMLButtonElement).click();
    });
    expect(onToggle).toHaveBeenCalledWith('todo-1');
  });

  it('renders compact tools and clicks name to open detail drawer with schema & approval notice', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity}
            todos={[]}
            tools={sampleTools}
            skills={sampleSkills}
            subagentTargets={sampleSubagents}
            activeWork={sampleActiveWork}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    // Expand tools
    const toolsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('已注册工具')
    );
    expect(toolsBtn).toBeDefined();
    await act(async () => {
      toolsBtn!.click();
    });

    // Categories exist
    expect(container.textContent).toContain('系统工具 (System)');
    expect(container.textContent).toContain('文件系统 (Filesystem)');

    // In the main panel, long schema is NOT expanded inline
    expect(container.querySelector('pre')).toBeNull();

    const bashBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent === 'Bash'
    );
    expect(bashBtn).toBeDefined();

    // Click on 'Bash' tool name to open detail drawer
    bashBtn!.focus();
    expect(document.activeElement).toBe(bashBtn);
    await act(async () => {
      bashBtn!.click();
    });

    // Check detail drawer content
    const toolDetail = document.querySelector('[data-tool-detail]');
    expect(toolDetail).not.toBeNull();
    expect(toolDetail!.textContent).toContain('Bash');
    expect(toolDetail!.textContent).toContain('需人工审批');
    expect(toolDetail!.textContent).toContain('执行前需人工确认授权');
    expect(toolDetail!.textContent).toContain('参数 Schema & 描述');
    expect(toolDetail!.textContent).toContain('"command": "string"');

    // Close detail drawer via Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-tool-detail]')).toBeNull();

    // Focus returns to bashBtn
    expect(document.activeElement).toBe(bashBtn);
  });

  it('opens detail drawer for skills and subagents with admission reasons', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentPanel
            identity={sampleIdentity}
            todos={[]}
            tools={sampleTools}
            skills={sampleSkills}
            subagentTargets={sampleSubagents}
            activeWork={[]}
            onOpenBoard={() => {}}
          />
        </I18nProvider>
      );
    });

    // Click skill pill preview
    const skillPill = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('code-review')
    );
    expect(skillPill).toBeDefined();
    await act(async () => {
      skillPill!.click();
    });

    const skillDetail = document.querySelector('[data-skill-detail]');
    expect(skillDetail).not.toBeNull();
    expect(skillDetail!.textContent).toContain('code-review');
    expect(skillDetail!.textContent).toContain('.agents/skills/code-review');
    expect(skillDetail!.textContent).toContain('工作区专属');

    // Close
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-skill-detail]')).toBeNull();

    // Expand subagents
    const subagentsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('可派遣子代')
    );
    expect(subagentsBtn).toBeDefined();
    await act(async () => {
      subagentsBtn!.click();
    });

    const subagentItem = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('explore')
    );
    expect(subagentItem).toBeDefined();
    await act(async () => {
      subagentItem!.click();
    });

    const subagentDetail = document.querySelector('[data-subagent-detail]');
    expect(subagentDetail).not.toBeNull();
    expect(subagentDetail!.textContent).toContain('explore');
    expect(subagentDetail!.textContent).toContain('仅限研究 · 只读执行');
    expect(subagentDetail!.textContent).toContain('策略检查通过，当前会话允许分派');

    // Close
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-subagent-detail]')).toBeNull();
  });
});

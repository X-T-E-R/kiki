// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, type AgentCapabilitiesQuery, type AgentCapabilitiesResponse } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import { ApiError } from '../lib/client';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';

const { getAgentCapabilities } = vi.hoisted(() => ({ getAgentCapabilities: vi.fn() }));
vi.mock('../state/connection', () => ({ useConnection: () => ({ klient: { global: { agentPanel: { read: (query: unknown, options: { signal: AbortSignal }) => getAgentCapabilities(query, options.signal) } } } }) }));
let root: Root;
let container: HTMLDivElement;
const data = (context: 'live' | 'draft'): AgentCapabilitiesResponse => ({
  context, owner: { profile: 'agent', agent_id: context === 'live' ? 'child-2' : undefined }, available: true,
  targets: [
    { profile: 'research', route: 'bounded', executor: 'native', model_alias: 'fixture/model-b', model_source: 'caller-lease', thinking_effort: 'high', effort_source: 'model-profile', defaults_available: true,
      launch_allowed: context === 'live' ? true : undefined, execution_restriction: context === 'live' ? 'research-readonly' : undefined },
    { profile: 'worker', executor: 'external', defaults_available: false, unavailable_reason: 'missing model', unavailable_reason_code: 'model_not_configured',
      launch_allowed: context === 'live' ? false : undefined, launch_unavailable_reason: context === 'live' ? 'Plan blocks execution' : undefined, launch_unavailable_reason_code: context === 'live' ? 'plan_resume_forbidden' : undefined },
    { profile: 'unknown-admission', executor: 'native', defaults_available: true },
  ],
  tools: [{ name: 'Read', source: 'builtin', category: 'builtin', state: 'disabled', unavailable_reason: 'legacy tool reason', unavailable_reason_code: 'tool_policy_disabled' }],
  skills: [{ name: 'fixture-skill', description: 'Fixture skill', source: 'workspace', scope: 'workspace', path: 'C:/fixture/SKILL.md', state: 'disabled', unavailable_reason: 'legacy skill reason', unavailable_reason_code: 'skill_tool_inactive' }],
});
beforeEach(() => {
  getAgentCapabilities.mockReset();
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(query: AgentCapabilitiesQuery) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><AgentCapabilitiesPanel query={query} /></I18nProvider></QueryClientProvider>));
  await act(async () => container.querySelector('button')!.click());
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
describe('AgentCapabilitiesPanel', () => {
  it('uses the selected live session/agent and separates defaults from Plan admission without guessing missing fields', async () => {
    getAgentCapabilities.mockResolvedValue(data('live'));
    await render({ session_id: 'session-1', agent_id: 'child-2' });
    await settle();
    expect(getAgentCapabilities).toHaveBeenCalledWith({ session_id: 'session-1', agent_id: 'child-2' }, expect.any(AbortSignal));
    expect(container.textContent).toContain('调用方租约');
    expect(container.textContent).toContain('模型配置档');
    expect(container.textContent).toContain('仅限研究 · 只读执行');
    expect(container.textContent).toContain('计划模式下 AgentRun 不能恢复已有子 Agent；请先退出计划模式。');
    expect(container.textContent).not.toContain('Plan blocks execution');
    expect(container.textContent).toContain('已被生效的工具策略禁用。');
    expect(container.textContent).toContain('此 Agent 未启用技能工具。');
    expect(container.querySelector('[data-capability-target="unknown-admission"]')?.textContent).not.toContain('当前允许启动');
    expect(container.querySelector('[data-capability-target="unknown-admission"]')?.textContent).toContain('未报告');
  });
  it('labels draft planning and never displays live admission, even if a malformed draft response includes those fields', async () => {
    getAgentCapabilities.mockResolvedValue({ ...data('live'), context: 'draft' });
    await render({ cwd: 'C:/fixture/workspace', profile: 'workspace-main' });
    await settle();
    expect(getAgentCapabilities).toHaveBeenCalledWith({ cwd: 'C:/fixture/workspace', profile: 'workspace-main' }, expect.any(AbortSignal));
    expect(container.textContent).toContain('非实时准入');
    expect(container.textContent).not.toContain('当前允许启动');
    expect(container.textContent).not.toContain('Plan blocks execution');
  });
  it('renders loading, an explicit error and retry, then the top-level unavailable reason', async () => {
    let reject!: (error: Error) => void;
    getAgentCapabilities.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await render({ workspace_id: 'wd_fixture', profile: 'agent' });
    expect(container.textContent).toContain('正在读取派遣能力');
    await act(async () => reject(new Error('fixture offline')));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('fixture offline');
    getAgentCapabilities.mockResolvedValue({ context: 'draft', owner: {}, available: false, unavailable_reason: 'profile is disabled', targets: [] });
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await settle();
    expect(container.textContent).toContain('profile is disabled');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('localizes known capability-query API errors', async () => {
    getAgentCapabilities.mockRejectedValue(new ApiError({
      code: ErrorCode.WORKSPACE_NOT_FOUND,
      msg: 'workspace missing from server',
      data: null,
    }));
    await render({ workspace_id: 'wd_fixture', profile: 'agent' });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法加载 Agent 能力：找不到工作区。');
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('workspace missing from server');
  });
});

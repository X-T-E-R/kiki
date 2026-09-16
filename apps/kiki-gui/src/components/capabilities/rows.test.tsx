// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDescriptor } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { SkillCard } from './rows';

const readHostFileMock = vi.fn();
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: { readHostFile: (p: string) => readHostFileMock(p) },
  }),
  useOptionalConnection: () => ({
    client: { readHostFile: (p: string) => readHostFileMock(p) },
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const sampleSkill: SkillDescriptor = {
  name: 'code-review',
  description: '代码审查规则集，自动化排查静态隐患。',
  path: 'C:/project/.agents/skills/code-review/SKILL.md',
  source: 'project',
  type: 'workflow',
  disable_model_invocation: true,
  prompt_command: true,
  argument_hint: '--strict',
};

beforeEach(() => {
  readHostFileMock.mockReset();
  localStorage.setItem('kiki.locale', 'zh');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SkillCard presentation and content toggling', () => {
  it('renders metadata badges, argument hint, FilePathLink, and toggles SKILL.md content', async () => {
    readHostFileMock.mockResolvedValue('# Code Review Instructions\n\nRun review checks.');

    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter>
            <SkillCard skill={sampleSkill} sourceLabel="工作区" />
          </MemoryRouter>
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain('code-review');
    expect(container.textContent).toContain('工作区');
    expect(container.textContent).toContain('workflow');
    expect(container.textContent).toContain('仅手动执行');
    expect(container.textContent).toContain('斜杠命令');
    expect(container.textContent).toContain('--strict');
    expect(container.textContent).toContain('C:/project/.agents/skills/code-review/SKILL.md');

    // Click to view SKILL.md
    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查看 SKILL.md')
    );
    expect(toggleBtn).toBeDefined();

    await act(async () => {
      toggleBtn!.click();
    });

    expect(readHostFileMock).toHaveBeenCalledWith('C:/project/.agents/skills/code-review/SKILL.md');
    expect(container.textContent).toContain('Code Review Instructions');

    // Click again to hide
    await act(async () => {
      toggleBtn!.click();
    });
    expect(container.textContent).not.toContain('Code Review Instructions');
  });
});

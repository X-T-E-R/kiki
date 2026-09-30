// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { PermissionRulesSettings } from './PermissionRulesSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), patchConfig: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../dirtyGuard', () => ({ useDirtyReporter: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
let config: { permission: { rules: { pattern: string; scope: 'user'; decision: 'ask' | 'deny' | 'allow'; reason?: string }[]; dangerousBash?: 'on' } };

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function click(label: string) {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function typePattern(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('[data-permission-rule-editor] input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  config = { permission: { rules: [], dangerousBash: 'on' } };
  client.getConfig.mockImplementation(async () => config);
  client.patchConfig.mockImplementation(async (patch: { permission: { rules: typeof config.permission.rules } }) => {
    config = { ...config, permission: { ...config.permission, rules: patch.permission.rules } };
    return config;
  });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider>
    <PermissionRulesSettings />
  </I18nProvider></QueryClientProvider>));
  await settle();
}

describe('persistent permission rule editor', () => {
  it('validates the shared pattern schema before writing and preserves other permission fields', async () => {
    await render();
    await click('Add rule');
    expect(document.body.querySelector('#permission-rule-pattern-error')?.textContent ?? '').not.toContain('ToolName(argument-pattern)');
    await typePattern('Bash(unclosed');
    expect(document.body.textContent).toContain('ToolName(argument-pattern)');
    expect(document.body.querySelector<HTMLButtonElement>('[data-settings-draft="permission-rule"] button')?.disabled).toBe(true);
    expect(client.patchConfig).not.toHaveBeenCalled();
    await typePattern('Bash(rm -rf*)');
    // A new rule's commit button says what it does.
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-settings-draft="permission-rule"] button')!.click(); });
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { rules: [
      { decision: 'ask', pattern: 'Bash(rm -rf*)', scope: 'user', reason: undefined },
    ] } });
    expect(config.permission.dangerousBash).toBe('on');
    expect(document.body.textContent).toContain('Bash(rm -rf*)');
  });

  it('edits, reorders, and deletes the whole ordered rules array', async () => {
    config.permission.rules = [
      { decision: 'deny', pattern: 'Bash', scope: 'user' },
      { decision: 'ask', pattern: 'Read', scope: 'user' },
    ];
    await render();
    await click('Edit');
    await typePattern('Bash(rm *)');
    await click('Save');
    expect(config.permission.rules[0]?.pattern).toBe('Bash(rm *)');
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Move up"]:not([disabled])')!.click());
    await settle();
    expect(config.permission.rules.map((rule) => rule.pattern)).toEqual(['Read', 'Bash(rm *)']);
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Delete Read"]')!.click());
    await settle();
    expect(config.permission.rules.map((rule) => rule.pattern)).toEqual(['Bash(rm *)']);
  });
});

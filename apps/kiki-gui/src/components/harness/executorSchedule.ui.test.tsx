// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import type { ExecutionChoice } from '@kiki/session-core/composer';

import { I18nProvider } from '../../i18n';
import { HostProvider } from '../../host';
import type { HostAdapter } from '../../host';
import { ExecutorLabelProvider, TurnExecutionBadge } from '../timeline/ExecutorNotes';
import { EngineDefaults } from '../settings/EngineDefaults';
import { EngineInstanceForm } from '../settings/EngineInstanceForm';
import { ProfileSelect } from './ProfileSelect';

const patchConfig = vi.fn(async () => ({ agent_executor_instances: {} }));
const cached = vi.fn(async () => ({ sources: [
  { id: 'plugin:fixture-quota/example', label: 'Fixture quota', engineIds: ['agy-cli'], minRefreshIntervalMs: 300_000 },
] }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      getConfig: async () => ({ raw: { agent_executor_overrides: {
        'agy-cli': { show_in_profile_list: true },
        'fixture-acp': { show_in_profile_list: true },
      } } }),
      patchConfig,
      klient: { rest: { harnessQuota: { cached } } },
    },
    scopeId: 'local',
    meta: { server_id: 'fixture' },
    connectionSource: 'local',
  }),
}));

const family = {
  id: 'agy-cli', label: 'AGY', status: 'ready', protocol: 'acp-v1',
  connection: { login_status: 'logged_in' },
} as ExecutorCatalogItem;
const other = {
  id: 'fixture-acp', label: 'Fixture', status: 'ready', protocol: 'acp-v1',
  connection: { login_status: 'logged_in' },
} as ExecutorCatalogItem;
const work = {
  id: 'instance-work', label: 'Work', status: 'ready', protocol: 'acp-v1',
  instance: { source_executor: 'agy-cli', label: 'Work', configuration: { kind: 'inherit' }, proxy: { kind: 'inherit' }, quota_account_id: 'work' },
} as ExecutorCatalogItem;
const catalog = [family, other, work];

function setControl(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function mount(node: ReactNode): { root: Root; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <HostProvider host={{ pickFilePath: async () => null } as HostAdapter}>{node}</HostProvider>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { root, host };
}

afterEach(() => {
  document.body.innerHTML = '';
  patchConfig.mockClear();
  cached.mockClear();
});

describe('executor schedule controls', () => {
  it('keeps a matching instance, then sets auto and main from the open menu', async () => {
    const seen: ExecutionChoice[] = [];
    function Harness() {
      const [choice, setChoice] = useState<ExecutionChoice>({
        executor: 'agy-cli', profile: undefined, profile_file: undefined, overrides: { executor_instance: 'instance-work' },
      });
      return <ProfileSelect choice={choice} onChange={(next) => { seen.push(next); setChoice(next); }} catalog={catalog} profiles={[]} nativeLabel="Kiki" />;
    }
    const { root, host } = mount(<Harness />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-profile-trigger]')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-execution-passthrough="agy-cli"]')).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-execution-passthrough="agy-cli"]')!.click(); });
    expect(seen.at(-1)?.overrides).toEqual({ executor_instance: 'instance-work' });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-profile-trigger]')!.click(); });
    const schedule = host.querySelector<HTMLSelectElement>('[data-executor-schedule="agy-cli"]')!;
    expect(schedule.value).toBe('instance-work');
    await act(async () => { setControl(schedule, 'auto'); });
    expect(seen.at(-1)).toMatchObject({ executor: 'agy-cli', overrides: { executor_instance: 'auto' } });
    await act(async () => { setControl(host.querySelector<HTMLSelectElement>('[data-executor-schedule="agy-cli"]')!, 'main'); });
    expect(seen.at(-1)?.overrides).toEqual({ executor_instance: 'main' });
    await act(async () => { setControl(host.querySelector<HTMLSelectElement>('[data-executor-schedule="agy-cli"]')!, 'instance-work'); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-execution-passthrough="fixture-acp"]')!.click(); });
    expect(seen.at(-1)).toMatchObject({ executor: 'fixture-acp' });
    expect(seen.at(-1)?.overrides).toBeUndefined();
    act(() => { root.unmount(); });
  });

  it('saves a quota source and default instance, and edits an instance launch', async () => {
    const { root, host } = mount(
      <>
        <EngineDefaults item={family} saved={undefined} instances={[work]} onSaved={async () => undefined} />
        <EngineInstanceForm item={work} source={family} />
      </>,
    );
    await act(async () => { host.querySelector<HTMLElement>('[data-engine-defaults] summary')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-engine-quota-source] option[value="plugin:fixture-quota/example"]')).not.toBeNull());
    await act(async () => {
      setControl(host.querySelector<HTMLSelectElement>('#agy-cli-default-instance')!, 'auto');
      setControl(host.querySelector<HTMLSelectElement>('[data-engine-quota-source]')!, 'plugin:fixture-quota/example');
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-engine-defaults-save]')!.click(); });
    expect(patchConfig).toHaveBeenCalledWith({ agent_executor_overrides: { 'agy-cli': {
      defaults: expect.objectContaining({ executor_instance: 'auto' }),
      quota_source: 'plugin:fixture-quota/example',
    } } });
    await act(async () => {
      setControl(host.querySelector<HTMLInputElement>('[data-instance-quota-account]')!, 'work');
      setControl(host.querySelector<HTMLInputElement>('[data-instance-home]')!, '/data/work');
      setControl(host.querySelector<HTMLTextAreaElement>('[data-instance-args]')!, '--example');
      setControl(host.querySelector<HTMLTextAreaElement>('[data-instance-env]')!, 'EXAMPLE_FLAG=1');
    });
    await act(async () => { host.querySelector<HTMLFormElement>('[data-engine-instance-form]')!.requestSubmit(); });
    expect(patchConfig).toHaveBeenLastCalledWith({ agent_executor_instances: { 'instance-work': expect.objectContaining({
      quota_account_id: 'work',
      launch: { home_dir: '/data/work', args: ['--example'], env: { EXAMPLE_FLAG: '1' } },
    }) } });
    act(() => { root.unmount(); });
  });

  it('shows the saved instance label on a turn', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <I18nProvider>
          <ExecutorLabelProvider labels={{ 'instance-work': 'Work' }}>
            <TurnExecutionBadge execution={{ executorId: 'instance-work', protocol: 'acp-v1', resumeMode: undefined, fidelity: 'full', losses: [] }} />
          </ExecutorLabelProvider>
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain('Work');
    expect(host.textContent).not.toContain('Instance-work');
    act(() => { root.unmount(); });
  });
});

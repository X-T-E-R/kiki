// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SshProfilesPanel } from './SshProfilesPanel';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../host', () => {
  const host = { connection: {
    listSshProfiles: mocks.list,
    saveSshProfile: mocks.save,
    removeSshProfile: mocks.remove,
  } };
  return { useHost: () => host };
});
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.list.mockReset();
  mocks.save.mockReset();
  mocks.remove.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('SshProfilesPanel', () => {
  it('retries profile-list errors and connects only with an ephemeral bearer and saved expected identity', async () => {
    const profile = {
      id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' },
      releaseChannel: 'stable', remotePort: 58627,
      serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
    };
    mocks.list.mockRejectedValueOnce('Profile store unavailable').mockResolvedValueOnce([profile]);
    const connect = vi.fn().mockRejectedValue('Host key not trusted');
    await act(async () => { root.render(<SshProfilesPanel onConnect={connect} />); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Profile store unavailable');
    const button = (label: string) => Array.from(container.querySelectorAll('button'))
      .find((entry) => entry.textContent === label)!;
    await act(async () => { button('common.retry').click(); });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => { button('connect.sshConnect').click(); });
    expect(connect).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('connect.sshNeedSetup');
    const token = 'a'.repeat(43);
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, token);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('connect.sshConnect').click(); });
    expect(connect).toHaveBeenCalledWith(profile.id, token);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host key not trusted');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(localStorage.getItem('kiki.connection')).toBeNull();
    await act(async () => { button('connect.sshConnect').click(); });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('offers in-place upgrade of old profiles without attempting a connection', async () => {
    const old = { id: 'host-old', label: 'Old', target: { kind: 'alias', alias: 'old' },
      identityFile: null, releaseChannel: 'stable' } as const;
    mocks.list.mockResolvedValue([old]);
    mocks.save.mockImplementation(async (profile) => [profile]);
    const connect = vi.fn();
    await act(async () => { root.render(<SshProfilesPanel onConnect={connect} />); });
    const button = (label: string) => Array.from(container.querySelectorAll('button'))
      .find((entry) => entry.textContent === label)!;
    await act(async () => { button('goal.edit').click(); });
    expect(container.querySelector<HTMLInputElement>('input[placeholder="dev-linux"]')?.value).toBe('old');
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('58627');
    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('connect.sshNeedSetup');
    expect(connect).not.toHaveBeenCalled();

    const homeInput = container.querySelector<HTMLInputElement>('input[placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(homeInput, '46aca369-50e8-4fd3-9c45-606d084450ed');
      homeInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'host-old', remotePort: 58627, serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
    }));
    expect(JSON.stringify(mocks.save.mock.calls[0]?.[0])).not.toContain('token');

    await act(async () => { button('goal.edit').click(); });
    const channel = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { channel.value = 'beta'; channel.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'host-old', releaseChannel: 'beta', serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
    }));
    expect(container.textContent).toContain('st.about.beta');
  });
});

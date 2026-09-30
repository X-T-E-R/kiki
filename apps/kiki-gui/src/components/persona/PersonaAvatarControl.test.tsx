// @vitest-environment jsdom

/**
 * The editor's avatar control: an oversize or wrong-type pick is refused
 * before any dialog, a good pick opens the crop dialog and uploads its PNG
 * with the chosen shape, and remove confirms before going back to the initial.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AVATAR_SOURCE_MAX_BYTES, PersonaAvatarControl } from './PersonaAvatarControl';

const client = vi.hoisted(() => ({
  putPersonaAvatar: vi.fn(async () => ({ id: 'lin-lan', mimeType: 'image/png', size: 10 })),
  deletePersonaAvatar: vi.fn(async () => ({ id: 'lin-lan', deleted: true })),
  getPersonaAvatar: vi.fn(async () => null),
}));
const toasts = vi.hoisted(() => [] as { tone: string; text: string }[]);

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client }),
}));
vi.mock('../../lib/toasts', () => ({ pushToast: (toast: { tone: string; text: string }) => { toasts.push(toast); return toasts.length; } }));

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has neither object URLs nor a canvas; the crop reads the image
  // through both, so stand in with a loaded 400 × 200 picture.
  URL.createObjectURL = vi.fn(() => 'blob:fixture');
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { get: () => 400 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { get: () => 200 });
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    set(this: HTMLImageElement) { queueMicrotask(() => { this.onload?.(new Event('load')); }); },
    get: () => 'blob:fixture',
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn(), imageSmoothingQuality: 'high' })) as never;
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) { callback(new Blob(['png'], { type: 'image/png' })); };
});

beforeEach(() => {
  toasts.length = 0;
  client.putPersonaAvatar.mockClear();
  client.deletePersonaAvatar.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(avatarUrl?: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PersonaAvatarControl personaId="lin-lan" persona={{ id: 'lin-lan', name: 'Lin Lan', avatarUrl }} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function pick(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

const picture = (size: number, type = 'image/jpeg') => {
  const file = new File(['x'], 'photo.jpg', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('PersonaAvatarControl', () => {
  it('shows the initial and offers upload only, until there is a picture', async () => {
    const container = await mount();
    expect(container.querySelector('[data-persona-avatar-kind="initial"]')?.textContent).toBe('L');
    expect(container.querySelector('[data-persona-avatar-upload]')?.textContent).toBe('Upload avatar');
    expect(container.querySelector('[data-persona-avatar-remove]')).toBeNull();
  });

  it('refuses an oversize or non-image pick without opening the editor', async () => {
    const container = await mount();
    await pick(container, picture(AVATAR_SOURCE_MAX_BYTES + 1));
    await pick(container, picture(10, 'image/gif'));
    expect(document.querySelector('[data-persona-avatar-crop]')).toBeNull();
    expect(toasts.map((toast) => toast.text)).toEqual(['The picture is over 20 MB.', 'The avatar must be PNG, JPG or WebP.']);
    expect(client.putPersonaAvatar).not.toHaveBeenCalled();
  });

  it('frames the pick, then uploads a PNG with the chosen shape', async () => {
    const container = await mount();
    await pick(container, picture(3 * 1024 * 1024));
    expect(document.querySelector('[data-persona-avatar-crop="ready"]')).not.toBeNull();
    const frame = document.querySelector<HTMLElement>('[data-persona-avatar-frame]')!;
    expect(frame.dataset['personaAvatarFrame']).toBe('square');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-persona-avatar-shape="circle"]')!.click(); });
    expect(frame.dataset['personaAvatarFrame']).toBe('circle');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-persona-avatar-save]')!.click(); });
    await flush();
    expect(client.putPersonaAvatar).toHaveBeenCalledTimes(1);
    const [id, file, shape] = client.putPersonaAvatar.mock.calls[0] as unknown as [string, File, string];
    expect([id, file.type, file.name, shape]).toEqual(['lin-lan', 'image/png', 'avatar.png', 'circle']);
    expect(document.querySelector('[data-persona-avatar-crop]')).toBeNull();
    expect(toasts.at(-1)).toEqual({ tone: 'success', text: 'Avatar updated' });
  });

  it('removes the picture only after confirming', async () => {
    const container = await mount('data:image/png;base64,AAAA');
    expect(container.querySelector('[data-persona-avatar-upload]')?.textContent).toBe('Change avatar');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-persona-avatar-remove]')!.click(); });
    expect(client.deletePersonaAvatar).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Remove avatar').at(-1)!;
    await act(async () => { confirm.click(); });
    await flush();
    expect(client.deletePersonaAvatar).toHaveBeenCalledWith('lin-lan');
    expect(toasts.at(-1)).toEqual({ tone: 'success', text: 'Avatar removed' });
  });
});

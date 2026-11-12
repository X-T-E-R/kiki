// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PersonaAvatar, personaAvatarOf, personaInitial, personaTintIndex } from './PersonaAvatar';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { for (const container of containers.splice(0)) container.remove(); });
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

function renderAvatar(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => { createRoot(container).render(<QueryClientProvider client={client}>{node}</QueryClientProvider>); });
  return container;
}

describe('PersonaAvatar', () => {
  it('falls back to the first character of the name', () => {
    const container = renderAvatar(<PersonaAvatar persona={{ id: 'xiao-you', name: '小柚' }} />);
    const avatar = container.querySelector<HTMLElement>('[data-persona-avatar="xiao-you"]')!;
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('小柚');
    expect(avatar.textContent).toBe('小');
    expect(avatar.dataset['personaAvatarKind']).toBe('initial');
  });

  it('renders a data URL directly and hides itself when decorative', () => {
    const container = renderAvatar(
      <PersonaAvatar decorative persona={{ id: 'dou-dou', name: 'Doudou', avatarUrl: 'data:image/png;base64,AAAA' }} />,
    );
    const avatar = container.querySelector<HTMLElement>('[data-persona-avatar="dou-dou"]')!;
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.getAttribute('role')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('frames a circle picture round, and keeps the rounded card for an initial', () => {
    const round = renderAvatar(<PersonaAvatar size={40} persona={{ id: 'dou-dou', name: 'Doudou', avatarUrl: 'data:image/png;base64,AAAA', avatarShape: 'circle' }} />);
    const image = round.querySelector<HTMLElement>('[data-persona-avatar="dou-dou"]')!;
    expect(image.dataset['personaAvatarShape']).toBe('circle');
    expect(image.style.borderRadius).toBe('20px');
    // A circle chosen for a picture no longer applies once the picture is gone.
    const initial = renderAvatar(<PersonaAvatar size={40} persona={{ id: 'dou-dou', name: 'Doudou', avatarShape: 'circle' }} />);
    const fallback = initial.querySelector<HTMLElement>('[data-persona-avatar="dou-dou"]')!;
    expect(fallback.dataset['personaAvatarKind']).toBe('initial');
    expect(fallback.dataset['personaAvatarShape']).toBe('square');
    expect(fallback.style.borderRadius).toBe('11px');
    expect(personaAvatarOf({ id: 'dou-dou', name: 'Doudou', avatarShape: 'circle' }).avatarShape).toBeUndefined();
  });

  it('keeps initials, tints and avatar URLs stable', () => {
    expect(personaInitial('  archivist')).toBe('A');
    expect(personaInitial('')).toBe('?');
    expect(personaTintIndex('xiao-you')).toBe(personaTintIndex('xiao-you'));
    expect(personaAvatarOf({ id: 'xiao-you', name: '小柚' }).avatarUrl).toBeUndefined();
    expect(personaAvatarOf({ id: 'xiao-you', name: '小柚', avatarMime: 'image/png' }).avatarUrl).toBe('/api/personas/xiao-you/avatar');
  });
});

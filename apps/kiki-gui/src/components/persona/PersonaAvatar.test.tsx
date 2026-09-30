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
    const container = renderAvatar(<PersonaAvatar persona={{ id: 'lin-lan', name: '林岚' }} />);
    const avatar = container.querySelector<HTMLElement>('[data-persona-avatar="lin-lan"]')!;
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('林岚');
    expect(avatar.textContent).toBe('林');
    expect(avatar.dataset['personaAvatarKind']).toBe('initial');
  });

  it('renders a data URL directly and hides itself when decorative', () => {
    const container = renderAvatar(
      <PersonaAvatar decorative persona={{ id: 'a-che', name: 'A Che', avatarUrl: 'data:image/png;base64,AAAA' }} />,
    );
    const avatar = container.querySelector<HTMLElement>('[data-persona-avatar="a-che"]')!;
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.getAttribute('role')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('keeps initials, tints and avatar URLs stable', () => {
    expect(personaInitial('  archivist')).toBe('A');
    expect(personaInitial('')).toBe('?');
    expect(personaTintIndex('lin-lan')).toBe(personaTintIndex('lin-lan'));
    expect(personaAvatarOf({ id: 'lin-lan', name: '林岚' }).avatarUrl).toBeUndefined();
    expect(personaAvatarOf({ id: 'lin-lan', name: '林岚', avatarMime: 'image/png' }).avatarUrl).toBe('/api/personas/lin-lan/avatar');
  });
});

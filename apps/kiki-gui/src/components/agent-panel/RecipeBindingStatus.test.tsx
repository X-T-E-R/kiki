// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { RecipeBindingStatus } from './RecipeBindingStatus';

const useCatalog = vi.hoisted(() => vi.fn());
vi.mock('./useAgentPanelCatalog', () => ({ useAgentPanelCatalog: useCatalog }));
vi.mock('./PromptEffectiveDrawer', () => ({
  PromptEffectiveDrawer: ({ sessionId, agentId }: { sessionId: string; agentId: string }) => <div data-prompt-drawer>{sessionId}:{agentId}</div>,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useCatalog.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(prompt: unknown): Promise<void> {
  useCatalog.mockReturnValue({ data: { prompt } });
  await act(async () => {
    root.render(<I18nProvider><RecipeBindingStatus sessionId="session-1" agentId="main" sourceRevision="binding-1" /></I18nProvider>);
  });
}

it('shows the frozen profile Recipe name and opens effective prompt details', async () => {
  await render({ recipe_model_binding: { references: [{ surface: 'profile', installation_id: 'profile-recipe', revision: 'rev-1', name: 'Focused work' }] } });

  expect(container.querySelector('[data-recipe-binding-status]')?.textContent).toContain('Focused work');
  expect(useCatalog).toHaveBeenCalledWith({ session_id: 'session-1', agent_id: 'main' }, true, 'binding-1');
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-recipe-binding-status]')?.click(); });
  expect(container.querySelector('[data-prompt-drawer]')?.textContent).toBe('session-1:main');
});

it.each([undefined, '   '])('shows the installation and frozen revision when the name is %s', async (name) => {
  await render({ recipe_model_binding: { references: [
    { surface: 'profile', installation_id: 'profile-recipe', revision: 'rev-1', name },
  ] } });
  expect(container.querySelector('[data-recipe-binding-status]')?.textContent).toContain('profile-recipe@rev-1');
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-recipe-binding-status]')?.click(); });
  expect(container.querySelector('[data-prompt-drawer]')).not.toBeNull();
});

it('does not infer a profile Recipe from an unbound declaration or model-only binding', async () => {
  await render({ identity: { profile: 'example-role' } });
  expect(container.querySelector('[data-recipe-binding-status]')).toBeNull();
  await render({ recipe_model_binding: { references: [{ surface: 'model', installation_id: 'model-pack', revision: 'rev-1', name: 'Model defaults' }] } });
  expect(container.querySelector('[data-recipe-binding-status]')).toBeNull();
});

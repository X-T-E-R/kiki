// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RequestIdentityLayerDraft } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { RequestIdentityLayerEditor } from './RequestIdentityLayerEditor';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function Harness() {
  const [value, setValue] = useState<RequestIdentityLayerDraft>({
    requestIdentityChoice: 'custom_overrides',
    requestIdentityOverridesJson: '{"client":{"user_agent":"host"}}',
  });
  return (
    <I18nProvider>
      <RequestIdentityLayerEditor
        value={value}
        onChange={setValue}
        label="Provider request identity"
        inheritLabel="Inherit global default"
        hint="Provider hint"
      />
      <output data-choice={value.requestIdentityChoice}>{value.requestIdentityOverridesJson}</output>
    </I18nProvider>
  );
}

async function renderEditor(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<Harness />); });
  return container;
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('RequestIdentityLayerEditor', () => {
  it('preserves overrides when switching authored presets', async () => {
    const container = await renderEditor();
    const select = container.querySelector('select')!;
    await choose(select, 'codex_compatible');

    expect(container.querySelector('textarea')?.value).toBe('{"client":{"user_agent":"host"}}');
    expect(container.querySelector('output')?.dataset['choice']).toBe('codex_compatible');
  });

  it('clears overrides only when the layer is explicitly inherited', async () => {
    const container = await renderEditor();
    const select = container.querySelector('select')!;
    await choose(select, 'inherit');

    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('');
    expect(container.querySelector('output')?.dataset['choice']).toBe('inherit');
  });
});

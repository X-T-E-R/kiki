// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ExperimentalSection } from './ExperimentalSection';

const client = {
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  meta: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
}));

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockReset().mockResolvedValue({
    experimental: {
      task_wait: true,
      auto_session_title: false,
    },
  });
  client.meta.mockReset().mockResolvedValue({
    experimental_flags: {
      task_wait: true,
      auto_session_title: false,
      search_worker: true,
    },
  });
  client.patchConfig.mockReset().mockImplementation(async (patch) => {
    return {
      experimental: {
        ...(patch.experimental ?? {}),
      },
    };
  });
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  query.clear();
});

describe('ExperimentalSection redesign', () => {
  it('renders single flag card without duplicating feature title in row', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={query}>
          <I18nProvider>
            <ExperimentalSection
              featureIds={['auto_session_title']}
              cardId="test-card-single"
              titleKey="st.experimental.sessionTitle"
            />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    const card = container.querySelector('#test-card-single')!;
    expect(card).not.toBeNull();
    // Card header has the title
    const header = card.querySelector('h2')!;
    expect(header.textContent).toContain('Sessions: generate conversation titles');

    // In single-flag card, the inner row should NOT duplicate the title
    const rowTitle = card.querySelector('span.text-\\[13px\\]');
    expect(rowTitle).toBeNull();

    // Inline effective badge
    const badge = card.querySelector('span.inline-flex.rounded-full');
    expect(badge?.textContent?.toLowerCase()).toContain('effective: off');

    // Combined rules and technical details folded
    const details = card.querySelector('details[data-technical-details]')!;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain('Rules & technical details');
    expect(details.textContent).toContain('Flag ID: auto_session_title');
    expect(details.textContent).toContain('Priority:');
  });

  it('supports unified save with extra child controls (onSaveExtra / onSavedExtra)', async () => {
    const onSaveExtra = vi.fn(() => ({
      session_title: { model: 'test/custom-model' },
    }));
    const onSavedExtra = vi.fn();

    await act(async () => {
      root.render(
        <QueryClientProvider client={query}>
          <I18nProvider>
            <ExperimentalSection
              featureIds={['auto_session_title']}
              cardId="test-card-single"
              titleKey="st.experimental.sessionTitle"
              extraDirty={true}
              onSaveExtra={onSaveExtra}
              onSavedExtra={onSavedExtra}
            >
              <div data-child="extra">Extra child field</div>
            </ExperimentalSection>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    const saveButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    expect(saveButton).toBeDefined();
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(onSaveExtra).toHaveBeenCalled();
    expect(client.patchConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        session_title: { model: 'test/custom-model' },
      }),
    );
    expect(onSavedExtra).toHaveBeenCalled();
  });
});

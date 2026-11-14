// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginGuiSlotContribution } from '@kiki/protocol';
import { LOCALE_STORAGE_KEY } from '@kiki/session-core/i18n';
import { subscribePluginPromptInserts, type PluginPromptInsertRequest } from '@kiki/session-core';

import { I18nProvider } from '../../i18n';
import { PluginComposerSlots, buildPluginPanelHref } from './PluginComposerSlots';
import { PluginStatusCapsules } from './PluginStatusCapsules';
import { PluginMessageActions } from './PluginMessageActions';
import { PluginSettingsSectionSlotList } from './PluginSettingsSectionCard';
import { PluginToolCardBody, resolvePluginToolTargetNode } from './PluginToolCardBody';

let container: HTMLDivElement;
let root: Root;

function LocationEcho() {
  const location = useLocation();
  return <div data-location={`${location.pathname}${location.search}${location.hash}`} />;
}

function renderWithProviders(ui: React.ReactNode, locale: 'en' | 'zh' = 'en') {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/sess-1']}>
            {ui}
            <LocationEcho />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  vi.restoreAllMocks();
});

const SAMPLE_SLOTS: readonly PluginGuiSlotContribution[] = [
  {
    slot: 'composer-toolbar',
    pluginId: 'cordis-git',
    id: 'stage-review',
    label: { default: 'Stage review', zh: '暂存审阅' },
    badgeText: '3',
    tone: 'accent',
    order: 10,
    action: {
      kind: 'insert_prompt',
      text: 'Review staged hunks for $ARGUMENTS',
      submit: false,
    },
  },
  {
    slot: 'composer-toolbar',
    pluginId: 'cordis-git',
    id: 'open-board',
    label: { default: 'Open panel', zh: '打开面板' },
    tone: 'neutral',
    order: 20,
    action: {
      kind: 'open_plugin_panel',
      panelId: 'overview',
    },
  },
  {
    slot: 'status-capsule',
    pluginId: 'cordis-lsp',
    id: 'tsserver',
    label: { default: 'TS Server', zh: '类型服务' },
    valueText: '14ms',
    dotTone: 'ok',
    order: 5,
    action: {
      kind: 'open_settings_section',
      sectionId: 'plugins',
    },
  },
  {
    slot: 'message-action',
    pluginId: 'cordis-notes',
    id: 'save-answer',
    label: { default: 'Pin to notes', zh: '收入笔记' },
    appliesToRoles: ['assistant'],
    order: 10,
    action: {
      kind: 'insert_prompt',
      text: 'Summarize pinned note',
      submit: true,
    },
  },
  {
    slot: 'settings-section',
    pluginId: 'cordis-lsp',
    id: 'language-servers',
    title: { default: 'Language server diagnostics', zh: '语言服务诊断' },
    subtitle: { default: 'Workspace hover & symbol indexing', zh: '工作区悬停与符号索引' },
    order: 10,
  },
];

describe('E12 declarative plugin GUI slot components', () => {
  it('renders Slot 1 composer toolbar chips, dispatches prompt inserts, and navigates to plugin panels', () => {
    const received: PluginPromptInsertRequest[] = [];
    const unsubscribe = subscribePluginPromptInserts('sess-1', (req) => {
      received.push(req);
      return true;
    });

    renderWithProviders(
      <PluginComposerSlots
        slots={SAMPLE_SLOTS}
        sessionId="sess-1"
        workspaceId="ws-1"
      />,
      'zh',
    );

    const chips = container.querySelectorAll<HTMLButtonElement>('[data-plugin-composer-slot]');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain('暂存审阅');
    expect(chips[0]?.textContent).toContain('3');

    act(() => {
      chips[0]?.click();
    });
    expect(received).toEqual([{ text: 'Review staged hunks for $ARGUMENTS', submit: false, args: undefined }]);

    act(() => {
      chips[1]?.click();
    });
    const loc = container.querySelector('[data-location]')?.getAttribute('data-location');
    expect(loc).toBe(
      buildPluginPanelHref({
        pluginId: 'cordis-git',
        panelId: 'overview',
        sessionId: 'sess-1',
        workspaceId: 'ws-1',
      }),
    );

    unsubscribe();
  });

  it('renders Slot 2 status capsules with semantic dot tone and settings deep link', () => {
    renderWithProviders(
      <PluginStatusCapsules
        slots={SAMPLE_SLOTS}
        sessionId="sess-1"
        workspaceId="ws-1"
      />,
      'en',
    );

    const group = container.querySelector('[data-plugin-status-capsules]');
    expect(group?.className).toContain('@max-[32rem]/toolbar:hidden');
    const capsule = container.querySelector<HTMLButtonElement>('[data-plugin-status-capsule="cordis-lsp:tsserver"]');
    expect(capsule).not.toBeNull();
    expect(capsule?.textContent).toContain('TS Server');
    expect(capsule?.textContent).toContain('14ms');
    expect(capsule?.querySelector('[data-plugin-capsule-value]')?.className).toContain('@max-[38rem]/toolbar:hidden');
    expect(container.querySelector('[data-plugin-capsule-dot="ok"]')).not.toBeNull();

    act(() => {
      capsule?.click();
    });
    const loc = container.querySelector('[data-location]')?.getAttribute('data-location');
    expect(loc).toBe('/settings/plugins?plugin=cordis-lsp');
  });

  it('filters Slot 3 message actions strictly by role (user vs assistant)', () => {
    renderWithProviders(
      <div>
        <div data-user-menu>
          <PluginMessageActions role="user" slots={SAMPLE_SLOTS} sessionId="sess-1" />
        </div>
        <div data-assistant-menu>
          <PluginMessageActions role="assistant" slots={SAMPLE_SLOTS} sessionId="sess-1" />
        </div>
      </div>,
      'zh',
    );

    expect(container.querySelector('[data-user-menu] [data-plugin-message-action]')).toBeNull();
    const assistantItem = container.querySelector<HTMLButtonElement>(
      '[data-assistant-menu] [data-plugin-message-action="cordis-notes:save-answer"]',
    );
    expect(assistantItem).not.toBeNull();
    expect(assistantItem?.textContent).toContain('收入笔记');
  });

  it('renders Slot 5 settings section cards with flat SectionCard header and plugin settings link', () => {
    renderWithProviders(<PluginSettingsSectionSlotList slots={SAMPLE_SLOTS} />, 'en');

    const card = container.querySelector('[data-settings-card="st-card-plugin-slot-cordis-lsp-language-servers"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Language server diagnostics');
    expect(card?.textContent).toContain('Workspace hover & symbol indexing');
    const link = container.querySelector<HTMLAnchorElement>('[data-plugin-settings-slot-link="cordis-lsp:language-servers"]');
    expect(link?.getAttribute('href')).toBe('/settings/plugins?plugin=cordis-lsp');
  });

  it('renders Slot 6 declarative tool card fields safely and blocks prototype traversal', () => {
    const toolSlot: Extract<PluginGuiSlotContribution, { slot: 'tool-card-renderer' }> = {
      slot: 'tool-card-renderer',
      pluginId: 'cordis-search',
      id: 'symbol-query',
      toolNames: ['symbol_search'],
      actionVerb: { default: 'Query symbols', zh: '检索符号' },
      targetFieldPath: 'args.file',
      summaryFields: [
        { label: { default: 'Matches', zh: '命中' }, sourcePath: 'result.count', format: 'badge' },
        { label: { default: 'Blocked', zh: '拦截' }, sourcePath: 'args.__proto__.polluted', format: 'inline-text' },
      ],
      detailFields: [
        { label: { default: 'Snippet', zh: '代码片段' }, sourcePath: 'result.preview', format: 'code' },
      ],
    };

    const sources = {
      args: { file: 'src/routes/pluginBroker.ts' },
      result: { count: 4, preview: '<script>alert(1)</script>\nexport function registerPluginBrokerRoutes() {}' },
    };

    renderWithProviders(
      <div>
        <div data-target-preview>{resolvePluginToolTargetNode(toolSlot, sources)}</div>
        <PluginToolCardBody
          slot={toolSlot}
          sources={sources}
          rawFallback={<div data-raw-fallback>raw</div>}
        />
      </div>,
      'en',
    );

    expect(container.querySelector('[data-plugin-tool-target]')?.textContent).toContain('src/routes/pluginBroker.ts');
    expect(container.querySelector('[data-plugin-tool-summary]')?.textContent).toContain('Matches');
    expect(container.querySelector('[data-plugin-tool-summary]')?.textContent).toContain('4');
    expect(container.querySelector('[data-plugin-tool-summary]')?.textContent).not.toContain('Blocked');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[data-plugin-tool-details] pre')?.textContent).toContain('<script>alert(1)</script>');
  });
});

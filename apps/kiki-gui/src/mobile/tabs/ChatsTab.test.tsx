// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it } from 'vitest';

import type { UnifiedInboxItem } from '@kiki/session-core/sessions';
import { encodeConversationRef } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { ChatsTab } from './ChatsTab';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterAll(() => {
  for (const root of roots) root.unmount();
  for (const container of containers) container.remove();
});

function makeItem(overrides: Partial<UnifiedInboxItem> & { sessionId: string; title: string }): UnifiedInboxItem {
  const spaceKey = overrides.spaceKey ?? 'main';
  const ref = { spaceKey, kind: 'session' as const, id: overrides.sessionId };
  return {
    ref,
    encodedKey: encodeConversationRef(ref),
    spaceKey,
    spaceName: overrides.spaceName ?? 'Main space',
    isRemote: overrides.isRemote ?? false,
    workspaceId: overrides.workspaceId ?? 'ws-1',
    workspaceName: overrides.workspaceName ?? 'Project',
    sessionId: overrides.sessionId,
    title: overrides.title,
    reason: overrides.reason ?? 'completed',
    at: overrides.at ?? '2026-11-23T00:00:00.000Z',
    busy: overrides.busy ?? false,
    attentionCursor: overrides.attentionCursor ?? { seq: 1 },
    lastSeq: overrides.lastSeq ?? 1,
    triageClass: overrides.triageClass ?? 'settled',
    unread: overrides.unread ?? false,
    needsYou: overrides.needsYou ?? false,
    preview: overrides.preview,
  };
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ChatsTab pagination and multi-space search', () => {
  it('loads older conversations beyond the initial page via onLoadMore', async () => {
    let loadMoreCount = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);

    const firstPage = [makeItem({ sessionId: 's-1', title: 'Newest thread' })];
    const renderView = async (items: readonly UnifiedInboxItem[], hasMore: boolean) => {
      await act(async () => {
        flushSync(() => {
          root.render(
            <I18nProvider>
              <ChatsTab
                spaceLabel="All spaces"
                spaceStatusTone="online"
                items={items}
                showSpaceTag
                hasMore={hasMore}
                onLoadMore={() => { loadMoreCount += 1; }}
                onOpenSpaceSheet={() => {}}
                onOpenItem={() => {}}
                onMarkRead={() => {}}
                onArchive={() => {}}
              />
            </I18nProvider>,
          );
        });
      });
    };

    await renderView(firstPage, true);
    const loadMoreBtn = container.querySelector<HTMLButtonElement>('[data-mobile-chats-load-more]');
    expect(loadMoreBtn).not.toBeNull();

    await act(async () => {
      flushSync(() => {
        loadMoreBtn!.click();
      });
    });
    expect(loadMoreCount).toBe(1);

    await renderView(
      [
        ...firstPage,
        makeItem({
          sessionId: 's-older-remote',
          spaceKey: 'remote:conn-1',
          spaceName: 'Mac Studio',
          isRemote: true,
          title: 'Older remote thread',
          at: '2026-11-20T00:00:00.000Z',
        }),
      ],
      false,
    );

    expect(container.querySelector('[data-mobile-chat-row="s-older-remote"]')).not.toBeNull();
    expect(container.querySelector('[data-mobile-chats-load-more]')).toBeNull();
  });

  it('finds conversations outside the initial page across local and paired spaces via onSearch', async () => {
    const queries: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    containers.push(container);

    await act(async () => {
      flushSync(() => {
        root.render(
          <I18nProvider>
            <ChatsTab
              spaceLabel="All spaces"
              spaceStatusTone="online"
              items={[makeItem({ sessionId: 's-1', title: 'Recent local chat' })]}
              showSpaceTag
              hasMore
              onSearch={async (q) => {
                queries.push(q);
                return [
                  makeItem({
                    sessionId: 's-deep-local',
                    title: 'Deep archived needle local',
                    at: '2026-10-01T00:00:00.000Z',
                  }),
                  makeItem({
                    sessionId: 's-deep-remote',
                    spaceKey: 'remote:conn-2',
                    spaceName: 'Dorm 3090',
                    isRemote: true,
                    title: 'Deep remote needle',
                    at: '2026-10-02T00:00:00.000Z',
                  }),
                ];
              }}
              onOpenSpaceSheet={() => {}}
              onOpenItem={() => {}}
              onMarkRead={() => {}}
              onArchive={() => {}}
            />
          </I18nProvider>,
        );
      });
    });

    const toggleBtn = container.querySelector<HTMLButtonElement>('header button:last-of-type')!;
    await act(async () => {
      flushSync(() => {
        toggleBtn.click();
      });
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      flushSync(() => {
        setNativeInputValue(searchInput, 'needle');
      });
    });

    expect(queries).toEqual(['needle']);
    expect(container.querySelector('[data-mobile-chat-row="s-deep-local"]')).not.toBeNull();
    expect(container.querySelector('[data-mobile-chat-row="s-deep-remote"]')).not.toBeNull();
  });
});

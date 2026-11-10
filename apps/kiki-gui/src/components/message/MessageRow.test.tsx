// @vitest-environment jsdom

/**
 * The message row's delivery reading: what a receipt reports decides whether
 * the row is speech here, a delivery line to another destination, or an
 * unconfirmed outcome — and which attachments may be drawn as delivered media.
 * Copy is asserted through the keys and parameters it asks for, so the strings
 * themselves stay owned by the shared dictionary.
 */

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';
import type { MessageAttachment, MessageBlock, MessageChannelDelivery } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { MessageAttachmentView, MessageRow } from './MessageRow';
import { deliveryNotes } from './messageDelivery';

// The preview seam: opening an attachment is what a message row offers, and
// the ref it hands over is what the assertion reads.
const previewProbe = vi.hoisted(() => ({
  openAttachment: vi.fn(),
  openAttachmentInWorkspace: vi.fn(),
  openWeb: vi.fn(),
  openImage: vi.fn(),
  workspaceEnabled: false,
}));
vi.mock('../mediaPreviewContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mediaPreviewContext')>();
  return {
    ...original,
    useMediaPreview: () => ({
      sessionId: 'session',
      cwd: '/workspace',
      openImage: previewProbe.openImage,
      openFile: () => {},
      openAttachment: previewProbe.openAttachment,
      openAttachmentInWorkspace: previewProbe.workspaceEnabled ? previewProbe.openAttachmentInWorkspace : undefined,
      openWeb: previewProbe.openWeb,
      previewTabCount: 0,
      previewPanelOpen: false,
      togglePreviewPanel: () => {},
      activeAgentPanelId: undefined,
    }),
  };
});

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', undefined);
});

afterAll(async () => {
  for (const root of roots) await act(async () => { flushSync(() => { root.unmount(); }); });
});

function render(node: ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <I18nProvider>{node}</I18nProvider>
        </QueryClientProvider>,
      );
    });
  });
  roots.push(root);
  return container;
}

function row(container: HTMLDivElement): HTMLDivElement {
  const found = container.querySelector<HTMLDivElement>('[data-message-row]');
  if (found === null) throw new Error('the row did not render');
  return found;
}

const SPEAKER = { id: 'lin-lan', name: '林岚' };

function message(overrides: Partial<MessageBlock> = {}): MessageBlock {
  return {
    kind: 'message', id: 'm1', messageId: 'send:call', origin: 'send_message', status: 'sent',
    text: '清单在这里：周四冻结，周五打 tag。', attachments: [], deliveredTo: ['user'],
    personaId: 'lin-lan', senderName: '林岚', turnId: 't1', ...overrides,
  };
}

function draw(block: MessageBlock, onOpenProcess?: () => void): HTMLDivElement {
  return render(
    <MessageRow block={block} speaker={SPEAKER} continued={false} currentSessionId="session" onOpenProcess={onOpenProcess} />,
  );
}

const image: MessageAttachment = { blobId: 'blob-image', path: '/media/a.png', title: '封面.png', mimeType: 'image/png', size: 12, kind: 'image' };
const voice: MessageAttachment = { blobId: 'blob-voice', path: '/media/note.wav', title: '口述.wav', mimeType: 'audio/wav', size: 40, kind: 'voice' };
const clip: MessageAttachment = { blobId: 'blob-clip', path: '/media/take.mp4', title: 'take.mp4', mimeType: 'video/mp4', size: 120, kind: 'video' };
const report: MessageAttachment = { blobId: 'blob-report', path: '/media/report.pdf', title: 'report.pdf', mimeType: 'application/pdf', size: 999, kind: 'file' };

function channels(...values: MessageChannelDelivery[]): MessageChannelDelivery[] {
  return values;
}

describe('message delivery reading', () => {
  it('leaves a receipt with no channels exactly as it was', () => {
    const container = draw(message());
    const rendered = row(container);
    expect(rendered.dataset['messageStatus']).toBe('sent');
    expect(rendered.dataset['messageReached']).toBeUndefined();
    expect(container.querySelector('[data-message-delivery-notes]')).toBeNull();
    expect(rendered.textContent).toContain('清单在这里');
  });

  it('sets speech that reached another destination under its own destination line', () => {
    const container = draw(message({
      reached: 'elsewhere', deliveredTo: ['user'],
      channels: channels({ channelId: 'im:tg-main', status: 'delivered', messageIds: ['42'] }),
    }));
    const rendered = row(container);
    expect(rendered.dataset['messageReached']).toBe('elsewhere');
    expect(container.querySelector('[data-message-delivery-note="elsewhere"]')?.textContent).toContain('im:tg-main');
    // The words stay readable; what changes is the claim about where they went.
    expect(rendered.textContent).toContain('清单在这里');
  });

  it('says an unconfirmed outcome is unconfirmed and opens the process from it', () => {
    const openProcess = vi.fn();
    const container = draw(message({
      status: 'pending', reached: 'unconfirmed', deliveredTo: [], text: '清单在这里。',
      channels: channels({ channelId: 'internal', status: 'unknown', detail: 'timeout' }),
    }), openProcess);
    expect(row(container).dataset['messageStatus']).toBe('pending');
    const note = container.querySelector<HTMLButtonElement>('[data-message-delivery-note="unconfirmed"]');
    expect(note).not.toBeNull();
    expect(note?.tagName).toBe('BUTTON');
    act(() => { note?.click(); });
    expect(openProcess).toHaveBeenCalledTimes(1);
  });

  it('names the media this conversation did not receive instead of drawing it as sent', () => {
    const container = draw(message({
      attachments: [image, voice],
      channels: channels({ channelId: 'internal', status: 'delivered', unsupported: ['voice'] }),
    }));
    expect(container.querySelector('[data-message-media="image"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-message-media="audio"]')).toBeNull();
    expect(container.querySelector('[data-message-delivery-note="internal-unsupported"]')).not.toBeNull();
  });

  it('names a channel that took none of the attachments and one whose outcome is unknown', () => {
    const container = draw(message({
      attachments: [image],
      channels: channels(
        { channelId: 'internal', status: 'delivered' },
        { channelId: 'im:slack-ops', status: 'unsupported', unsupported: ['image'] },
        { channelId: 'im:discord-team', status: 'unknown' },
      ),
    }));
    expect(container.querySelector('[data-message-delivery-note="channel-unsupported-im:slack-ops"]')).not.toBeNull();
    expect(container.querySelector('[data-message-delivery-note="channel-unknown-im:discord-team"]')).not.toBeNull();
    // Everything this conversation received is still drawn as speech and media.
    expect(row(container).dataset['messageStatus']).toBe('sent');
    expect(container.querySelector('[data-message-media="image"]')).not.toBeNull();
  });

  it('keeps channel reasons beside a failed send', () => {
    const container = draw(message({
      status: 'failed', text: '', deliveredTo: [],
      channels: channels({ channelId: 'im:matrix-room', status: 'failed', detail: 'not joined' }),
    }));
    expect(container.querySelector('[data-message-delivery-note="channel-failed-im:matrix-room"]')).not.toBeNull();
  });
});

describe('attachment media kinds', () => {
  it('draws a declared image, voice note, clip and document as what the send declared', () => {
    const media = draw(message({ attachments: [image] }));
    expect(media.querySelector('[data-message-media="image"]')).not.toBeNull();

    const audio = draw(message({ attachments: [voice] }));
    const audioSlot = audio.querySelector<HTMLElement>('[data-message-media="audio"]');
    expect(audioSlot).not.toBeNull();
    expect(audioSlot?.dataset['messageVoice']).toBe('');

    const video = draw(message({ attachments: [clip] }));
    expect(video.querySelector('[data-message-media="video"]')).not.toBeNull();

    const document = draw(message({ attachments: [report] }));
    expect(document.querySelector('[data-message-media="file"]')).not.toBeNull();
    const open = document.querySelector<HTMLButtonElement>('[data-message-attachment-open]');
    expect(open).not.toBeNull();
    previewProbe.openAttachment.mockClear();
    act(() => { open?.click(); });
    // The preview is asked for the receipt's own bytes, declared as a document.
    expect(previewProbe.openAttachment).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', fileId: 'blob-report', mime: 'application/pdf' }));
  });

  it('never presents an audio attachment as a voice note', () => {
    const plainAudio: MessageAttachment = { ...voice, kind: 'audio' };
    const container = draw(message({ attachments: [plainAudio] }));
    const slot = container.querySelector<HTMLElement>('[data-message-media="audio"]');
    expect(slot).not.toBeNull();
    expect(slot?.dataset['messageVoice']).toBeUndefined();
  });

  it('does not offer to open a blob that belongs to another session', () => {
    const container = render(<MessageAttachmentView attachment={image} readable={false} />);
    expect(container.querySelector('[data-message-media="image"]')).not.toBeNull();
    expect(container.querySelector('[data-message-attachment-open]')).toBeNull();
  });

  it('distinguishes HTML, PDF, Office, Markdown, code, archive and web links in timeline cards and routes clicks to PreviewWorkspace', () => {
    const htmlAtt: MessageAttachment = {
      blobId: 'blobref:main:html1',
      path: '/workspace/demo/index.html',
      title: '互动路演.html',
      mimeType: 'text/html',
      size: 4096,
      kind: 'file',
    };
    const docxAtt: MessageAttachment = {
      blobId: 'blobref:main:docx1',
      path: '/workspace/docs/spec.docx',
      title: '架构方案.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 16384,
      kind: 'file',
    };
    const mdAtt: MessageAttachment = {
      blobId: 'blobref:main:md1',
      path: '/workspace/README.md',
      title: 'README.md',
      mimeType: 'text/markdown',
      size: 2048,
      kind: 'file',
    };
    const zipAtt: MessageAttachment = {
      blobId: 'blobref:main:zip1',
      path: '/workspace/bundle.zip',
      title: 'bundle.zip',
      mimeType: 'application/zip',
      size: 65536,
      kind: 'file',
    };

    previewProbe.workspaceEnabled = true;
    previewProbe.openAttachmentInWorkspace.mockClear();
    previewProbe.openWeb.mockClear();
    try {
      const container = draw(message({
        text: '请审阅页面 [路演看板](https://board.example.com/roadshow/2026) 与以下附件：',
        attachments: [htmlAtt, report, docxAtt, mdAtt, zipAtt],
      }));

      expect(container.querySelector('[data-message-attachment-subtype="html"]')).not.toBeNull();
      expect(container.querySelector('[data-message-attachment-subtype="pdf"]')).not.toBeNull();
      expect(container.querySelector('[data-message-attachment-subtype="docx"]')).not.toBeNull();
      expect(container.querySelector('[data-message-attachment-subtype="markdown"]')).not.toBeNull();
      expect(container.querySelector('[data-message-attachment-subtype="archive"]')).not.toBeNull();

      const htmlOpen = container.querySelector<HTMLButtonElement>('[data-message-attachment="blobref:main:html1"] [data-message-attachment-open]');
      expect(htmlOpen).not.toBeNull();
      act(() => { htmlOpen?.click(); });
      expect(previewProbe.openAttachmentInWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'file',
        fileId: 'blobref:main:html1',
        path: '/workspace/demo/index.html',
        mime: 'text/html',
      }));

      const pdfOpen = container.querySelector<HTMLButtonElement>('[data-message-attachment="blob-report"] [data-message-attachment-open]');
      act(() => { pdfOpen?.click(); });
      expect(previewProbe.openAttachmentInWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'file',
        fileId: 'blob-report',
        path: undefined,
        mime: 'application/pdf',
      }));

      const webCard = container.querySelector<HTMLElement>('[data-message-web-preview="https://board.example.com/roadshow/2026"]');
      expect(webCard).not.toBeNull();
      const webOpen = webCard?.querySelector<HTMLButtonElement>('[data-message-web-open]');
      act(() => { webOpen?.click(); });
      expect(previewProbe.openWeb).toHaveBeenCalledWith('https://board.example.com/roadshow/2026', '路演看板');
    } finally {
      previewProbe.workspaceEnabled = false;
    }
  });

  it('never exposes a cross-session sender path or opens a cross-session HTML/file attachment', () => {
    const crossHtml: MessageAttachment = {
      blobId: 'blobref:peer:html9',
      path: 'C:/Users/sender/secret/index.html',
      title: 'sender.html',
      mimeType: 'text/html',
      size: 512,
      kind: 'file',
    };
    const container = render(
      <MessageRow
        block={message({ sourceSessionId: 'other-session', attachments: [crossHtml] })}
        speaker={SPEAKER}
        continued={false}
        currentSessionId="session"
      />,
    );
    const card = container.querySelector<HTMLElement>('[data-message-attachment="blobref:peer:html9"]');
    expect(card).not.toBeNull();
    expect(card?.dataset['messageAttachmentReadable']).toBe('false');
    expect(card?.querySelector('[data-message-attachment-open]')).toBeNull();
    expect(card?.innerHTML).not.toContain('C:/Users/sender/secret/index.html');
  });

  it('renders and opens web preview cards when a message URL contains malformed percent-encoded pathname sequences', () => {
    previewProbe.openWeb.mockClear();
    const container = draw(message({
      text: '参见 https://example.test/% 与 https://example.test/docs/%E0%A4 的说明。',
    }));

    const barePercentCard = container.querySelector<HTMLElement>('[data-message-web-preview="https://example.test/%"]');
    expect(barePercentCard).not.toBeNull();
    expect(barePercentCard?.textContent).toContain('example.test / %');
    const barePercentOpen = barePercentCard?.querySelector<HTMLButtonElement>('[data-message-web-open]');
    act(() => { barePercentOpen?.click(); });
    expect(previewProbe.openWeb).toHaveBeenCalledWith('https://example.test/%', 'example.test / %');

    const truncatedUtf8Card = container.querySelector<HTMLElement>('[data-message-web-preview="https://example.test/docs/%E0%A4"]');
    expect(truncatedUtf8Card).not.toBeNull();
    expect(truncatedUtf8Card?.textContent).toContain('example.test / docs/%E0%A4');
    const truncatedUtf8Open = truncatedUtf8Card?.querySelector<HTMLButtonElement>('[data-message-web-open]');
    act(() => { truncatedUtf8Open?.click(); });
    expect(previewProbe.openWeb).toHaveBeenCalledWith('https://example.test/docs/%E0%A4', 'example.test / docs/%E0%A4');
  });
});

describe('delivery note contract', () => {
  function record(): { calls: [I18nKey, I18nParams | undefined][]; t: (key: I18nKey, params?: I18nParams) => string } {
    const calls: [I18nKey, I18nParams | undefined][] = [];
    return { calls, t: (key, params) => { calls.push([key, params]); return key; } };
  }

  it('asks for the destination and the unconfirmed line by key and parameter', () => {
    const elsewhere = record();
    deliveryNotes(message({
      reached: 'elsewhere',
      channels: channels(
        { channelId: 'im:tg-main', status: 'delivered' },
        { channelId: 'im:discord-b', status: 'delivered' },
        { channelId: 'im:matrix-c', status: 'failed' },
      ),
    }), elsewhere.t, 'zh');
    expect(elsewhere.calls).toContainEqual(['message.deliveryElsewhere', { channels: 'im:tg-main、im:discord-b' }]);
    expect(elsewhere.calls).toContainEqual(['message.channelFailed', { channel: 'im:matrix-c' }]);

    const unconfirmed = record();
    deliveryNotes(message({
      status: 'pending', reached: 'unconfirmed',
      channels: channels({ channelId: 'internal', status: 'unknown' }, { channelId: 'im:matrix-room', status: 'unknown' }),
    }), unconfirmed.t, 'zh');
    // This conversation's own unknown outcome is the unconfirmed line itself;
    // another destination's unknown outcome is named where it happened.
    expect(unconfirmed.calls).toContainEqual(['message.deliveryUnconfirmed', undefined]);
    expect(unconfirmed.calls).toContainEqual(['message.channelUnknown', { channel: 'im:matrix-room' }]);
  });

  it('names the kind that did not arrive, in the reader’s words', () => {
    const calls = record();
    deliveryNotes(message({
      channels: channels({ channelId: 'internal', status: 'delivered', unsupported: ['image', 'voice'] }),
    }), calls.t, 'en');
    // The recording translate answers with the key itself, so the kinds list
    // shows which labels it asked for and the English separator between them.
    expect(calls.calls).toContainEqual(['message.internalUnsupported', { kinds: 'message.media.image, message.media.voice' }]);
    expect(calls.calls).toContainEqual(['message.media.image', undefined]);
    expect(calls.calls).toContainEqual(['message.media.voice', undefined]);
  });

  it('names the media a channel skipped even when its message itself arrived', () => {
    // 509's receipt reports a partial send as `delivered` plus the kinds it
    // did not take; that list is the note, not a reason to stay silent.
    const calls = record();
    deliveryNotes(message({
      channels: channels(
        { channelId: 'internal', status: 'delivered' },
        { channelId: 'im:tg-main', status: 'delivered', messageIds: ['42'], unsupported: ['voice'] },
      ),
    }), calls.t, 'zh');
    expect(calls.calls).toContainEqual(['message.channelUnsupported', { channel: 'im:tg-main', kinds: 'message.media.voice' }]);
    expect(calls.calls).not.toContainEqual(['message.channelFailed', { channel: 'im:tg-main' }]);
  });

  it('keeps an unknown outcome unknown instead of reading its media list', () => {
    const calls = record();
    deliveryNotes(message({
      status: 'pending', reached: 'unconfirmed',
      channels: channels({ channelId: 'im:matrix-room', status: 'unknown', unsupported: ['image'] }),
    }), calls.t, 'zh');
    expect(calls.calls).toContainEqual(['message.channelUnknown', { channel: 'im:matrix-room' }]);
    expect(calls.calls.some(([key]) => key === 'message.channelUnsupported')).toBe(false);
  });

  it('says a channel took no attachment at all when its own reason names none', () => {
    const calls = record();
    deliveryNotes(message({
      channels: channels({ channelId: 'internal', status: 'delivered' }, { channelId: 'im:slack-ops', status: 'unsupported' }),
    }), calls.t, 'zh');
    expect(calls.calls).toContainEqual(['message.channelFailed', { channel: 'im:slack-ops' }]);
  });

  it('has nothing to say when every destination simply delivered', () => {
    const calls = record();
    expect(deliveryNotes(message({ channels: channels({ channelId: 'internal', status: 'delivered' }) }), calls.t, 'zh')).toEqual([]);
  });

  it('renders partial delivery status through i18n for internal and external channels', () => {
    const internalPartial = record();
    deliveryNotes(message({
      channels: channels({ channelId: 'internal', status: 'partial' }),
    }), internalPartial.t, 'zh');
    expect(internalPartial.calls).toContainEqual(['message.internalPartial', undefined]);

    const externalPartial = record();
    deliveryNotes(message({
      channels: channels(
        { channelId: 'internal', status: 'delivered' },
        { channelId: 'im:feishu', status: 'partial' },
      ),
    }), externalPartial.t, 'zh');
    expect(externalPartial.calls).toContainEqual(['message.channelPartial', { channel: 'im:feishu' }]);
  });
});

describe('failed message error disclosure', () => {
  it('shows a concise failure headline by default and expands the full error detail on click', () => {
    const fullDetail = 'Attachment path rejected by remote relay\nDiagnostic trace: gateway=edge-2\ncode=413_PAYLOAD_TOO_LARGE';
    const container = draw(message({
      status: 'failed',
      text: 'Report attached',
      deliveredTo: [],
      failureDetail: fullDetail,
    }));
    const toggle = container.querySelector<HTMLButtonElement>('[data-message-failure-detail]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Attachment path rejected by remote relay');
    expect(toggle.textContent).not.toContain('413_PAYLOAD_TOO_LARGE');

    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain(fullDetail);
  });
});

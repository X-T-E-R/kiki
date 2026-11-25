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

import { browserHost, HostProvider } from '../../host';
import { I18nProvider } from '../../i18n';
import { ConnectionContext, type ConnectionValue } from '../../state/connection';
import { MediaPreviewContext } from '../mediaPreviewContext';
import { configureRemoteMediaPlayback } from '../useSessionMediaPlayback';
import { MessageAttachmentView, MessageRow } from './MessageRow';
import { deliveryNotes } from './messageDelivery';
import { messageAttachmentSubtype } from './messageMedia';

// The preview seam: opening an attachment is what a message row offers, and
// the ref it hands over is what the assertion reads.
const previewProbe = {
  openAttachment: vi.fn(),
  openAttachmentInWorkspace: vi.fn(),
  openFile: vi.fn(),
  openWeb: vi.fn(),
  openImage: vi.fn(),
  openUrl: vi.fn(async () => {}),
  workspaceEnabled: false,
  connection: null as Record<string, unknown> | null,
};

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', undefined);
  configureRemoteMediaPlayback(false);
});

afterAll(async () => {
  configureRemoteMediaPlayback(null);
  for (const root of roots) await act(async () => { flushSync(() => { root.unmount(); }); });
});

function render(node: ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const previewApi = {
    sessionId: 'session',
    cwd: '/workspace',
    openImage: previewProbe.openImage,
    openFile: previewProbe.openFile,
    openAgentPanel: () => {},
    openBuiltinSkill: () => {},
    openAttachment: previewProbe.openAttachment,
    openAttachmentInWorkspace: previewProbe.workspaceEnabled ? previewProbe.openAttachmentInWorkspace : undefined,
    openWeb: previewProbe.openWeb,
    previewTabCount: 0,
    previewPanelOpen: false,
    togglePreviewPanel: () => {},
    activeAgentPanelId: undefined,
  };
  act(() => {
    flushSync(() => {
      root.render(
        <HostProvider host={{ ...browserHost, openUrl: previewProbe.openUrl }}>
          <QueryClientProvider client={new QueryClient()}>
            <ConnectionContext.Provider value={previewProbe.connection as unknown as ConnectionValue | null}>
              <MediaPreviewContext.Provider value={previewApi}>
                <I18nProvider>{node}</I18nProvider>
              </MediaPreviewContext.Provider>
            </ConnectionContext.Provider>
          </QueryClientProvider>
        </HostProvider>,
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

const SPEAKER = { id: 'xiao-you', name: '小柚' };

function message(overrides: Partial<MessageBlock> = {}): MessageBlock {
  return {
    kind: 'message', id: 'm1', messageId: 'send:call', origin: 'send_message', status: 'sent',
    text: '清单在这里：周四冻结，周五打 tag。', attachments: [], deliveredTo: ['user'],
    personaId: 'xiao-you', senderName: '小柚', turnId: 't1', ...overrides,
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
    previewProbe.openFile.mockClear();
    previewProbe.openWeb.mockClear();
    previewProbe.openUrl.mockClear();
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

      // Originless HTML receipt stays on the preserved session copy rather than opening a live host file.
      const htmlOpen = container.querySelector<HTMLButtonElement>('[data-message-attachment="blobref:main:html1"] [data-message-attachment-open]');
      expect(htmlOpen).not.toBeNull();
      act(() => { htmlOpen?.click(); });
      expect(previewProbe.openFile).not.toHaveBeenCalled();
      expect(previewProbe.openAttachmentInWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'file',
        fileId: 'blobref:main:html1',
        path: undefined,
        origin: undefined,
        mime: 'text/html',
      }));

      // Trusted-origin HTML attachment (with sourceId) opens the live host file directly.
      const trustedHtmlAtt: MessageAttachment = {
        ...htmlAtt,
        blobId: 'blobref:main:html-trusted',
        sourceId: 'a'.repeat(64),
        path: '/workspace/demo/trusted.html',
      };
      const trustedHtmlContainer = draw(message({ attachments: [trustedHtmlAtt] }));
      const trustedHtmlOpen = trustedHtmlContainer.querySelector<HTMLButtonElement>('[data-message-attachment="blobref:main:html-trusted"] [data-message-attachment-open]');
      expect(trustedHtmlOpen).not.toBeNull();
      act(() => { trustedHtmlOpen?.click(); });
      expect(previewProbe.openFile).toHaveBeenCalledWith('/workspace/demo/trusted.html');

      const pdfOpen = container.querySelector<HTMLButtonElement>('[data-message-attachment="blob-report"] [data-message-attachment-open]');
      act(() => { pdfOpen?.click(); });
      expect(previewProbe.openAttachmentInWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'file',
        fileId: 'blob-report',
        path: undefined,
        mime: 'application/pdf',
      }));

      // WebLinkPreviewCard primary click opens directly in browser, while the preview icon opens PreviewWorkspace.
      const webCard = container.querySelector<HTMLElement>('[data-message-web-preview="https://board.example.com/roadshow/2026"]');
      expect(webCard).not.toBeNull();
      const webOpen = webCard?.querySelector<HTMLButtonElement>('[data-message-web-open]');
      act(() => { webOpen?.click(); });
      expect(previewProbe.openUrl).toHaveBeenCalledWith('https://board.example.com/roadshow/2026');
      expect(previewProbe.openWeb).not.toHaveBeenCalled();

      const webPreviewBtn = webCard?.querySelector<HTMLButtonElement>('[data-message-web-preview-btn]');
      expect(webPreviewBtn).not.toBeNull();
      act(() => { webPreviewBtn?.click(); });
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

  it('carries a trusted origin only when sourceId is present across file, image, video, and audio kinds', async () => {
    const sourceId = 'b'.repeat(64);
    const fileWithSource: MessageAttachment = {
      blobId: 'blob-file-src',
      sourceId,
      path: '/workspace/docs/notes.md',
      title: 'notes.md',
      mimeType: 'text/markdown',
      size: 100,
      kind: 'file',
    };
    const imageWithSource: MessageAttachment = { ...image, blobId: 'blob-img-src', sourceId, path: '/workspace/assets/cover.png' };
    const videoWithSource: MessageAttachment = { ...clip, blobId: 'blob-vid-src', sourceId, path: '/workspace/assets/take.mp4' };
    const audioWithSource: MessageAttachment = { ...voice, blobId: 'blob-aud-src', sourceId, path: '/workspace/assets/note.wav' };

    const fileWithoutSource: MessageAttachment = {
      blobId: 'blob-file-upload',
      path: 'f_upload_0001',
      title: 'upload.pdf',
      mimeType: 'application/pdf',
      size: 200,
      kind: 'file',
    };
    const imageWithoutSource: MessageAttachment = { ...image, blobId: 'blob-img-nosrc' };
    const videoWithoutSource: MessageAttachment = { ...clip, blobId: 'blob-vid-nosrc' };
    const audioWithoutSource: MessageAttachment = { ...voice, blobId: 'blob-aud-nosrc' };

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-media');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const previewHostFile = vi.fn(async () => ({ content: 'ok', totalBytes: 2, truncated: false, lossless: true }));
    previewProbe.connection = {
      scopeId: 'local',
      spaceKey: 'local',
      connectionSource: 'desktop',
      client: {
        baseUrl: 'http://127.0.0.1:8787',
        klient: {},
        previewHostFile,
        readingOptions: () => ({}),
        readSessionMediaPreviewBytes: vi.fn(async (_sid: string, fileId: string) => ({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mime: fileId.includes('vid') ? 'video/mp4' : 'image/png',
          name: fileId,
        })),
        readSessionMediaBytes: vi.fn(async () => { throw new Error('offline'); }),
      },
    };
    try {
      previewProbe.openAttachment.mockClear();
      previewProbe.openFile.mockClear();
      const withSourceContainer = draw(message({
        attachments: [fileWithSource, imageWithSource, videoWithSource, audioWithSource],
      }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const fileTitleEl = withSourceContainer.querySelector<HTMLElement>('[data-message-attachment="blob-file-src"] span[title]');
      expect(fileTitleEl?.getAttribute('title')).toBe('/workspace/docs/notes.md');

      await act(async () => {
        withSourceContainer.querySelector<HTMLButtonElement>('[data-message-attachment="blob-file-src"] [data-message-attachment-open]')?.click();
        await Promise.resolve();
      });
      expect(previewProbe.openFile).toHaveBeenLastCalledWith('/workspace/docs/notes.md');

      // Missing/unreadable local file falls back silently to preserved session copy with trusted origin intact.
      previewHostFile.mockRejectedValueOnce(new Error('ENOENT'));
      await act(async () => {
        withSourceContainer.querySelector<HTMLButtonElement>('[data-message-attachment="blob-file-src"] [data-message-attachment-open]')?.click();
        await Promise.resolve();
      });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'file',
          fileId: 'blob-file-src',
          sourceId,
          origin: { path: '/workspace/docs/notes.md', trusted: true },
        }),
      );

      // Right-clicking AttachmentCard raises the unified file context menu with copy-path and open-preview.
      const fileCard = withSourceContainer.querySelector<HTMLElement>('[data-message-attachment="blob-file-src"]')!;
      act(() => {
        fileCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
      });
      const fileMenu = document.body.querySelector('[data-file-link-menu]');
      expect(fileMenu).not.toBeNull();
      expect(fileMenu?.querySelector('[data-menu-item="open-preview"]')).not.toBeNull();
      expect(fileMenu?.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      const imgBtn = withSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="image"] button');
      expect(imgBtn).not.toBeNull();
      act(() => { imgBtn?.click(); });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'image',
          fileId: 'blob-img-src',
          sourceId,
          path: undefined,
          origin: { path: '/workspace/assets/cover.png', trusted: true },
        }),
        'main',
      );

      const vidBtn = withSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="video"] button');
      expect(vidBtn).not.toBeNull();
      act(() => { vidBtn?.click(); });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'video',
          fileId: 'blob-vid-src',
          sourceId,
          path: undefined,
          origin: { path: '/workspace/assets/take.mp4', trusted: true },
        }),
      );

      const audBtn = withSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="audio"] [data-message-media-failed]');
      expect(audBtn).not.toBeNull();
      // Right-clicking AudioAttachment raises the unified file context menu.
      act(() => {
        audBtn!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
      });
      const audioMenu = document.body.querySelector('[data-file-link-menu]');
      expect(audioMenu).not.toBeNull();
      expect(audioMenu?.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      act(() => { audBtn?.click(); });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'audio',
          fileId: 'blob-aud-src',
          sourceId,
          path: undefined,
          origin: { path: '/workspace/assets/note.wav', trusted: true },
        }),
      );

      previewProbe.openAttachment.mockClear();
      const withoutSourceContainer = draw(message({
        attachments: [fileWithoutSource, imageWithoutSource, videoWithoutSource, audioWithoutSource],
      }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const uploadCard = withoutSourceContainer.querySelector<HTMLElement>('[data-message-attachment="blob-file-upload"]');
      expect(uploadCard?.innerHTML).not.toContain('f_upload_0001');
      expect(uploadCard?.querySelector<HTMLElement>('span[title]')?.getAttribute('title')).toBe('upload.pdf');

      act(() => {
        withoutSourceContainer.querySelector<HTMLButtonElement>('[data-message-attachment="blob-file-upload"] [data-message-attachment-open]')?.click();
      });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'file', fileId: 'blob-file-upload', sourceId: undefined, origin: undefined }),
      );

      act(() => {
        withoutSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="image"] button')?.click();
      });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'image', fileId: 'blob-img-nosrc', sourceId: undefined, origin: undefined }),
        'main',
      );

      act(() => {
        withoutSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="video"] button')?.click();
      });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'video', fileId: 'blob-vid-nosrc', sourceId: undefined, origin: undefined }),
      );

      act(() => {
        withoutSourceContainer.querySelector<HTMLButtonElement>('[data-message-media="audio"] [data-message-media-failed]')?.click();
      });
      expect(previewProbe.openAttachment).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'audio', fileId: 'blob-aud-nosrc', sourceId: undefined, origin: undefined }),
      );
    } finally {
      previewProbe.connection = null;
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it('gives legacy Office files (.doc, .xls, .ppt) honest badges distinct from OOXML', () => {
    const docAtt: MessageAttachment = {
      blobId: 'blob-doc',
      path: '/workspace/old.doc',
      title: 'old.doc',
      mimeType: 'application/msword',
      size: 4096,
      kind: 'file',
    };
    const xlsAtt: MessageAttachment = {
      blobId: 'blob-xls',
      path: '/workspace/old.xls',
      title: 'old.xls',
      mimeType: 'application/vnd.ms-excel',
      size: 4096,
      kind: 'file',
    };
    const pptAtt: MessageAttachment = {
      blobId: 'blob-ppt',
      path: '/workspace/old.ppt',
      title: 'old.ppt',
      mimeType: 'application/vnd.ms-powerpoint',
      size: 4096,
      kind: 'file',
    };
    expect(messageAttachmentSubtype(docAtt)).toBe('doc');
    expect(messageAttachmentSubtype(xlsAtt)).toBe('xls');
    expect(messageAttachmentSubtype(pptAtt)).toBe('ppt');

    const container = draw(message({ attachments: [docAtt, xlsAtt, pptAtt] }));
    const docCard = container.querySelector('[data-message-attachment="blob-doc"]');
    const xlsCard = container.querySelector('[data-message-attachment="blob-xls"]');
    const pptCard = container.querySelector('[data-message-attachment="blob-ppt"]');
    expect(docCard?.getAttribute('data-message-attachment-subtype')).toBe('doc');
    expect(docCard?.textContent).toContain('DOC');
    expect(docCard?.textContent).not.toContain('DOCX');
    expect(xlsCard?.getAttribute('data-message-attachment-subtype')).toBe('xls');
    expect(xlsCard?.textContent).toContain('XLS');
    expect(xlsCard?.textContent).not.toContain('XLSX');
    expect(pptCard?.getAttribute('data-message-attachment-subtype')).toBe('ppt');
    expect(pptCard?.textContent).toContain('PPT');
    expect(pptCard?.textContent).not.toContain('PPTX');
  });

  it('renders and opens web preview cards when a message URL contains malformed percent-encoded pathname sequences', () => {
    previewProbe.openWeb.mockClear();
    previewProbe.openUrl.mockClear();
    const container = draw(message({
      text: '参见 https://example.test/% 与 https://example.test/docs/%E0%A4 的说明。',
    }));

    const barePercentCard = container.querySelector<HTMLElement>('[data-message-web-preview="https://example.test/%"]');
    expect(barePercentCard).not.toBeNull();
    expect(barePercentCard?.textContent).toContain('example.test / %');
    const barePercentOpen = barePercentCard?.querySelector<HTMLButtonElement>('[data-message-web-open]');
    act(() => { barePercentOpen?.click(); });
    expect(previewProbe.openUrl).toHaveBeenCalledWith('https://example.test/%');

    const truncatedUtf8Card = container.querySelector<HTMLElement>('[data-message-web-preview="https://example.test/docs/%E0%A4"]');
    expect(truncatedUtf8Card).not.toBeNull();
    expect(truncatedUtf8Card?.textContent).toContain('example.test / docs/%E0%A4');
    const truncatedUtf8Preview = truncatedUtf8Card?.querySelector<HTMLButtonElement>('[data-message-web-preview-btn]');
    act(() => { truncatedUtf8Preview?.click(); });
    expect(previewProbe.openWeb).toHaveBeenCalledWith('https://example.test/docs/%E0%A4', 'example.test / docs/%E0%A4');

    // Right-clicking WebLinkPreviewCard opens the web-link context menu.
    act(() => {
      barePercentCard!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    });
    const linkMenu = document.body.querySelector('[data-web-link-menu]');
    expect(linkMenu).not.toBeNull();
    expect(linkMenu?.querySelector('[data-menu-item="open-in-browser"]')).not.toBeNull();
    expect(linkMenu?.querySelector('[data-menu-item="open-preview"]')).not.toBeNull();
    expect(linkMenu?.querySelector('[data-menu-item="copy-link"]')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
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
  it('shows a concise failure headline by default and expands the full error detail with copy on click', () => {
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
    expect(container.querySelector('[data-copy-state]')).toBeNull();

    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain(fullDetail);
    expect(container.querySelector('[data-copy-state]')).not.toBeNull();
  });

  it('localizes collapsed media_unsupported refusal while preserving the raw token and MIME in expanded detail', () => {
    const rawDetail = 'media_unsupported: No enabled channel supports video (video/mp4).';
    const container = draw(message({
      status: 'failed',
      text: '',
      deliveredTo: [],
      failureDetail: rawDetail,
    }));
    const toggle = container.querySelector<HTMLButtonElement>('[data-message-failure-detail]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('当前启用的信道不支持发送视频');
    expect(toggle.textContent).not.toContain('media_unsupported');

    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('media_unsupported');
    expect(toggle.textContent).toContain('video/mp4');
    expect(container.querySelector('[data-copy-state]')).not.toBeNull();
  });
});

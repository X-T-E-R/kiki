import { describe, expect, it } from 'vitest';

import {
  contentTextPresentation,
  projectPresentedText,
  readTextPresentation,
  shiftTextPresentation,
} from '#/contract/presentation';

describe('text presentation contract', () => {
  it('accepts valid generated spans and rejects malformed metadata', () => {
    const attachment = {
      path: 'C:/session/attachments/report.pdf',
      name: 'report.pdf',
      mime: 'application/pdf',
      size: 42,
    };
    const presentation = {
      spans: [{ start: 0, end: 12, kind: 'attachment' as const, attachment }],
    };
    expect(readTextPresentation(presentation)).toEqual(presentation);
    expect(readTextPresentation({ spans: [{ start: -1, end: 2, kind: 'context' }] })).toBeUndefined();
    expect(readTextPresentation({ spans: [{ start: 3, end: 2, kind: 'context' }] })).toBeUndefined();
    expect(readTextPresentation({ spans: [{ start: 0, end: 2, kind: 'unknown' }] })).toBeUndefined();
  });

  it('merges reference context and a trailing attachment notice with exact offsets', () => {
    const prompt = 'See /s/session_example';
    const referenceContext = `${prompt}\n\n<thread_refs>\n<thread_ref id="session_example"/>\n</thread_refs>`;
    const notice = 'Attached file "report.pdf" (application/pdf, 42 bytes): C:/session/report.pdf — open it with the Read tool';
    const attachment = {
      path: 'C:/session/report.pdf',
      name: 'report.pdf',
      mime: 'application/pdf',
      size: 42,
    };
    const merged = contentTextPresentation([
      {
        type: 'text',
        text: referenceContext,
        presentation: { spans: [{ start: prompt.length, end: referenceContext.length, kind: 'context' as const }] },
      },
      {
        type: 'text',
        text: notice,
        presentation: { spans: [{ start: 0, end: notice.length, kind: 'attachment' as const, attachment }] },
      },
    ], '\n');
    expect(merged).toEqual({
      spans: [
        { start: prompt.length, end: referenceContext.length, kind: 'context' },
        { start: referenceContext.length + 1, end: referenceContext.length + 1 + notice.length, kind: 'attachment', attachment },
      ],
    });
    expect(projectPresentedText(`${referenceContext}\n${notice}`, merged)).toBe(`${prompt}\n`);
  });

  it('merges prompt and steer text parts while ignoring non-text parts', () => {
    const presentation = contentTextPresentation([
      { type: 'text', text: 'prompt', presentation: { spans: [{ start: 1, end: 4, kind: 'selection' as const, quote: 'rom' }] } },
      { type: 'image', source: { kind: 'session_media', file_id: 'image-1' } },
      { type: 'text', text: 'steer', presentation: { spans: [{ start: 0, end: 5, kind: 'selection' as const, quote: 'steer' }] } },
      { type: 'text', text: 'tail', presentation: { spans: [{ start: 2, end: 4, kind: 'source' as const, quote: 'il' }] } },
    ], '\n');
    expect(presentation).toEqual({
      spans: [
        { start: 1, end: 4, kind: 'selection', quote: 'rom' },
        { start: 7, end: 12, kind: 'selection', quote: 'steer' },
        { start: 15, end: 17, kind: 'source', quote: 'il' },
      ],
    });
  });

  it('shifts every span without changing its metadata', () => {
    const presentation = { spans: [{ start: 2, end: 5, kind: 'selection' as const, quote: 'abc' }] };
    expect(shiftTextPresentation(presentation, 7)).toEqual({
      spans: [{ start: 9, end: 12, kind: 'selection', quote: 'abc' }],
    });
    expect(shiftTextPresentation(undefined, 7)).toBeUndefined();
  });

  it('projects a partial text window by global offset and leaves raw text unchanged without spans', () => {
    expect(projectPresentedText('45678', { spans: [{ start: 2, end: 6, kind: 'context' }] }, 4)).toBe('678');
    const raw = '> user quote\n\n<thread_refs>literal</thread_refs>\n<custom-tag>keep</custom-tag>';
    expect(projectPresentedText(raw)).toBe(raw);
    expect(projectPresentedText(raw, { spans: [] })).toBe(raw);
  });
});

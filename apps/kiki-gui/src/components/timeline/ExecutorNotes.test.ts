// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ExecutorNoteRow, executorDisplayName, parseUnifiedDiff } from './ExecutorNotes';

describe('parseUnifiedDiff', () => {
  it('splits files and numbers lines from the hunk headers', () => {
    const files = parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,2 +3,2 @@', ' keep', '-old', '+new',
      'diff --git a/b.ts b/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/b.ts', '@@ -0,0 +1,1 @@', '+hello',
    ].join('\n'));
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'b.ts']);
    expect(files[0]!.hunks[0]).toEqual([
      { lo: 3, ln: 3, tag: 'equal', text: 'keep' },
      { lo: 4, ln: 0, tag: 'delete', text: 'old' },
      { lo: 0, ln: 4, tag: 'insert', text: 'new' },
    ]);
    expect(files[1]!.hunks[0]).toEqual([{ lo: 0, ln: 1, tag: 'insert', text: 'hello' }]);
  });

  it('returns nothing for text without hunks', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('no changes')).toEqual([]);
  });
});

describe('executorDisplayName', () => {
  it('names known engines and capitalizes the rest', () => {
    expect(executorDisplayName('codex-app-server')).toBe('Codex');
    expect(executorDisplayName('grok')).toBe('Grok');
  });
});

describe('unknown executor updates', () => {
  it('names the actual type and opens saved diagnostics while legacy records do not invent payloads', () => {
    localStorage.setItem('kiki.locale', 'zh');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(I18nProvider, null, createElement(ExecutorNoteRow, { note: {
        kind: 'unknown', updateType: 'future_update', method: '_x.ai/session_notification', payload: { facts: { count: 1 } },
      } }))));
      expect(container.textContent).toContain('未识别的引擎更新');
      expect(container.textContent).toContain('future_update');
      expect(container.querySelector('[data-executor-update-payload]')).toBeNull();
      act(() => container.querySelector('button')!.click());
      expect(container.querySelector('[data-executor-update-payload]')?.textContent).toContain('"count": 1');
      expect(container.textContent).toContain('_x.ai/session_notification');
      act(() => root.render(createElement(I18nProvider, null, createElement(ExecutorNoteRow, { note: {
        kind: 'unknown', updateType: 'tool_call_delta_chunk',
      } }))));
      expect(container.textContent).toContain('tool_call_delta_chunk');
      expect(container.querySelector('button')).toBeNull();
      expect(container.querySelector('[data-executor-update-payload]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      localStorage.removeItem('kiki.locale');
    }
  });
});

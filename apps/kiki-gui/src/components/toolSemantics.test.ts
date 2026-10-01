import { describe, expect, it } from 'vitest';
import { translate, translatePlural } from '@kiki/session-core/i18n';
import type { ToolBlock } from '@kiki/session-core/session';

import { describeTool, type SemanticContext } from './toolSemantics';

const context: SemanticContext = {
  locale: 'en',
  t: (key, params) => translate('en', key, params),
  tp: (key, count, params) => translatePlural('en', key, count, params),
  threadTitle: () => undefined,
};
const tool = (name: string, output: unknown, args: unknown = {}): ToolBlock => ({
  kind: 'tool', id: 'tool-example', toolCallId: 'call-example', name, args, argsText: JSON.stringify(args),
  output, status: 'done', display: undefined, description: undefined, isError: false,
  durationMs: undefined, progressText: undefined,
});
const semantics = (name: string, output: unknown, args: unknown = {}) => describeTool(tool(name, output, args), context)!;
const native = (value: unknown) => JSON.stringify(value, null, 2);

const document = { url: 'https://example.com/source', final_url: 'https://example.com/article', title: 'Article',
  content: '# Article\nUseful body\n' + 'detail\n'.repeat(20) + 'article tail', content_type: 'text/html',
  media_type: 'text/markdown', truncated: false, warnings: [], source_lane: 'jina.reader' };
const result = { title: 'Search hit', url: 'https://example.com/result', snippet: 'Useful snippet', site_name: 'Example' };

describe('network tool previews', () => {
  it.each([
    ['current compact', 'The returned content is the main text extracted from the page. Cite it.\n\n# Article\nUseful body'],
    ['old compact', 'Fetched https://example.com/article. Cite it.\n\n# Article\nUseful body'],
  ])('reads %s fetch text and keeps the source and completeness note', (_label, output) => {
    const view = semantics('FetchURL', output, { url: 'https://example.com/article' });
    expect(view.preview).toContain('Useful body');
    expect(view.fields?.map((field) => field.value).join(' ')).toContain('https://example.com/article');
    expect(view.fields?.find((field) => field.label === 'Completeness')?.value).toContain('Cite it');
  });

  it('extracts fetch content from a native pretty-printed JSON envelope without physical blank lines', () => {
    const output = native({ schema_version: 1, mode: 'fetch', action: 'run', execution: 'sync', status: 'succeeded', documents: [document], hints: [] });
    expect(output).not.toContain('\n\n');
    const view = semantics('FetchURL', output);
    expect(view.object).toBe(document.final_url);
    expect(view.preview).toContain('Useful body');
    expect(view.preview).not.toContain('article tail');
    expect(view.previewFull).toBe(document.content);
    expect(view.fields?.map((field) => field.value)).toContain('text/html');
  });

  it.each(['partial', 'succeeded'])('preserves warnings and payload truncation for %s fetch', (status) => {
    const view = semantics('FetchURL', native({ action: 'run', status, documents: [{ ...document, truncated: true,
      warnings: [{ code: 'CONTENT_LIMIT', message: 'Source text was limited' }] }], hints: [{ code: 'FALLBACK', message: 'Fallback provider used' }] }));
    expect(view.preview).toContain('Useful body');
    expect(view.fields?.find((field) => field.label === 'Completeness')?.value).toContain('truncated or incomplete');
    expect(view.previewNotice).toContain('Source text was limited');
    expect(view.previewNotice).toContain('Fallback provider used');
  });

  it('does not label a warning-only fetch as verified complete', () => {
    const view = semantics('FetchURL', native({ action: 'run', status: 'succeeded', documents: [{ ...document, warnings: [{ message: 'Extraction warning' }] }] }));
    expect(view.fields?.find((field) => field.label === 'Completeness')?.value).toContain('not guaranteed');
  });

  it.each([native({ action: 'run', status: 'succeeded', output: { channel: 'results', results: [result] } }),
    { action: 'run', status: 'succeeded', output: { channel: 'results', results: [result] } },
    'Title: Search hit\nSite: Example\nURL: https://example.com/result\nSnippet: Useful snippet\n\n'])('reads ranked results in native or legacy output', (output) => {
    const view = semantics('WebSearch', output, { query: 'example query' });
    expect(view.count).toBe('1 result');
    expect(view.items?.[0]?.primary).toBe('Search hit');
    expect(view.items?.[0]?.secondary).toBe('Useful snippet');
    expect(view.items?.[0]?.link?.kind).toBe('external');
  });

  it.each([
    native({ action: 'run', status: 'succeeded', output: { channel: 'typed', schema_id: 'nb-search.docs-context@1',
      data: { answer: 'Typed answer with useful detail', sources: [result] } } }),
    'Schema: nb-search.docs-context@1\nSource lane: context7.docs\nSources:\n- Search hit: https://example.com/result\n\nContent:\nTyped answer with useful detail\n',
  ])('shows typed answer and source instead of zero ranked results', (output) => {
    const view = semantics('WebSearch', output);
    expect(view.count).toBeUndefined();
    expect(view.preview).toContain('Typed answer with useful detail');
    expect(view.items?.[0]?.link?.kind).toBe('external');
  });

  it('shows typed structured data when no answer text exists', () => {
    const view = semantics('WebSearch', native({ output: { channel: 'typed', schema_id: 'nb-search.research@1', data: { findings: ['Evidence'] } } }));
    expect(view.preview).toContain('Evidence');
    expect(view.count).toBeUndefined();
  });

  it.each(['WebSearch', 'FetchURL'])('%s previews async receipts and get/read/cancel as jobs', (name) => {
    const queued = semantics(name, native({ action: 'run', execution: 'async', status: 'queued', job: { job_id: 'job-example', state: 'queued' }, poll_after_ms: 1000 }));
    expect(queued.object).toBe('job-example');
    expect(queued.state?.text).toBe('Queued');
    expect(queued.fields?.some((field) => field.value === '1000')).toBe(true);
    for (const action of ['get', 'cancel']) {
      const view = semantics(name, native({ action, job_id: 'job-example', state: 'running', cancel_requested: action === 'cancel' }), { action, job_id: 'job-example' });
      expect(view.object).toBe('job-example');
      expect(view.state?.text).toBe('Running');
      expect(view.fields?.find((field) => field.label === 'Cancellation requested')?.value).toBe(action === 'cancel' ? 'Yes' : 'No');
      expect(view.count).toBeUndefined();
      if (name === 'FetchURL') expect(view.verb).not.toBe('Fetch page');
    }
    const read = semantics(name, native({ action: 'read', job_id: 'job-example', state: 'succeeded', artifact: { media_type: 'application/json', byte_length: 900 },
      chunks: [{ index: 0, offset: 0, byte_length: 10, data_base64: 'eyJ0ZXh0Ijoi' }], next_cursor: 'cursor-example' }), { action: 'read' });
    expect(read.preview).toContain('offset 0');
    expect(read.previewNotice).toContain('not a reconstructed full document');
    expect(read.previewNotice).toContain('not loaded');
    expect(read.count).toBeUndefined();
  });

  it.each(['WebSearch', 'FetchURL'])('%s gives readable fallback for unknown text, JSON and streamed partial JSON', (name) => {
    for (const output of ['Unrecognized but useful output', native({ future_shape: { content: 'Unrecognized but useful output' } }), '{"documents": [{"content":"Unrecognized but useful output']) {
      const view = semantics(name, output);
      expect(view.previewNotice).toBe('Preview unavailable');
      expect(view.preview).toContain('Unrecognized but useful output');
      expect(view.count).toBeUndefined();
    }
  });

  it('preserves partial search results, warnings and the reported outcome', () => {
    const view = semantics('WebSearch', native({ action: 'run', status: 'partial', output: { channel: 'results', results: [result],
      hints: [{ code: 'LANE_FAILED', message: 'One lane failed' }] }, hints: [] }));
    expect(view.count).toBe('1 result');
    expect(view.state?.text).toBe('Partial');
    expect(view.previewNotice).toContain('One lane failed');
  });

  it.each(['WebSearch', 'FetchURL'])('%s never calls unknown or contradictory content empty', (name) => {
    const outputs = [native({ status: 'empty', future_content: 'Evidence found' }),
      name === 'FetchURL' ? native({ status: 'empty', documents: [{ future_body: 'Evidence found' }] })
        : native({ status: 'empty', output: { results: [{ future_body: 'Evidence found' }] } })];
    for (const output of outputs) {
      const view = semantics(name, output);
      expect(view.count).toBeUndefined();
      expect(view.state?.text).not.toBe('Empty');
      expect(view.previewNotice).toBe('Preview unavailable');
      expect(view.preview).toContain('Evidence found');
    }
  });

  it('does not infer zero from malformed results', () => {
    const view = semantics('WebSearch', native({ status: 'succeeded', output: { results: [{ future_url: 'https://example.com/result', body: 'Evidence found' }] } }));
    expect(view.count).toBeUndefined();
    expect(view.previewNotice).toBe('Preview unavailable');
    expect(view.preview).toContain('Evidence found');
  });

  it.each(['No search results found.', native({ action: 'run', status: 'empty', output: { channel: 'results', results: [] } })])('only counts known empty search output as zero', (output) => {
    expect(semantics('WebSearch', output).count).toBe('0 results');
  });
});

describe('TodoList working note previews', () => {
  it.each([
    ['goal', 'Goal'], ['directives', 'User instructions'], ['decided', 'Decided'], ['rejected', 'Ruled out'],
    ['evidence', 'Evidence'], ['files', 'Files'], ['next', 'Next'], ['open', 'Open questions'],
  ])('previews a %s-only update without needing tool output', (section, label) => {
    const view = semantics('TodoList', undefined, { notes: { [section]: 'Useful\n  section content' } });
    expect(view.verb).toBe('Update notes');
    expect(view.note).toBe(label);
    expect(view.fields).toEqual([{ label, value: 'Useful section content' }]);
    expect(view.previewNotice).toBeUndefined();
  });

  it('previews todos and only the supplied note sections together', () => {
    const view = semantics('TodoList', 'Todo list updated', {
      todos: [{ title: 'Run tests', status: 'in_progress' }, { title: 'Read code', status: 'done' }],
      notes: { next: 'Run targeted tests', goal: 'Ship feature' },
    });
    expect(view.verb).toBe('Update todos');
    expect(view.object).toBe('Run tests');
    expect(view.count).toBe('1/2');
    expect(view.items).toHaveLength(2);
    expect(view.note).toBe('Goal · Next');
    expect(view.fields).toEqual([{ label: 'Goal', value: 'Ship feature' }, { label: 'Next', value: 'Run targeted tests' }]);
  });

  it.each([{}, { notes: {} }, { notes: { future: 'Unknown section', goal: undefined } }])('does not invent a notes update from %j', (args) => {
    const view = semantics('TodoList', '', args);
    expect(view.verb).toBe('Read todos');
    expect(view.note).toBeUndefined();
    expect(view.fields).toBeUndefined();
    expect(view.previewNotice).toBeUndefined();
  });

  it('keeps an empty notes patch quiet alongside a todo update', () => {
    const view = semantics('TodoList', '', { todos: [], notes: {} });
    expect(view.verb).toBe('Clear todos');
    expect(view.note).toBeUndefined();
    expect(view.fields).toBeUndefined();
  });

  it.each(['', '   \n'])('shows section deletion for empty text %j', (value) => {
    expect(semantics('TodoList', '', { notes: { open: value } }).fields).toEqual([{ label: 'Open questions', value: 'Cleared' }]);
  });

  it('distinguishes clearing all notes from an empty patch', () => {
    const view = semantics('TodoList', '', { notes: null });
    expect(view.verb).toBe('Update notes');
    expect(view.fields).toEqual([{ label: 'Working notes', value: 'Cleared' }]);
  });

  it('marks display truncation and leaves the complete payload for Raw, without a third preview level', () => {
    const args = { notes: { goal: 'g'.repeat(161), next: 'n'.repeat(160) } };
    const block = tool('TodoList', 'Updated', args);
    const view = describeTool(block, context)!;
    expect(view.fields?.[0]?.value).toBe(`${'g'.repeat(159)}…`);
    expect(view.fields?.[1]?.value).toBe('n'.repeat(160));
    expect(view.previewNotice).toBe('Note summaries are shortened; open Raw for full content');
    expect(view.previewFull).toBeUndefined();
    expect(block.args).toEqual(args);
    expect(block.argsText).toBe(JSON.stringify(args));
  });

  it('localizes section labels, deletion and truncation notices', () => {
    const zhContext: SemanticContext = { ...context, locale: 'zh',
      t: (key, params) => translate('zh', key, params), tp: (key, count, params) => translatePlural('zh', key, count, params) };
    const view = describeTool(tool('TodoList', '', { notes: { goal: '中'.repeat(161), next: '' } }), zhContext)!;
    expect(view.verb).toBe('更新笔记');
    expect(view.note).toBe('目标 · 下一步');
    expect(view.fields?.[1]?.value).toBe('已清除');
    expect(view.previewNotice).toContain('原始数据');
  });
});

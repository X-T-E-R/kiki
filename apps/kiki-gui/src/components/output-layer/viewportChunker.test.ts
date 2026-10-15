import { describe, expect, it } from 'vitest';
import { chunkText, DEFAULT_CHUNK_SIZE } from './viewportChunker';

describe('viewportChunker', () => {
  it('returns empty array for empty or whitespace text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk when text is shorter than targetSize', () => {
    const text = '短文本测试，不会触发切分。';
    const chunks = chunkText(text, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      index: 0,
      start: 0,
      end: text.length,
      text,
    });
  });

  it('splits on paragraph boundaries (\n\n)', () => {
    const p1 = '这是第一段文字，内容比较长，提供了足够的内容来接近切分阈值。'.repeat(3);
    const p2 = '这是第二段文字，紧跟在双换行后面，应该作为一个独立或者新的起点。'.repeat(3);
    const full = `${p1}\n\n${p2}`;

    const chunks = chunkText(full, 70);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Combined text matches original text exactly
    expect(chunks.map((c) => c.text).join('')).toBe(full);
  });

  it('splits on sentence punctuation (。！？)', () => {
    const s1 = '第一句内容很长很有道理。';
    const s2 = '第二句内容也是一段很有意思的见解！';
    const s3 = '第三句是一个疑问句吗？';
    const full = `${s1}${s2}${s3}`;

    const chunks = chunkText(full, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.text).join('')).toBe(full);
    // First chunk ends with sentence punctuation
    expect(chunks[0]!.text.endsWith('。')).toBe(true);
  });

  it('splits English sentences with punctuation and space', () => {
    const s1 = 'This is the first sentence with some meaningful words. ';
    const s2 = 'And this is the second sentence that follows right after it. ';
    const s3 = 'Finally here is the third sentence for testing.';
    const full = `${s1}${s2}${s3}`;

    const chunks = chunkText(full, 45);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.text).join('')).toBe(full);
  });

  it('handles very long string without natural punctuation gracefully', () => {
    const longWord = 'A'.repeat(1500);
    const chunks = chunkText(longWord, 500);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.text).join('')).toBe(longWord);
  });

  it('scans code fences accurately with findCodeFences', () => {
    const text = 'Intro\n\n```ts\nconst x = 1;\n```\n\nOutro\n\n~~~python\nprint(1)\n~~~';
    const chunks = chunkText(text, 600);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
  });

  it('does not cut inside code fences when approaching targetSize', () => {
    const codeAnswer = [
      '逐项给结论。先看投影层的核心段落:',
      '',
      '```ts',
      'export function groupHistoryRuns(nodes, isCompact) {',
      '  const out = [];',
      '  let run = [];',
      '  const flush = () => {',
      '    if (run.length >= 2) out.push({ kind: "history-run", id: `history-run-${run[0].id}`, nodes: run });',
      '    else out.push(...run);',
      '    run = [];',
      '  };',
      '  for (const node of nodes) {',
      '    if (isCompact(node)) { run.push(node); continue; }',
      '    flush();',
      '    out.push(node);',
      '  }',
      '  flush();',
      '  return out;',
      '}',
      '```',
      '',
      '要点:连续的紧凑节点折叠成一条摘要行;任何非紧凑节点(用户消息、待决交互、失败项)都会断开分组,所以折叠永远不会跨过你的发言,也不会吞掉失败。',
      '',
      '计数权威链的修正:',
      '',
      '```ts',
      'export function resolveSubagentToolCalls(block, node) {',
      '  if (node?.toolCallCountKnown === true) return { count: node.toolCallCount, known: true };',
      '  if (node?.toolCallCountKnown === false) return { count: node.toolCallCount, known: false };',
      '  // …块声明兜底,都没有则兼容旧数据',
      '}',
      '```',
      '',
      '森林节点每次子代理更新都会重投影,可能把计数向下修正;父时间线的块只保留投影时的快照,不会被重投。所以节点声明必须赢过块。',
    ].join('\n');

    const chunks = chunkText(codeAnswer, 600);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Byte and Unicode preservation
    expect(chunks.map((c) => c.text).join('')).toBe(codeAnswer);

    // Each chunk containing a code fence must not have torn fences
    for (const chunk of chunks) {
      const openTicks = (chunk.text.match(/^```/gm) || []).length;
      expect(openTicks % 2).toBe(0);
    }
  });

  it('preserves long closed code blocks intact without tearing inside the code block', () => {
    const longCodeLines = Array.from({ length: 40 }, (_, i) => `  const value_${i} = computeStep(${i});`).join('\n');
    const full = '```typescript\n' + longCodeLines + '\n```';
    const chunks = chunkText(full, 300);

    // Kept as a single intact chunk without splitting inside the fence
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(full);
  });

  it('keeps pre-fence text and long closed fence separate while preserving exact bytes and Unicode', () => {
    const intro = '这是引言段落，提供了关于实现的总体描述。\n\n';
    const longCodeLines = Array.from({ length: 30 }, (_, i) => `  const step_${i} = doWork(${i});`).join('\n');
    const codeBlock = '```typescript\n' + longCodeLines + '\n```\n\n';
    const outro = '这是总结段落，包含 Unicode 字符与标点符号。';
    const full = intro + codeBlock + outro;

    const chunks = chunkText(full, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // 100% byte and Unicode preservation
    expect(chunks.map((c) => c.text).join('')).toBe(full);
    const codeChunk = chunks.find((c) => c.text.includes('typescript'));
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.text.trim().startsWith('```typescript')).toBe(true);
    expect(codeChunk!.text.trim().endsWith('```')).toBe(true);
  });

  it('isolates unclosed code fence at streaming tail into the last chunk', () => {
    const intro = '正在思考中，这是第一段稳定的说明文本，包含详细解释和背景信息。'.repeat(3) + '\n\n';
    const streamingTail = '```typescript\nconst a = 1;\nconst b = 2;';
    const full = intro + streamingTail;

    const chunks = chunkText(full, 60);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.text).join('')).toBe(full);
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.text).toBe(streamingTail);
    expect(chunks[0]!.text.includes('```')).toBe(false);
  });
});

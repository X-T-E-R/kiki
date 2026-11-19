import { describe, expect, it } from 'vitest';

import {
  FrontmatterError,
  parseFrontmatter,
  replaceFrontmatterBody,
  updateFrontmatterField,
} from '#/_base/text/frontmatter';

describe('parseFrontmatter', () => {
  it('parses yaml frontmatter and body', () => {
    const { data, body } = parseFrontmatter('---\nname: foo\n---\nbody text');
    expect(data).toEqual({ name: 'foo' });
    expect(body).toBe('body text');
  });

  it('returns null data when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just body');
    expect(data).toBeNull();
    expect(body).toBe('just body');
  });

  it('throws when the closing fence is missing', () => {
    expect(() => parseFrontmatter('---\nname: foo')).toThrow(FrontmatterError);
  });
});

describe('updateFrontmatterField', () => {
  it('preserves comments, formatting, CRLF, and body on in-place scalar and nested edits', () => {
    const input = [
      '---',
      '# 顶部注释',
      'name: reviewer',
      '# 描述注释',
      'description: Old description # 行尾注释',
      'tools: [Read, Bash]',
      '---',
      '',
      'Prompt body.',
      '',
    ].join('\r\n');
    const updated = updateFrontmatterField(input, 'description', 'New description');
    expect(updated).toContain('# 顶部注释\r\n');
    expect(updated).toContain('# 描述注释\r\n');
    expect(updated).toContain('description: New description # 行尾注释\r\n');
    expect(updated).toContain('tools: [Read, Bash]\r\n');
    expect(updated.endsWith('\r\n\r\nPrompt body.\r\n')).toBe(true);
  });

  it('handles tab characters after opening and closing fences without regex escaping bugs', () => {
    const input = '---\t\nname: tab-agent\ndescription: Old\n---\t\nBody.\n';
    const updated = updateFrontmatterField(input, 'description', 'Fixed');
    expect(parseFrontmatter(updated)).toEqual({
      data: { name: 'tab-agent', description: 'Fixed' },
      body: 'Body.\n',
    });
  });

  it('updates multiline block scalars containing colon lines without corrupting neighboring keys', () => {
    const input = [
      '---',
      'name: block-agent',
      'description: |',
      '  line one',
      '  looks_like_key: value inside scalar',
      '# keep comment',
      'main: true',
      '---',
      'Body.',
      '',
    ].join('\n');
    const updated = updateFrontmatterField(input, 'description', 'Replaced');
    expect(updated).toContain('# keep comment\nmain: true\n');
    expect(parseFrontmatter(updated).data).toEqual({
      name: 'block-agent',
      description: 'Replaced',
      main: true,
    });
  });

  it('serializes nested objects and arrays as block YAML instead of flattened JSON', () => {
    const input = '---\nname: structured\n---\nBody.\n';
    const updated = updateFrontmatterField(input, 'spawn_constraints', {
      allowed_models: ['provider/a', 'provider/b'],
      disallowed_tools: ['Bash'],
    });
    expect(updated).toContain('spawn_constraints:\n  allowed_models:\n    - provider/a\n    - provider/b\n');
    expect(updated).not.toContain('{"allowed_models"');
  });

  it('replaces prompt body while preserving frontmatter comments verbatim', () => {
    const input = '---\n# keep\nname: body-agent\n---\nOld body.\n';
    const updated = replaceFrontmatterBody(input, 'New body.');
    expect(updated).toBe('---\n# keep\nname: body-agent\n---\n\nNew body.\n');
  });
});

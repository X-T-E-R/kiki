import { type Document, isMap, parseDocument } from 'yaml';

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrontmatterError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export interface ParsedFrontmatter {
  readonly data: unknown;
  readonly body: string;
}

export interface FrontmatterBlock {
  readonly prefix: string;
  readonly yamlRaw: string;
  readonly suffix: string;
  readonly body: string;
  readonly eol: '\n' | '\r\n';
}

export type FrontmatterFieldValue =
  | string
  | number
  | boolean
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | null;

const FENCE = '---';
const OPENING_FENCE_PATTERN = /^(\uFEFF?---[ \t]*(?:\r\n|\n))/;
const CLOSING_FENCE_PATTERN = /^---[ \t]*$/;

export function locateFrontmatterBlock(text: string): FrontmatterBlock | undefined {
  const opening = OPENING_FENCE_PATTERN.exec(text);
  if (opening === null) return undefined;
  const prefix = opening[1]!;
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  let cursor = prefix.length;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = lineEnd > cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    if (CLOSING_FENCE_PATTERN.test(text.slice(cursor, contentEnd))) {
      const suffixEnd = newline === -1 ? text.length : newline + 1;
      return {
        prefix,
        yamlRaw: text.slice(prefix.length, cursor),
        suffix: text.slice(cursor, suffixEnd),
        body: text.slice(suffixEnd),
        eol,
      };
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  throw new FrontmatterError('Missing closing frontmatter fence');
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== FENCE) {
    return { data: null, body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    throw new FrontmatterError('Missing closing frontmatter fence');
  }

  const yamlText = lines.slice(1, close).join('\n').trim();
  const body = lines.slice(close + 1).join('\n');
  if (yamlText === '') {
    return { data: {}, body };
  }

  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) {
      throw new FrontmatterError('Invalid YAML frontmatter');
    }
    return { data: doc.toJS() ?? {}, body };
  } catch (error) {
    if (error instanceof FrontmatterError) throw error;
    throw new FrontmatterError('Invalid YAML frontmatter');
  }
}

export function updateFrontmatterField(
  text: string,
  key: string,
  value: FrontmatterFieldValue,
): string {
  const block = locateFrontmatterBlock(text);
  if (block === undefined) {
    throw new FrontmatterError('Missing opening frontmatter fence');
  }

  let doc: Document;
  try {
    doc = parseDocument(block.yamlRaw);
  } catch {
    throw new FrontmatterError('Invalid YAML frontmatter');
  }
  if (doc.errors.length > 0) {
    throw new FrontmatterError('Invalid YAML frontmatter');
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new FrontmatterError('Frontmatter must be a YAML mapping');
  }

  if (value === null) {
    if (doc.contents === null || !doc.has(key)) return text;
    doc.delete(key);
  } else {
    if (doc.contents === null) {
      doc.contents = doc.createNode({});
    }
    doc.set(key, value);
  }

  let renderedYaml: string;
  if (doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)) {
    renderedYaml = '';
  } else {
    renderedYaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
    if (block.eol === '\r\n') {
      renderedYaml = renderedYaml.replaceAll('\n', '\r\n');
    }
  }
  return `${block.prefix}${renderedYaml}${block.suffix}${block.body}`;
}

export function replaceFrontmatterBody(text: string, prompt: string): string {
  const block = locateFrontmatterBlock(text);
  if (block === undefined) {
    throw new FrontmatterError('Missing opening frontmatter fence');
  }
  const closing = block.suffix.endsWith('\n') ? block.suffix : `${block.suffix}${block.eol}`;
  return `${block.prefix}${block.yamlRaw}${closing}${block.eol}${prompt.trim()}${block.eol}`;
}

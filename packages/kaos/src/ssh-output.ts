import { Transform, type TransformCallback } from 'node:stream';

function decode(bytes: Buffer, codePage: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(codePage === 936 ? 'gbk' : `windows-${codePage}`).decode(bytes);
  }
}

function xmlText(value: string): string {
  return value.replaceAll(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
    return named[entity] ?? String.fromCodePoint(entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10));
  }).replaceAll(/_x([\da-f]{4})_/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

export class SshWindowsOutput extends Transform {
  private pending = Buffer.alloc(0);
  private clixml = false;
  private xml = '';

  constructor(private readonly codePage = 936) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) >= 0) {
      const line = this.pending.subarray(0, newline + 1);
      this.pending = this.pending.subarray(newline + 1);
      this.emitText(decode(line, this.codePage));
    }
    if (this.pending.length > 64 * 1024 && !this.clixml) {
      let end = this.pending.length - 4;
      while (end > 0 && (this.pending[end]! & 0xc0) === 0x80) end--;
      this.emitText(decode(this.pending.subarray(0, end), this.codePage));
      this.pending = this.pending.subarray(end);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.pending.length > 0) this.emitText(decode(this.pending, this.codePage));
    if (this.xml !== '') this.emitXml();
    this.pending = Buffer.alloc(0);
    callback();
  }

  private emitText(text: string): void {
    if (text.trim() === '#< CLIXML') { this.clixml = true; return; }
    if (!this.clixml) { this.push(Buffer.from(text, 'utf8')); return; }
    if (this.xml === '' && !text.trimStart().startsWith('<Objs')) {
      this.push(Buffer.from(text, 'utf8'));
      return;
    }
    this.xml += text;
    const end = this.xml.indexOf('</Objs>');
    if (end >= 0) {
      const tail = this.xml.slice(end + 7);
      this.xml = this.xml.slice(0, end + 7);
      this.emitXml();
      this.clixml = false;
      if (tail.trim() !== '') this.emitText(tail);
    }
  }

  private emitXml(): void {
    const strings = this.xml.matchAll(/<S\b[^>]*\bS=["'](?:Error|Warning|Verbose|Debug|Information|Output)["'][^>]*>([\s\S]*?)<\/S>/g);
    for (const match of strings) this.push(Buffer.from(xmlText(match[1]!), 'utf8'));
    this.xml = '';
  }
}

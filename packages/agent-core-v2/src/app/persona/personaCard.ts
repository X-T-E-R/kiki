import { ZipFile } from 'yazl';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import type { PersonaDefinition } from '@kiki/agent-profiles/personaFile';

import type {
  PersonaAvatar,
  PersonaAvatarInput,
  PersonaCardFormat,
  PersonaExport,
  PersonaImportInput,
  PersonaMemoryImportEntry,
} from './personaStore';

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const EMPTY_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const MAX_CHARX_BYTES = 16 * 1024 * 1024;
const MAX_CHARX_ENTRIES = 128;
const MAX_CHARX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export interface PersonaCardAsset {
  readonly name: string;
  readonly data: Uint8Array;
}

interface ParsedCard {
  readonly definition: PersonaDefinition;
  readonly examples?: string;
  readonly avatar?: PersonaAvatarInput;
  readonly avatarMimeType?: PersonaAvatar['mimeType'];
  readonly memoryEntries: readonly PersonaMemoryImportEntry[];
  readonly ignoredFields: readonly string[];
  readonly extensions?: unknown;
  readonly assets?: readonly PersonaCardAsset[];
}

export async function parsePersonaCard(input: PersonaImportInput, id: string): Promise<ParsedCard> {
  const data = personaCardBytes(input.data);
  const format = detectCardFormat(data, input.format, input.filename);
  if (format === 'png') return parsePngCard(data, id);
  if (format === 'json') return parseJsonCard(data, id);
  return parseCharxCard(data, id);
}

export async function exportPersonaCard(
  format: PersonaCardFormat,
  definition: PersonaDefinition,
  examples: string | undefined,
  avatar: PersonaAvatar | undefined,
  extensions: unknown,
  memoryEntries: readonly PersonaMemoryImportEntry[] = [],
  assets: readonly PersonaCardAsset[] = [],
): Promise<PersonaExport> {
  const card = buildCard(definition, examples, avatar, extensions, memoryEntries);
  if (format === 'json') {
    return {
      format,
      extension: '.json',
      mimeType: 'application/json',
      data: new TextEncoder().encode(JSON.stringify(card, null, 2)),
    };
  }
  if (format === 'png') {
    const png = await avatarAsPng(avatar);
    return {
      format,
      extension: '.png',
      mimeType: 'image/png',
      data: appendPngText(png, 'chara', Buffer.from(JSON.stringify(card), 'utf8').toString('base64')),
    };
  }
  const entries: Array<{ readonly name: string; readonly data: Uint8Array }> = [
    { name: 'card.json', data: new TextEncoder().encode(JSON.stringify(card, null, 2)) },
  ];
  if (avatar !== undefined) entries.push({ name: `assets/avatar.${avatar.extension}`, data: avatar.data });
  for (const asset of assets) {
    if (asset.name === 'card.json' || asset.name.startsWith('assets/avatar.')) continue;
    entries.push({ name: asset.name, data: asset.data });
  }
  return {
    format,
    extension: '.charx',
    mimeType: 'application/zip',
    data: await makeZip(entries),
  };
}

export function detectCardFormat(
  data: Uint8Array,
  format: PersonaCardFormat | undefined,
  filename: string | undefined,
): PersonaCardFormat {
  if (format !== undefined) return format;
  const lower = filename?.toLowerCase() ?? '';
  if (lower.endsWith('.charx')) return 'charx';
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.json')) return 'json';
  if (isPng(data)) return 'png';
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) return 'charx';
  return 'json';
}

function parseJsonCard(bytes: Uint8Array, id: string): Promise<ParsedCard> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`Invalid character card JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return Promise.resolve(parseCardObject(value, id));
}

function parsePngCard(bytes: Uint8Array, id: string): Promise<ParsedCard> {
  if (!isPng(bytes)) throw new Error('Character card PNG has an invalid signature');
  const texts = readPngText(bytes);
  const encoded = texts.get('ccv3') ?? texts.get('chara') ?? texts.get('char');
  if (encoded === undefined) throw new Error('Character card PNG does not contain a chara or ccv3 text chunk');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`Character card PNG metadata is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = parseCardObject(value, id);
  return Promise.resolve({ ...parsed, avatar: { data: bytes, mimeType: 'image/png' }, avatarMimeType: 'image/png' });
}

async function parseCharxCard(bytes: Uint8Array, id: string): Promise<ParsedCard> {
  if (bytes.byteLength > MAX_CHARX_BYTES) throw new Error('Character card archive exceeds the size limit');
  const entries = await readZip(bytes);
  const cardEntry = [...entries.entries()].find(([name]) => isCardJsonName(name));
  if (cardEntry === undefined) throw new Error('Character card archive does not contain card.json');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(cardEntry[1]));
  } catch (error) {
    throw new Error(`Character card archive JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = parseCardObject(value, id);
  const asset = findArchiveAvatar(entries, value);
  const assets = [...entries.entries()]
    .filter(([name]) => !isCardJsonName(name) && name !== asset?.name)
    .map(([name, data]) => ({ name, data }));
  return {
    ...parsed,
    assets: assets.length === 0 ? undefined : assets,
    ...(asset === undefined ? {} : { avatar: { data: asset.data, mimeType: asset.mimeType }, avatarMimeType: asset.mimeType }),
  };
}

function parseCardObject(value: unknown, id: string): ParsedCard {
  if (!isRecord(value)) throw new Error('Character card must be a JSON object');
  const data = isRecord(value['data']) ? value['data'] : value;
  const name = stringValue(data['nickname']) ?? stringValue(data['name']);
  if (name === undefined) throw new Error('Character card is missing a name');
  const description = buildDescription(data);
  const definition: PersonaDefinition = {
    id,
    name,
    title: stringValue(data['title']),
    job: stringValue(data['job']),
    greeting: stringValue(data['first_mes']),
    greetings: stringList(data['alternate_greetings']),
    roomGreeting: firstString(data['group_only_greetings']),
    tags: stringList(data['tags']),
    notes: buildNotes(data),
    description,
  };
  const examples = stringValue(data['mes_example']);
  const memoryEntries = parseLorebook(data['character_book']);
  const ignoredFields = data['post_history_instructions'] === undefined ? [] : ['post_history_instructions'];
  const avatar = cardAsset(data['assets']);
  const result: ParsedCard = {
    definition: removeUndefined(definition),
    examples: examples === undefined ? undefined : examples.replaceAll('{{char}}', name).replaceAll('{{user}}', 'user'),
    avatar: avatar?.dataUri,
    avatarMimeType: avatar?.mimeType,
    memoryEntries,
    ignoredFields,
    extensions: data['extensions'],
  };
  return result;
}

function buildCard(
  definition: PersonaDefinition,
  examples: string | undefined,
  avatar: PersonaAvatar | undefined,
  extensions: unknown,
  memoryEntries: readonly PersonaMemoryImportEntry[],
): Record<string, unknown> {
  const sections = splitDescription(definition.description);
  const data: Record<string, unknown> = {
    name: definition.name,
    description: sections.description,
    personality: sections.personality,
    scenario: sections.scenario,
    system_prompt: sections.systemPrompt,
    first_mes: definition.greeting,
    alternate_greetings: definition.greetings,
    group_only_greetings: definition.roomGreeting === undefined ? undefined : [definition.roomGreeting],
    mes_example: examples?.replaceAll(definition.name, '{{char}}'),
    creator_notes: definition.notes,
    tags: definition.tags,
    character_book: memoryEntries.length === 0 ? undefined : {
      name: `${definition.name} lorebook`,
      entries: memoryEntries.map((entry) => ({
        comment: entry.title,
        content: entry.body,
        constant: entry.pinned,
        keys: [],
      })),
    },
    extensions,
  };
  if (avatar !== undefined) {
    data['assets'] = [{ type: 'icon', uri: `assets/avatar.${avatar.extension}` }];
  }
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: removeUndefined(data),
  };
}

function buildDescription(data: Record<string, unknown>): string {
  const sections: string[] = [];
  const description = stringValue(data['description']);
  const personality = stringValue(data['personality']);
  const scenario = stringValue(data['scenario']);
  const systemPrompt = stringValue(data['system_prompt']);
  if (description !== undefined && personality === undefined && scenario === undefined && systemPrompt === undefined) return description;
  if (description !== undefined) sections.push(`## 设定\n${description}`);
  if (personality !== undefined) sections.push(`## 性格\n${personality}`);
  if (scenario !== undefined) sections.push(`## 场景\n${scenario}`);
  if (systemPrompt !== undefined) sections.push(`## 扮演规则\n${systemPrompt}`);
  return sections.join('\n\n').trim() || 'You are a character.';
}

function splitDescription(description: string): {
  readonly description: string;
  readonly personality?: string;
  readonly scenario?: string;
  readonly systemPrompt?: string;
} {
  const sections = new Map<string, string>();
  const pattern = /^##[ \t]*(设定|性格|场景|扮演规则)[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]*(?:设定|性格|场景|扮演规则)[ \t]*\r?\n|(?![\s\S]))/gm;
  const matches = [...description.matchAll(pattern)];
  if (matches[0]?.index !== 0) return { description };
  for (const match of matches) sections.set(match[1]!, match[2]!.trim());
  if (sections.size === 0) return { description };
  return {
    description: sections.get('设定') ?? '',
    personality: sections.get('性格'),
    scenario: sections.get('场景'),
    systemPrompt: sections.get('扮演规则'),
  };
}

function buildNotes(data: Record<string, unknown>): string | undefined {
  const values = [stringValue(data['creator_notes']), stringValue(data['creator']), stringValue(data['character_version'])].filter(
    (value): value is string => value !== undefined,
  );
  return values.length === 0 ? undefined : values.join('\n');
}

function parseLorebook(value: unknown): readonly PersonaMemoryImportEntry[] {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return [];
  const entries: PersonaMemoryImportEntry[] = [];
  for (const item of value['entries']) {
    if (!isRecord(item)) continue;
    const body = stringValue(item['content']);
    if (body === undefined || body.trim() === '') continue;
    const keys = stringList(item['keys']) ?? [];
    entries.push({
      title: stringValue(item['comment']) ?? (keys.length === 0 ? 'Lorebook entry' : keys.join(', ')),
      body,
      pinned: item['constant'] === true,
      type: 'reference',
    });
  }
  return entries;
}

function cardAsset(value: unknown): { readonly dataUri: PersonaAvatarInput; readonly mimeType: PersonaAvatar['mimeType'] } | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item) || item['type'] !== 'icon') continue;
    const uri = stringValue(item['uri']);
    if (uri === undefined) continue;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(uri);
    if (match === null) continue;
    const mimeType = normalizeMime(match[1]!);
    return { dataUri: { data: Uint8Array.from(Buffer.from(match[2]!, 'base64')), mimeType }, mimeType };
  }
  return undefined;
}

function findArchiveAvatar(
  entries: ReadonlyMap<string, Uint8Array>,
  card: unknown,
): { readonly name: string; readonly data: Uint8Array; readonly mimeType: PersonaAvatar['mimeType'] } | undefined {
  const assetUri = isRecord(card) && isRecord(card['data']) && Array.isArray(card['data']['assets'])
    ? card['data']['assets'].find((item: unknown) => isRecord(item) && item['type'] === 'icon')
    : undefined;
  const requested = isRecord(assetUri) ? stringValue(assetUri['uri']) : undefined;
  const names = requested === undefined ? [] : [requested, requested.replace(/^.*?assets[\\/]/, 'assets/')];
  for (const name of [...names, ...entries.keys()]) {
    const bytes = entries.get(name) ?? entries.get(name.replaceAll('\\', '/'));
    if (bytes === undefined) continue;
    const mimeType = mimeFromName(name);
    if (mimeType !== undefined) return { name, data: bytes, mimeType };
  }
  return undefined;
}

async function avatarAsPng(avatar: PersonaAvatar | undefined): Promise<Uint8Array> {
  if (avatar === undefined) return EMPTY_PNG;
  if (avatar.mimeType === 'image/png') return avatar.data;
  const { Jimp } = await import('jimp');
  if (avatar.mimeType === 'image/webp') {
    const { decodeWebp } = await import('#/agent/media/webp-decode');
    const decoded = await decodeWebp(avatar.data);
    const image = await Jimp.fromBitmap({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
    return image.getBuffer('image/png');
  }
  const image = await Jimp.fromBuffer(Buffer.from(avatar.data));
  return image.getBuffer('image/png');
}

function appendPngText(png: Uint8Array, keyword: string, value: string): Uint8Array {
  if (!isPng(png)) throw new Error('Cannot write character metadata to an invalid PNG');
  const text = Buffer.from(`${keyword}\0${value}`, 'latin1');
  const chunk = pngChunk('tEXt', text);
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = readUint32(png, offset);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString('ascii');
    const end = offset + 12 + length;
    if (type === 'IEND') return Uint8Array.from(Buffer.concat([Buffer.from(png.subarray(0, offset)), chunk, Buffer.from(png.subarray(offset))]));
    if (end > png.length) break;
    offset = end;
  }
  throw new Error('Cannot write character metadata to a truncated PNG');
}

function readPngText(png: Uint8Array): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = readUint32(png, offset);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString('ascii');
    const content = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const separator = content.indexOf(0);
      if (separator > 0) values.set(Buffer.from(content.subarray(0, separator)).toString('latin1'), Buffer.from(content.subarray(separator + 1)).toString('latin1'));
    } else if (type === 'iTXt') {
      const separator = content.indexOf(0);
      if (separator > 0) {
        const keyword = Buffer.from(content.subarray(0, separator)).toString('latin1');
        const parts = content.subarray(separator + 1);
        const textStart = findITXtTextStart(parts);
        if (textStart !== undefined) values.set(keyword, Buffer.from(parts.subarray(textStart)).toString('utf8'));
      }
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return values;
}

function findITXtTextStart(value: Uint8Array): number | undefined {
  let zeroes = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === 0) {
      zeroes += 1;
      if (zeroes === 3) return index + 1;
    }
  }
  return undefined;
}

function pngChunk(type: string, content: Uint8Array): Buffer {
  const result = Buffer.alloc(12 + content.length);
  result.writeUInt32BE(content.length, 0);
  result.write(type, 4, 4, 'ascii');
  Buffer.from(content).copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + content.length)), 8 + content.length);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const value = crc ^ 0xffffffff;
  return value < 0 ? value + 0x100000000 : value;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

async function makeZip(entries: readonly { readonly name: string; readonly data: Uint8Array }[]): Promise<Uint8Array> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const stream = zip.outputStream;
  const output = new Promise<Uint8Array>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(Uint8Array.from(Buffer.concat(chunks))));
  });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name);
  zip.end();
  return output;
}

async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Uint8Array>();
    let count = 0;
    let total = 0;
    let settled = false;
    yauzlFromBuffer(Buffer.from(bytes), { lazyEntries: true }, (openError, zipfile) => {
      if (openError !== null || zipfile === undefined) {
        reject(openError ?? new Error('Unable to open character card archive'));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zipfile.on('error', fail);
      zipfile.on('entry', (entry: Entry) => {
        if (settled) return;
        count += 1;
        total += entry.uncompressedSize;
        if (count > MAX_CHARX_ENTRIES || total > MAX_CHARX_UNCOMPRESSED_BYTES) {
          fail(new Error('Character card archive exceeds its entry or expanded-size limit'));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        if (!isSafeArchivePath(entry.fileName)) {
          fail(new Error(`Character card archive contains an unsafe path: ${entry.fileName}`));
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            fail(streamError ?? new Error(`Unable to read ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', fail);
          stream.once('end', () => {
            if (settled) return;
            result.set(entry.fileName.replaceAll('\\', '/'), Uint8Array.from(Buffer.concat(chunks)));
            zipfile.readEntry();
          });
        });
      });
      zipfile.once('end', () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      });
      zipfile.readEntry();
    });
  });
}

function isCardJsonName(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll('\\', '/');
  return normalized === 'card.json' || normalized.endsWith('/card.json') || normalized === 'character.json' || normalized.endsWith('/character.json');
}

function isSafeArchivePath(name: string): boolean {
  return !name.startsWith('/') && !name.split(/[\\/]/).includes('..');
}

function mimeFromName(name: string): PersonaAvatar['mimeType'] | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}

function normalizeMime(value: string): PersonaAvatar['mimeType'] {
  return value.toLowerCase() === 'image/jpeg' ? 'image/jpeg' : value.toLowerCase() === 'image/webp' ? 'image/webp' : 'image/png';
}

export function personaCardBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  return result.length === 0 ? undefined : [...new Set(result)];
}

function firstString(value: unknown): string | undefined {
  return stringList(value)?.[0];
}

function removeUndefined<T extends object>(value: T): T {
  const output = { ...value } as T & Record<string, unknown>;
  for (const key of Object.keys(output)) if (output[key] === undefined) delete output[key];
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import type {
  HttpRestPersonaCardInput,
  HttpRestPersonaImportInput,
} from '../../core/facade/http-rest.js';
import type { PersonaAvatarShape, PersonaCardFormat } from '@kiki/protocol';

export function personaCardForm(input: HttpRestPersonaCardInput | HttpRestPersonaImportInput): FormData {
  const format = input.format ?? inferCardFormat(input.filename);
  const filename = input.filename ?? `persona.${format}`;
  const form = new FormData();
  form.append('file', new Blob([copyBytes(input.data)], { type: mimeForCard(format) }), filename);
  if (format !== undefined) form.append('format', format);
  if ('id' in input && input.id !== undefined) form.append('id', input.id);
  if ('name' in input && input.name !== undefined) form.append('name', input.name);
  return form;
}

export function personaAvatarForm(data: Uint8Array, mimeType?: string, shape?: PersonaAvatarShape): FormData {
  const normalized = mimeType ?? 'application/octet-stream';
  const extension = normalized === 'image/jpeg' ? 'jpg' : normalized === 'image/webp' ? 'webp' : 'png';
  const form = new FormData();
  if (shape !== undefined) form.append('shape', shape);
  form.append('file', new Blob([copyBytes(data)], { type: normalized }), `avatar.${extension}`);
  return form;
}

function copyBytes(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}

function inferCardFormat(filename: string | undefined): PersonaCardFormat | undefined {
  const lower = filename?.toLowerCase();
  if (lower?.endsWith('.png')) return 'png';
  if (lower?.endsWith('.charx')) return 'charx';
  if (lower?.endsWith('.json')) return 'json';
  return undefined;
}

function mimeForCard(format: PersonaCardFormat | undefined): string {
  if (format === 'png') return 'image/png';
  if (format === 'charx') return 'application/zip';
  return 'application/json';
}

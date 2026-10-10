import { isAbsolute, join, normalize } from 'pathe';

import type { CognitionConfig, CognitionSlotContent } from '#/kosong/model/model';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isWithinDirectory } from '#/tool/path-access';

export type CognitionSlot = 'overlay' | 'steering' | 'anchor';

export type CognitionFileErrorReason = 'missing' | 'escape' | 'absolute' | 'empty' | 'mode';

export class CognitionFileError extends Error {
  constructor(
    readonly reason: CognitionFileErrorReason,
    readonly slot: CognitionSlot,
    readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = 'CognitionFileError';
  }
}

export function cognitionPathRefs(value: CognitionSlotContent | undefined): string[] {
  if (value === undefined || isCognitionInline(value)) return [];
  return typeof value === 'string' ? [value] : [...value];
}

export function isCognitionInline(value: CognitionSlotContent | undefined): value is { text: string } {
  return value !== undefined && typeof value === 'object' && 'text' in value;
}

export function hasCognitionContent(value: CognitionSlotContent | undefined): boolean {
  return isCognitionInline(value) ? value.text.length > 0 : cognitionPathRefs(value).length > 0;
}

export async function readCognitionContent(
  fs: IHostFileSystem,
  homeDir: string,
  slot: CognitionSlot,
  value: CognitionSlotContent | undefined,
  pathClass: PathClass,
): Promise<string | undefined> {
  if (isCognitionInline(value)) return value.text.length === 0 ? undefined : value.text;
  return readCognitionSlot(fs, homeDir, slot, cognitionPathRefs(value), pathClass);
}

/** `cognition` helpers — resolves and loads `[models.<alias>.cognition]` files. Paths are relative to
 *  the Kiki home directory (`IBootstrapService.homeDir`); declared files must exist and stay inside
 *  that home, missing or escaped paths fail closed, and the host does not interpret pack layout. */
export function resolveCognitionPath(
  homeDir: string,
  ref: string,
  pathClass: PathClass,
  slot: CognitionSlot = 'overlay',
): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new CognitionFileError(
      'empty',
      slot,
      ref,
      `cognition.${slot} path is empty`,
    );
  }
  if (isAbsolute(trimmed)) {
    throw new CognitionFileError(
      'absolute',
      slot,
      trimmed,
      `cognition.${slot} path "${trimmed}" must be relative to the Kiki home directory`,
    );
  }
  const home = normalize(homeDir);
  const resolved = normalize(join(home, trimmed));
  if (!isWithinDirectory(resolved, home, pathClass)) {
    throw new CognitionFileError(
      'escape',
      slot,
      trimmed,
      `cognition.${slot} path "${trimmed}" escapes the Kiki home directory`,
    );
  }
  return resolved;
}

export async function readCognitionSlot(
  fs: IHostFileSystem,
  homeDir: string,
  slot: CognitionSlot,
  refs: readonly string[],
  pathClass: PathClass,
): Promise<string | undefined> {
  const files = await readCognitionFiles(fs, homeDir, slot, refs, pathClass);
  const pieces = files.map((file) => file.text.trim()).filter((text) => text.length > 0);
  return pieces.length === 0 ? undefined : pieces.join('\n\n');
}

export async function readCognitionFiles(
  fs: IHostFileSystem,
  homeDir: string,
  slot: CognitionSlot,
  refs: readonly string[],
  pathClass: PathClass,
  maxBytes?: number,
): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  let size = 0;
  const home = normalize(homeDir);
  for (const ref of refs) {
    const lexical = resolveCognitionPath(homeDir, ref, pathClass, slot);
    let real: string;
    try {
      real = normalize(await fs.realpath(lexical));
    } catch {
      throw new CognitionFileError(
        'missing',
        slot,
        ref,
        `cognition.${slot} file "${ref}" was not found under the Kiki home directory`,
      );
    }
    if (!isWithinDirectory(real, home, pathClass)) {
      throw new CognitionFileError(
        'escape',
        slot,
        ref,
        `cognition.${slot} path "${ref}" escapes the Kiki home directory`,
      );
    }
    if (maxBytes !== undefined) {
      const stat = await fs.stat(real);
      if (!stat.isFile || size + stat.size > maxBytes) throw new Error(`cognition.${slot} exceeds the ${maxBytes} byte editor limit or is not a file`);
    }
    const text = await fs.readText(real, { errors: 'strict' });
    size += Buffer.byteLength(text, 'utf8');
    if (maxBytes !== undefined && size > maxBytes) throw new Error(`cognition.${slot} exceeds the ${maxBytes} byte editor limit`);
    files.push({ path: ref, text });
  }
  return files;
}

export type OverlayMode = 'append' | 'prepend' | 'wrap' | 'persona' | 'replace';

const WRAP_CLOSE =
  'End of assignment. Resume the thinking protocol above; it still governs reasoning.';

/** Drops the leading "You are …" paragraph so overlay can replace identity. */
export function stripLeadingIdentityParagraph(base: string): string {
  const trimmed = base.trimStart();
  if (!/^You are\b/i.test(trimmed)) return trimmed;
  const idx = trimmed.search(/\n\n/);
  if (idx < 0) return '';
  return trimmed.slice(idx + 2).trimStart();
}

export function applyOverlay(
  base: string,
  overlay: string | undefined,
  mode: OverlayMode = 'append',
): string {
  if (overlay === undefined || overlay.length === 0) return base;
  if (base.length === 0) return overlay;
  if (mode === 'prepend') return `${overlay}\n\n${base}`;
  if (mode === 'wrap') {
    if (overlay.includes('${profile_prompt}')) {
      return overlay.replaceAll('${profile_prompt}', base);
    }
    return `${overlay}\n\n${base}\n\n${WRAP_CLOSE}`;
  }
  if (mode === 'persona') {
    const rest = stripLeadingIdentityParagraph(base);
    return rest.length === 0 ? overlay : `${overlay}\n\n${rest}`;
  }
  if (mode === 'replace') return overlay;
  return `${base}\n\n${overlay}`;
}

export function applyOverlayAppend(base: string, overlay: string | undefined): string {
  return applyOverlay(base, overlay, 'append');
}

export async function loadCognitionSlots(
  fs: IHostFileSystem,
  homeDir: string,
  cognition: CognitionConfig | undefined,
  pathClass: PathClass,
): Promise<{
  overlay: string | undefined;
  steering: string | undefined;
  anchor: string | undefined;
}> {
  if (cognition === undefined) {
    return { overlay: undefined, steering: undefined, anchor: undefined };
  }
  const overlayMode = cognition.overlayMode;
  if (
    overlayMode !== undefined &&
    overlayMode !== 'append' &&
    overlayMode !== 'prepend' &&
    overlayMode !== 'wrap' &&
    overlayMode !== 'persona' &&
    overlayMode !== 'replace'
  ) {
    throw new CognitionFileError(
      'mode',
      'overlay',
      overlayMode,
      `cognition.overlay_mode "${String(overlayMode)}" is not supported; use append, prepend, wrap, persona, or replace`,
    );
  }
  const overlay = await readCognitionContent(fs, homeDir, 'overlay', cognition.overlay, pathClass);
  const steering = await readCognitionContent(fs, homeDir, 'steering', cognition.steering, pathClass);
  const anchor = await readCognitionContent(fs, homeDir, 'anchor', cognition.anchor, pathClass);
  return { overlay, steering, anchor };
}

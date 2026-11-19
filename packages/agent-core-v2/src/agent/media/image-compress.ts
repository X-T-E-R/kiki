import { createHash } from 'node:crypto';

import type { ContentPart } from '#/kosong/contract/message';

import { sniffImageDimensions, sniffMediaFromMagic } from './file-type';
import {
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseCompleteImageDataUrl,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from './image-format-policy';
import { isAnimatedWebp } from './webp-decode';
import { decodeToJimp } from './imageDecode';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { hasRegisteredCpuPool, runCpuTask } from '#/app/cpuWorker/runtime';

export const MAX_IMAGE_EDGE_PX = 2000;

let configuredMaxImageEdgePx: number | undefined;

export function setConfiguredMaxImageEdgePx(value: number | undefined): void {
  configuredMaxImageEdgePx = value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveMaxImageEdgePx(): number {
  return configuredMaxImageEdgePx ?? MAX_IMAGE_EDGE_PX;
}

export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

let configuredReadImageByteBudget: number | undefined;

export function setConfiguredReadImageByteBudget(value: number | undefined): void {
  configuredReadImageByteBudget =
    value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveReadImageByteBudget(): number {
  return configuredReadImageByteBudget ?? READ_IMAGE_BYTE_BUDGET;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

const PNG_RESCALE_FLOOR_PX = 1000;

const MAX_DECODE_PIXELS = 100_000_000;

export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp']);

export interface ImageWorkerOptions {
  readonly cpuWorker?: ICpuWorkerService;
  readonly signal?: AbortSignal;
}

export interface CompressImageOptions extends ImageWorkerOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
  readonly telemetry?: ImageCompressionTelemetry;
  readonly providerType?: string;
  readonly acceptedMimes?: ReadonlySet<string>;
  readonly outputMimes?: ReadonlySet<string>;
}

export interface ImageCompressionTelemetryClient {
  track(
    event: string,
    properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void;
}

export interface ImageCompressionTelemetry {
  readonly client: ImageCompressionTelemetryClient;
  readonly source: string;
}

type CompressOutcome =
  | 'compressed'
  | 'passthrough_fast'
  | 'passthrough_guard'
  | 'passthrough_unsupported'
  | 'passthrough_unhelpful'
  | 'passthrough_error';

export interface CompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
  const acceptedMimes = options.acceptedMimes;
  const outputMimes = options.outputMimes ?? acceptedMimes ?? new Set(['image/png', 'image/jpeg']);
  const requiresFormatConversion = acceptedMimes !== undefined && !acceptedMimes.has(normalizedMime);
  const dims = sniffImageDimensions(bytes);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });
  const finish = (outcome: CompressOutcome, result: CompressImageResult): CompressImageResult => {
    reportCompressEvent(options.telemetry, {
      outcome,
      startedAt,
      inputMime: normalizedMime,
      exifTransposed: dims?.transposed === true,
      result,
    });
    return result;
  };

  if (bytes.length === 0) return finish('passthrough_unsupported', passthrough());
  if (
    !RECODABLE_MIME.has(normalizedMime) ||
    (normalizedMime === 'image/bmp' && acceptedMimes === undefined)
  ) {
    return finish('passthrough_unsupported', passthrough());
  }
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return finish('passthrough_unsupported', passthrough());
  }

  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (!requiresFormatConversion && withinBytes && (withinEdge || longestEdge === 0)) {
    return finish('passthrough_fast', passthrough());
  }

  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return finish('passthrough_guard', passthrough());
  }
  if (bytes.length > maxDecodeBytes) return finish('passthrough_guard', passthrough());

  try {
    options.signal?.throwIfAborted();
    const outputMimeList = [...outputMimes];
    const useWorker =
      options.cpuWorker !== undefined ||
      (hasRegisteredCpuPool() &&
        (bytes.byteLength > 65_536 || (dims !== null && dims.width * dims.height > 262_144)));
    let encodedResult: ImageCompressWorkerOutput;
    if (useWorker) {
      const ownedBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const workerCall = dispatchCpuImageTask<ImageCompressWorkerOutput>(
        {
          type: 'image.compress',
          bytes: ownedBytes,
          normalizedMime,
          maxEdge,
          byteBudget,
          outputMimes: outputMimeList,
        },
        ownedBytes,
        options,
      );
      if (workerCall !== undefined) {
        try {
          encodedResult = await workerCall;
        } catch {
          if (options.signal?.aborted) return finish('passthrough_error', passthrough());
          encodedResult = await executeImageCompress(
            {
              bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
              normalizedMime,
              maxEdge,
              byteBudget,
              outputMimes: outputMimeList,
            },
            options.signal,
          );
        }
      } else {
        encodedResult = await executeImageCompress(
          {
            bytes: ownedBytes,
            normalizedMime,
            maxEdge,
            byteBudget,
            outputMimes: outputMimeList,
          },
          options.signal,
        );
      }
    } else {
      encodedResult = await executeImageCompress(
        {
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          normalizedMime,
          maxEdge,
          byteBudget,
          outputMimes: outputMimeList,
        },
        options.signal,
      );
    }
    if (encodedResult.kind === 'unsupported') return finish('passthrough_unsupported', passthrough());
    if (encodedResult.kind === 'error') return finish('passthrough_error', passthrough());

    const encodedBytes = new Uint8Array(encodedResult.data);
    const originalPixels = encodedResult.originalWidth * encodedResult.originalHeight;
    const finalPixels = encodedResult.width * encodedResult.height;
    const shrankBytes = encodedBytes.length < bytes.length;
    const shrankPixels = finalPixels < originalPixels;
    if (!requiresFormatConversion && !shrankBytes && !shrankPixels) {
      return finish('passthrough_unhelpful', passthrough());
    }

    return finish('compressed', {
      data: encodedBytes,
      mimeType: encodedResult.mimeType,
      width: encodedResult.width,
      height: encodedResult.height,
      originalWidth: encodedResult.originalWidth,
      originalHeight: encodedResult.originalHeight,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encodedBytes.length,
    });
  } catch {
    return finish('passthrough_error', passthrough());
  }
}

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  const startedAt = Date.now();
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxDecodeBytes) {
    const result: CompressBase64Result = {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: approxBytes,
      finalByteLength: approxBytes,
    };
    reportCompressEvent(options.telemetry, {
      outcome: 'passthrough_guard',
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      exifTransposed: false,
      result,
    });
    return result;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    const result: CompressBase64Result = {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: 0,
      finalByteLength: 0,
    };
    reportCompressEvent(options.telemetry, {
      outcome: 'passthrough_error',
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      exifTransposed: false,
      result,
    });
    return result;
  }
  const result = await compressImageForModel(bytes, mimeType, options);
  if (!result.changed) {
    return {
      base64,
      mimeType,
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      changed: false,
      originalByteLength: result.originalByteLength,
      finalByteLength: result.finalByteLength,
    };
  }
  return {
    base64: Buffer.from(result.data).toString('base64'),
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    originalWidth: result.originalWidth,
    originalHeight: result.originalHeight,
    changed: true,
    originalByteLength: result.originalByteLength,
    finalByteLength: result.finalByteLength,
  };
}

export interface ValidatedImageDataUrl {
  readonly mimeType: string;
  readonly base64: string;
  readonly bytes: Buffer;
}

const DECODABLE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

const DECODE_VERDICT_LIMIT = 1024;
const decodeVerdicts = new Map<string, boolean>();
const decodingImages = new Map<string, Promise<boolean>>();

async function decodesAsImage(bytes: Buffer, mimeType: string): Promise<boolean> {
  const key = `${mimeType}:${createHash('sha256').update(bytes).digest('base64')}`;
  const known = decodeVerdicts.get(key);
  if (known !== undefined) {
    decodeVerdicts.delete(key);
    decodeVerdicts.set(key, known);
    return known;
  }
  const active = decodingImages.get(key);
  if (active !== undefined) return active;
  const copy = Uint8Array.from(bytes).buffer;
  const decoding = runCpuTask<boolean>({ type: 'image.decode', bytes: copy, mimeType }, { transferList: [copy] });
  decodingImages.set(key, decoding);
  try {
    const verdict = await decoding;
    decodeVerdicts.set(key, verdict);
    if (decodeVerdicts.size > DECODE_VERDICT_LIMIT) decodeVerdicts.delete(decodeVerdicts.keys().next().value!);
    return verdict;
  } finally { decodingImages.delete(key); }
}

/** Proves a complete image data URL decodes as an image. The decode verdict is remembered by
 *  content digest, so history images revalidated on every model step decode once per process. */
export async function validateImageDataUrl(url: string): Promise<ValidatedImageDataUrl | null> {
  const parsed = parseCompleteImageDataUrl(url);
  if (parsed === null) return null;
  const bytes = Buffer.from(parsed.base64, 'base64');
  if (bytes.length === 0) return null;
  const mimeType = normalizeImageMime(parsed.mimeType);
  if (DECODABLE_IMAGE_MIMES.has(mimeType)) {
    if (!(await decodesAsImage(bytes, mimeType))) return null;
  } else if (sniffMediaFromMagic(bytes)?.kind !== 'image') {
    return null;
  }
  return { mimeType, base64: parsed.base64, bytes };
}

export interface CompressedContentParts {
  readonly parts: ContentPart[];
  readonly captions: readonly string[];
}

export function gateImageFormatParts(
  parts: readonly ContentPart[],
  providerType?: string,
): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed === null) {
        if (isDataUrl(part.imageUrl.url)) {
          out.push({ type: 'text', text: buildMalformedImageNotice(part.imageUrl.url) });
          continue;
        }
        const extMime = unsupportedImageMimeFromUrl(part.imageUrl.url, providerType);
        if (extMime !== null) {
          out.push({
            type: 'text',
            text: buildUnsupportedImageNotice(extMime, part.imageUrl.url, providerType),
          });
          continue;
        }
        out.push(part);
        continue;
      }
      const effectiveMime = resolveEffectiveImageMime(
        parsed.mimeType,
        decodeBase64Prefix(parsed.base64),
      );
      if (!isModelAcceptedImageMime(effectiveMime, providerType)) {
        out.push({
          type: 'text',
          text: buildUnsupportedImageNotice(effectiveMime, undefined, providerType),
        });
        continue;
      }
      const canonicalUrl = `data:${normalizeImageMime(effectiveMime)};base64,${parsed.base64}`;
      if (part.imageUrl.url !== canonicalUrl) {
        out.push({ type: 'image_url', imageUrl: { ...part.imageUrl, url: canonicalUrl } });
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

export async function compressImageContentParts(
  parts: readonly ContentPart[],
  options: CompressImageOptions & { readonly annotate?: CompressAnnotateOptions } = {},
): Promise<CompressedContentParts> {
  const { annotate, ...compressOptions } = options;
  const out: ContentPart[] = [];
  const captions: string[] = [];
  for (const part of gateImageFormatParts(parts, options.providerType)) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const result = await compressBase64ForModel(parsed.base64, parsed.mimeType, compressOptions);
        if (result.changed) {
          if (annotate !== undefined) {
            let originalPath: string | null = null;
            if (annotate.persistOriginal !== undefined) {
              try {
                originalPath = await annotate.persistOriginal(
                  Buffer.from(parsed.base64, 'base64'),
                  parsed.mimeType,
                );
              } catch {
                originalPath = null;
              }
            }
            captions.push(
              buildImageCompressionCaption({
                original: {
                  width: result.originalWidth,
                  height: result.originalHeight,
                  byteLength: result.originalByteLength,
                  mimeType: parsed.mimeType,
                },
                final: {
                  width: result.width,
                  height: result.height,
                  byteLength: result.finalByteLength,
                  mimeType: result.mimeType,
                },
                originalPath,
              }),
            );
          }
          out.push({
            type: 'image_url',
            imageUrl: { ...part.imageUrl, url: `data:${result.mimeType};base64,${result.base64}` },
          });
          continue;
        }
      }
    }
    out.push(part);
  }
  return { parts: out, captions };
}

export interface CompressAnnotateOptions {
  readonly persistOriginal?: (bytes: Uint8Array, mimeType: string) => Promise<string | null>;
}

export interface ImageCropRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropImageOptions extends CompressImageOptions {
  readonly skipResize?: boolean;
}

export interface CropImageSuccess {
  readonly ok: true;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly region: ImageCropRegion;
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export interface CropImageFailure {
  readonly ok: false;
  readonly error: string;
}

export type CropImageOutcome = CropImageSuccess | CropImageFailure;

export async function cropImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  region: ImageCropRegion,
  options: CropImageOptions = {},
): Promise<CropImageOutcome> {
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);

  const fail = (errorKind: CropErrorKind, error: string): CropImageFailure => {
    reportCropEvent(options.telemetry, { startedAt, ok: false, errorKind });
    return { ok: false, error };
  };
  const succeed = (result: CropImageSuccess): CropImageSuccess => {
    reportCropEvent(options.telemetry, { startedAt, ok: true, result });
    return result;
  };

  if (bytes.length === 0) {
    return fail('empty', 'The image is empty.');
  }
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return fail(
      'unsupported_format',
      `Cropping is only supported for PNG, JPEG, and WebP images; got ${mimeType}.`,
    );
  }
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return fail('unsupported_format', 'Cropping is not supported for animated WebP images.');
  }
  if (
    ![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value))
  ) {
    return fail(
      'region_invalid',
      `Region coordinates must be finite numbers; got x=${String(region.x)}, ` +
        `y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    );
  }
  const dims = sniffImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return fail(
      'too_large',
      `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    );
  }
  if (bytes.length > maxDecodeBytes) {
    return fail('too_large', 'The image is too large to decode for cropping.');
  }

  try {
    options.signal?.throwIfAborted();
    const outputMimeList = [...(options.outputMimes ?? options.acceptedMimes ?? new Set(['image/png', 'image/jpeg']))];
    let cropped: ImageCropWorkerOutput;
    const ownedBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const workerCall = dispatchCpuImageTask<ImageCropWorkerOutput>(
      {
        type: 'image.crop',
        bytes: ownedBytes,
        normalizedMime,
        region,
        maxEdge,
        byteBudget,
        skipResize: options.skipResize === true,
        outputMimes: outputMimeList,
      },
      ownedBytes,
      options,
    );
    if (workerCall !== undefined) {
      try {
        cropped = await workerCall;
      } catch {
        if (options.signal?.aborted) {
          return fail('decode_failed', 'Failed to decode the image for cropping: aborted');
        }
        cropped = await executeImageCrop(
          {
            bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
            normalizedMime,
            region,
            maxEdge,
            byteBudget,
            skipResize: options.skipResize === true,
            outputMimes: outputMimeList,
          },
          options.signal,
        );
      }
    } else {
      cropped = await executeImageCrop(
        {
          bytes: ownedBytes,
          normalizedMime,
          region,
          maxEdge,
          byteBudget,
          skipResize: options.skipResize === true,
          outputMimes: outputMimeList,
        },
        options.signal,
      );
    }

    if (cropped.kind === 'out_of_bounds') {
      return fail(
        'out_of_bounds',
        `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, ` +
          `height=${String(region.height)}) lies outside the ${String(cropped.originalWidth)}x${String(cropped.originalHeight)} image.`,
      );
    }
    if (cropped.kind === 'budget') {
      return fail(
        'budget',
        `The cropped region encodes to ${String(cropped.byteLength)} bytes ` +
          `(${formatByteSize(cropped.byteLength)}), over the ${String(byteBudget)}-byte ` +
          `(${formatByteSize(byteBudget)}) per-image limit. ` +
          'Choose a smaller region, or allow downscaling.',
      );
    }
    if (cropped.kind === 'unsupported') {
      return fail('unsupported_format', 'No accepted image output format is available.');
    }
    if (cropped.kind === 'decode_failed') {
      return fail('decode_failed', `Failed to decode the image for cropping: ${cropped.message}`);
    }

    const data = new Uint8Array(cropped.data);
    return succeed({
      ok: true,
      data,
      mimeType: cropped.mimeType,
      width: cropped.width,
      height: cropped.height,
      originalWidth: cropped.originalWidth,
      originalHeight: cropped.originalHeight,
      region: cropped.region,
      resized: cropped.resized,
      originalByteLength: bytes.length,
      finalByteLength: data.length,
    });
  } catch (error) {
    return fail(
      'decode_failed',
      `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ImageVariantDescription {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  readonly originalPath?: string | null;
}

export function buildImageCompressionCaption(input: ImageCompressionCaptionInput): string {
  const sentences = [
    `Image compressed to fit model limits: original ${describeImageVariant(input.original)} -> ` +
      `sent ${describeImageVariant(input.final)}.`,
    'Fine detail may be lost.',
  ];
  if (typeof input.originalPath === 'string' && input.originalPath.length > 0) {
    sentences.push(
      `The uncompressed original is saved at "${input.originalPath}"; if you need fine detail ` +
        '(e.g. small text), call ReadMediaFile on that path with the region parameter ' +
        '(original-pixel coordinates) to view a crop at full fidelity.',
    );
  } else {
    sentences.push('The uncompressed original was not preserved.');
  }
  return `<system>${sentences.join(' ')}</system>`;
}

const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

const CAPTION_PATTERN = /<system>(Image compressed to fit model limits:[\s\S]*?)<\/system>/g;

export interface ImageCompressionCaptionExtraction {
  readonly captions: readonly string[];
  readonly text: string;
}

export function extractImageCompressionCaptions(text: string): ImageCompressionCaptionExtraction {
  if (!text.includes(CAPTION_OPENING)) return { captions: [], text };
  const captions: string[] = [];
  const remainder = text.replace(CAPTION_PATTERN, (_match, body: string) => {
    captions.push(body);
    return '';
  });
  return { captions, text: remainder };
}

function describeImageVariant(variant: ImageVariantDescription): string {
  const size = `${variant.mimeType} (${formatByteSize(variant.byteLength)})`;
  if (variant.width > 0 && variant.height > 0) {
    return `${String(variant.width)}x${String(variant.height)} ${size}`;
  }
  return size;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly preferLossless: boolean;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
  readonly outputMimes: ReadonlySet<string>;
}

async function encodeWithinBudget(
  image: JimpImage,
  opts: EncodeOptions,
  signal?: AbortSignal,
): Promise<EncodedImage | null> {
  const { preferLossless, byteBudget, fallbackEdges, outputMimes } = opts;
  const allowPng = outputMimes.has('image/png');
  const allowJpeg = outputMimes.has('image/jpeg');
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) {
      smallest = candidate;
    }
    return candidate;
  };

  const pngCandidate = async (): Promise<EncodedImage | null> => {
    if (!allowPng) return null;
    signal?.throwIfAborted();
    const png = await image.getBuffer('image/png', { deflateLevel: 6 });
    signal?.throwIfAborted();
    return consider(png, 'image/png');
  };

  const jpegLadder = async (): Promise<EncodedImage | null> => {
    if (!allowJpeg) return null;
    for (const quality of JPEG_QUALITY_STEPS) {
      signal?.throwIfAborted();
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      signal?.throwIfAborted();
      if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
      consider(jpeg, 'image/jpeg');
    }
    return null;
  };

  if (allowPng && (preferLossless || !allowJpeg)) {
    const png = await pngCandidate();
    if (png !== null && png.data.length <= byteBudget) return png;
    for (const edge of fallbackEdges) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      signal?.throwIfAborted();
      if (!fitWithinEdge(image, edge)) continue;
      const smallerPng = await pngCandidate();
      if (smallerPng !== null && smallerPng.data.length <= byteBudget) return smallerPng;
    }
    if (!allowJpeg) {
      for (const edge of fallbackEdges) {
        if (edge >= PNG_RESCALE_FLOOR_PX) continue;
        signal?.throwIfAborted();
        if (!fitWithinEdge(image, edge)) continue;
        const smallerPng = await pngCandidate();
        if (smallerPng !== null && smallerPng.data.length <= byteBudget) return smallerPng;
      }
      return smallest;
    }
  }

  const atFitted = await jpegLadder();
  if (atFitted !== null) return atFitted;
  for (const edge of fallbackEdges) {
    signal?.throwIfAborted();
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }

  if (!allowJpeg && allowPng && smallest === null) return pngCandidate();
  return smallest;
}

function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height);
  if (longest <= edge) return false;
  const factor = edge / longest;
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  });
  return true;
}

function predecimateForEdge(image: JimpImage, targetEdge: number, signal?: AbortSignal): void {
  let width = image.bitmap.width;
  let height = image.bitmap.height;
  let src: Buffer | Uint8Array = image.bitmap.data;
  let decimated = false;
  while (Math.max(width, height) > targetEdge * 2 && width >= 4 && height >= 4) {
    signal?.throwIfAborted();
    const nextW = width >> 1;
    const nextH = height >> 1;
    const dst = Buffer.allocUnsafe(nextW * nextH * 4);
    const srcStride = width * 4;
    let dstIdx = 0;
    for (let y = 0; y < nextH; y += 1) {
      let row0 = y * 2 * srcStride;
      let row1 = row0 + srcStride;
      for (let x = 0; x < nextW; x += 1) {
        dst[dstIdx] = (src[row0]! + src[row0 + 4]! + src[row1]! + src[row1 + 4]! + 2) >> 2;
        dst[dstIdx + 1] = (src[row0 + 1]! + src[row0 + 5]! + src[row1 + 1]! + src[row1 + 5]! + 2) >> 2;
        dst[dstIdx + 2] = (src[row0 + 2]! + src[row0 + 6]! + src[row1 + 2]! + src[row1 + 6]! + 2) >> 2;
        dst[dstIdx + 3] = (src[row0 + 3]! + src[row0 + 7]! + src[row1 + 3]! + src[row1 + 7]! + 2) >> 2;
        row0 += 8;
        row1 += 8;
        dstIdx += 4;
      }
    }
    src = dst;
    width = nextW;
    height = nextH;
    decimated = true;
  }
  if (decimated) {
    image.bitmap.data = src as Buffer;
    image.bitmap.width = width;
    image.bitmap.height = height;
  }
}

function dispatchCpuImageTask<T>(
  operation: unknown,
  transfer: ArrayBuffer,
  options?: ImageWorkerOptions,
): Promise<T> | undefined {
  if (options?.cpuWorker !== undefined) {
    return options.cpuWorker.request<T>(operation, {
      signal: options.signal,
      transferList: [transfer],
      bytes: transfer.byteLength,
    });
  }
  if (hasRegisteredCpuPool()) {
    return runCpuTask<T>(operation, {
      signal: options?.signal,
      transferList: [transfer],
      bytes: transfer.byteLength,
    });
  }
  return undefined;
}

export interface ImageCompressWorkerInput {
  readonly bytes: ArrayBuffer;
  readonly normalizedMime: string;
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly outputMimes: readonly string[];
}

export type ImageCompressWorkerOutput =
  | {
      readonly kind: 'encoded';
      readonly data: ArrayBuffer;
      readonly mimeType: string;
      readonly width: number;
      readonly height: number;
      readonly originalWidth: number;
      readonly originalHeight: number;
    }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error' };

export async function executeImageCompress(
  input: ImageCompressWorkerInput,
  signal?: AbortSignal,
): Promise<ImageCompressWorkerOutput> {
  try {
    signal?.throwIfAborted();
    const image = await decodeToJimp(new Uint8Array(input.bytes), input.normalizedMime);
    signal?.throwIfAborted();
    const originalWidth = image.width;
    const originalHeight = image.height;
    predecimateForEdge(image, input.maxEdge, signal);
    signal?.throwIfAborted();
    fitWithinEdge(image, input.maxEdge);
    const encoded = await encodeWithinBudget(
      image,
      {
        preferLossless: input.normalizedMime !== 'image/jpeg',
        byteBudget: input.byteBudget,
        fallbackEdges: FALLBACK_EDGES_PX,
        outputMimes: new Set(input.outputMimes),
      },
      signal,
    );
    if (encoded === null) return { kind: 'unsupported' };
    const outBuffer = encoded.data.buffer.slice(
      encoded.data.byteOffset,
      encoded.data.byteOffset + encoded.data.byteLength,
    ) as ArrayBuffer;
    return {
      kind: 'encoded',
      data: outBuffer,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth,
      originalHeight,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'error' };
  }
}

export interface ImageCropWorkerInput {
  readonly bytes: ArrayBuffer;
  readonly normalizedMime: string;
  readonly region: ImageCropRegion;
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly skipResize: boolean;
  readonly outputMimes: readonly string[];
}

export type ImageCropWorkerOutput =
  | {
      readonly kind: 'cropped';
      readonly data: ArrayBuffer;
      readonly mimeType: string;
      readonly width: number;
      readonly height: number;
      readonly originalWidth: number;
      readonly originalHeight: number;
      readonly region: ImageCropRegion;
      readonly resized: boolean;
    }
  | { readonly kind: 'out_of_bounds'; readonly originalWidth: number; readonly originalHeight: number }
  | { readonly kind: 'budget'; readonly byteLength: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'decode_failed'; readonly message: string };

export async function executeImageCrop(
  input: ImageCropWorkerInput,
  signal?: AbortSignal,
): Promise<ImageCropWorkerOutput> {
  try {
    signal?.throwIfAborted();
    const image = await decodeToJimp(new Uint8Array(input.bytes), input.normalizedMime);
    signal?.throwIfAborted();
    const originalWidth = image.width;
    const originalHeight = image.height;

    const x = Math.floor(input.region.x);
    const y = Math.floor(input.region.y);
    if (
      x < 0 ||
      y < 0 ||
      x >= originalWidth ||
      y >= originalHeight ||
      input.region.width < 1 ||
      input.region.height < 1
    ) {
      return { kind: 'out_of_bounds', originalWidth, originalHeight };
    }
    const w = Math.min(Math.floor(input.region.width), originalWidth - x);
    const h = Math.min(Math.floor(input.region.height), originalHeight - y);
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    image.crop({ x, y, w, h });
    signal?.throwIfAborted();
    const preferLossless = input.normalizedMime !== 'image/jpeg';

    if (input.skipResize) {
      const buffer = preferLossless
        ? await image.getBuffer('image/png', { deflateLevel: 9 })
        : await image.getBuffer('image/jpeg', { quality: 90 });
      signal?.throwIfAborted();
      if (buffer.length > input.byteBudget) {
        return { kind: 'budget', byteLength: buffer.length };
      }
      const outBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      return {
        kind: 'cropped',
        data: outBuffer,
        mimeType: preferLossless ? 'image/png' : 'image/jpeg',
        width: image.width,
        height: image.height,
        originalWidth,
        originalHeight,
        region: applied,
        resized: false,
      };
    }

    fitWithinEdge(image, input.maxEdge);
    const encoded = await encodeWithinBudget(
      image,
      {
        preferLossless,
        byteBudget: input.byteBudget,
        fallbackEdges: FALLBACK_EDGES_PX,
        outputMimes: new Set(input.outputMimes),
      },
      signal,
    );
    if (encoded === null) return { kind: 'unsupported' };
    const outBuffer = encoded.data.buffer.slice(
      encoded.data.byteOffset,
      encoded.data.byteOffset + encoded.data.byteLength,
    ) as ArrayBuffer;
    return {
      kind: 'cropped',
      data: outBuffer,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth,
      originalHeight,
      region: applied,
      resized: encoded.width !== w || encoded.height !== h,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      kind: 'decode_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type AvatarImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface AvatarNormalizeWorkerInput {
  readonly bytes: ArrayBuffer;
  readonly mimeType: AvatarImageMime;
}

export interface AvatarNormalizeWorkerOutput {
  readonly data: ArrayBuffer;
  readonly mimeType: AvatarImageMime;
  readonly extension: 'png' | 'jpg' | 'webp';
  readonly width: number;
  readonly height: number;
}

export interface ImageDimensionsWorkerInput {
  readonly bytes: ArrayBuffer;
  readonly mimeType: AvatarImageMime;
}

export interface ImageToPngWorkerInput {
  readonly bytes: ArrayBuffer;
  readonly mimeType: AvatarImageMime;
}

export async function executeAvatarNormalize(
  input: AvatarNormalizeWorkerInput,
  signal?: AbortSignal,
): Promise<AvatarNormalizeWorkerOutput> {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(input.bytes);
  const image = await decodeToJimp(bytes, input.mimeType);
  signal?.throwIfAborted();
  const width = image.width;
  const height = image.height;
  const longest = Math.max(width, height);
  let outputMime: AvatarImageMime = input.mimeType;
  let output: Uint8Array = bytes;
  if (longest > 256 || input.mimeType === 'image/png' || input.mimeType === 'image/jpeg') {
    if (longest > 256) {
      const factor = 256 / longest;
      image.resize({ w: Math.max(1, Math.round(width * factor)), h: Math.max(1, Math.round(height * factor)) });
    }
    signal?.throwIfAborted();
    if (input.mimeType === 'image/webp') outputMime = 'image/png';
    output = outputMime === 'image/jpeg'
      ? await image.getBuffer('image/jpeg', { quality: 90 })
      : await image.getBuffer('image/png', { deflateLevel: 9 });
    signal?.throwIfAborted();
  }
  const extension = outputMime === 'image/jpeg' ? 'jpg' : outputMime === 'image/webp' ? 'webp' : 'png';
  const outBuffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
  return { data: outBuffer, mimeType: outputMime, extension, width: image.width, height: image.height };
}

export async function executeImageDimensions(
  input: ImageDimensionsWorkerInput,
  signal?: AbortSignal,
): Promise<{ readonly width: number; readonly height: number }> {
  signal?.throwIfAborted();
  const image = await decodeToJimp(new Uint8Array(input.bytes), input.mimeType);
  signal?.throwIfAborted();
  return { width: image.width, height: image.height };
}

export async function executeImageToPng(
  input: ImageToPngWorkerInput,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const image = await decodeToJimp(new Uint8Array(input.bytes), input.mimeType);
  signal?.throwIfAborted();
  const buffer = await image.getBuffer('image/png');
  signal?.throwIfAborted();
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export async function normalizeAvatarImage(
  data: Uint8Array,
  mimeType: AvatarImageMime,
  options?: ImageWorkerOptions,
): Promise<{ readonly data: Uint8Array; readonly mimeType: AvatarImageMime; readonly extension: 'png' | 'jpg' | 'webp'; readonly width: number; readonly height: number }> {
  options?.signal?.throwIfAborted();
  const owned = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const workerCall = dispatchCpuImageTask<AvatarNormalizeWorkerOutput>(
    { type: 'image.normalizeAvatar', bytes: owned, mimeType },
    owned,
    options,
  );
  const result = workerCall !== undefined
    ? await workerCall
    : await executeAvatarNormalize({ bytes: owned, mimeType }, options?.signal);
  return { ...result, data: new Uint8Array(result.data) };
}

export async function readAvatarDimensions(
  data: Uint8Array,
  mimeType: AvatarImageMime,
  options?: ImageWorkerOptions,
): Promise<{ readonly width: number; readonly height: number }> {
  options?.signal?.throwIfAborted();
  const owned = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const workerCall = dispatchCpuImageTask<{ readonly width: number; readonly height: number }>(
    { type: 'image.dimensions', bytes: owned, mimeType },
    owned,
    options,
  );
  return workerCall !== undefined
    ? workerCall
    : executeImageDimensions({ bytes: owned, mimeType }, options?.signal);
}

export async function encodeImageAsPng(
  data: Uint8Array,
  mimeType: AvatarImageMime,
  options?: ImageWorkerOptions,
): Promise<Uint8Array> {
  options?.signal?.throwIfAborted();
  const owned = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const workerCall = dispatchCpuImageTask<ArrayBuffer>(
    { type: 'image.toPng', bytes: owned, mimeType },
    owned,
    options,
  );
  const out = workerCall !== undefined
    ? await workerCall
    : await executeImageToPng({ bytes: owned, mimeType }, options?.signal);
  return new Uint8Array(out);
}

type CropErrorKind =
  | 'empty'
  | 'unsupported_format'
  | 'region_invalid'
  | 'too_large'
  | 'out_of_bounds'
  | 'budget'
  | 'decode_failed';

interface CompressEventResult {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

function reportCompressEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly outcome: CompressOutcome;
    readonly startedAt: number;
    readonly inputMime: string;
    readonly exifTransposed: boolean;
    readonly result: CompressEventResult;
  },
): void {
  if (telemetry === undefined) return;
  try {
    telemetry.client.track('image_compress', {
      source: telemetry.source,
      outcome: input.outcome,
      input_mime: input.inputMime,
      output_mime: normalizeImageMime(input.result.mimeType),
      original_bytes: input.result.originalByteLength,
      final_bytes: input.result.finalByteLength,
      original_width: input.result.originalWidth,
      original_height: input.result.originalHeight,
      final_width: input.result.width,
      final_height: input.result.height,
      exif_transposed: input.exifTransposed,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {
  }
}

function reportCropEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly startedAt: number;
    readonly ok: boolean;
    readonly errorKind?: CropErrorKind;
    readonly result?: CropImageSuccess;
  },
): void {
  if (telemetry === undefined) return;
  try {
    const { result } = input;
    const originalPixels =
      result === undefined ? 0 : result.originalWidth * result.originalHeight;
    telemetry.client.track('image_crop', {
      source: telemetry.source,
      ok: input.ok,
      error_kind: input.errorKind,
      resized: result?.resized,
      original_width: result?.originalWidth,
      original_height: result?.originalHeight,
      region_area_ratio:
        result === undefined || originalPixels === 0
          ? undefined
          : (result.region.width * result.region.height) / originalPixels,
      final_bytes: result?.finalByteLength,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {
  }
}

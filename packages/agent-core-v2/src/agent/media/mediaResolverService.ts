import { createHash } from 'node:crypto';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IFlagService } from '#/app/flag/flag';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { ResolvedImagePolicy } from '#/kosong/provider/providerImagePolicy';
import { IBlobStore } from '#/persistence/interface/blobStore';

import './flag';
import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { compressImageForModel, IMAGE_BYTE_BUDGET } from './image-compress';
import {
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from './image-format-policy';
import {
  buildMediaPathTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';
import { IAgentMediaResolverService } from './mediaResolver';
import { createVideoUploader } from './registerMediaTools';
import {
  inlineVideoPart,
  inlineVideoSupportedForProtocol,
  isVideoUploadAuthError,
  isVideoUploadUnsupportedError,
} from './videoUpload';

const CACHE_SCOPE = 'video-upload-cache';
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';
const IMAGE_UNAVAILABLE_TEXT =
  '[image omitted: the uploaded file is no longer available]';
const IMAGE_MEMO_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MEMO_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const FLAGS_ENABLED = { enabled: () => true } as unknown as IFlagService;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const mediaResolvedKey = defineState<Map<string, ContentPart>>(
  'media.resolved',
  () => new Map(),
);

export class AgentMediaResolverService implements IAgentMediaResolverService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileService private readonly files: IFileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @IFlagService private readonly flags: IFlagService = FLAGS_ENABLED,
  ) {
    this.states.contributeState(mediaResolvedKey);
  }

  private get resolved(): Map<string, ContentPart> {
    return this.states.get(mediaResolvedKey);
  }

  private readonly imageMemo = new Map<
    string,
    { part: ContentPart; bytes: number; mimeType: string }
  >();
  private imageMemoBytes = 0;

  async resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    if (!messages.some(hasResolvableMediaPart)) return messages;

    let changed = false;
    const out: Message[] = [];
    for (const message of messages) {
      if (!hasResolvableMediaPart(message)) {
        out.push(message);
        continue;
      }
      const content: ContentPart[] = [];
      for (const part of message.content) {
        const daemonPart = daemonFileRefFromPart(part);
        const resolved =
          daemonPart?.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal)
            : daemonPart?.kind === 'image'
              ? await this.resolveImagePart(daemonPart.ref, requester, signal)
              : part.type === 'image_url'
                ? await this.resolveInlineImagePart(part, requester, signal)
                : part;
        content.push(resolved);
        changed ||= resolved !== part;
      }
      out.push(content.some((part, index) => part !== message.content[index])
        ? { ...message, content }
        : message);
    }
    return changed ? out : messages;
  }

  private displayPath(ref: DaemonFileRef): Promise<string | undefined> {
    return this.mediaStore.resolveDisplayPath(ref.fileId);
  }

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.image_in) {
      return degradedImage(await this.displayPath(ref));
    }
    const policy = imagePolicyFor(
      requester,
      this.flags.enabled('image_format_conversion'),
    );
    const cacheKey = `image\0${ref.fileId}\0${policy.convertUnsupported}`;
    const memoed = this.memoedImage(cacheKey, policy);
    if (memoed !== undefined) return memoed;
    const path = await this.displayPath(ref);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return degradedImage(path);
    }

    const fileType = detectFileType(
      source.filename,
      source.bytes.subarray(0, MEDIA_SNIFF_BYTES),
      'media',
    );
    if (fileType.kind !== 'image') return degradedImage(path);
    const resolved = await prepareImageBytes(
      source.bytes,
      normalizeImageMime(fileType.mimeType),
      policy,
      requester.model.providerType,
      signal,
    );
    if (resolved === undefined) return degradedImage(path);

    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:${resolved.mimeType};base64,${resolved.bytes.toString('base64')}` },
    };
    if (resolved.bytes.length <= IMAGE_MEMO_MAX_BYTES) {
      this.memoizeImage(cacheKey, part, resolved.bytes.length, resolved.mimeType);
    }
    return part;
  }

  private async resolveInlineImagePart(
    part: Extract<ContentPart, { type: 'image_url' }>,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.image_in) {
      return { type: 'text', text: '[Image omitted: the current model does not support image input.]' };
    }
    const policy = imagePolicyFor(
      requester,
      this.flags.enabled('image_format_conversion'),
    );
    const parsed = parseImageDataUrl(part.imageUrl.url);
    if (parsed === null) {
      if (isDataUrl(part.imageUrl.url)) {
        return { type: 'text', text: buildMalformedImageNotice(part.imageUrl.url) };
      }
      const unsupported = unsupportedImageMimeFromUrl(
        part.imageUrl.url,
        requester.model.providerType,
        policy.acceptedTypes,
      );
      if (unsupported === null) return part;
      return {
        type: 'text',
        text: buildUnsupportedImageNotice(
          unsupported,
          part.imageUrl.url,
          requester.model.providerType,
          policy.acceptedTypes,
        ),
      };
    }
    const mimeType = normalizeImageMime(
      resolveEffectiveImageMime(parsed.mimeType, decodeBase64Prefix(parsed.base64)),
    );
    if (isModelAcceptedImageMime(mimeType, requester.model.providerType, policy.acceptedTypes)) {
      const url = `data:${mimeType};base64,${parsed.base64}`;
      return url === part.imageUrl.url
        ? part
        : { type: 'image_url', imageUrl: { ...part.imageUrl, url } };
    }
    const source = Buffer.from(parsed.base64, 'base64');
    const resolved = await prepareImageBytes(
      source,
      mimeType,
      policy,
      requester.model.providerType,
      signal,
    );
    if (resolved === undefined) {
      return {
        type: 'text',
        text: buildUnsupportedImageNotice(
          mimeType,
          undefined,
          requester.model.providerType,
          policy.acceptedTypes,
        ),
      };
    }
    const url = `data:${resolved.mimeType};base64,${resolved.bytes.toString('base64')}`;
    return url === part.imageUrl.url
      ? part
      : { type: 'image_url', imageUrl: { ...part.imageUrl, url } };
  }

  private memoedImage(cacheKey: string, policy: ResolvedImagePolicy): ContentPart | undefined {
    const entry = this.imageMemo.get(cacheKey);
    if (entry === undefined) return undefined;
    if (!isModelAcceptedImageMime(entry.mimeType, undefined, policy.acceptedTypes)) return undefined;
    this.imageMemo.delete(cacheKey);
    this.imageMemo.set(cacheKey, entry);
    return entry.part;
  }

  private memoizeImage(
    cacheKey: string,
    part: ContentPart,
    bytes: number,
    mimeType: string,
  ): void {
    this.imageMemo.set(cacheKey, { part, bytes, mimeType });
    this.imageMemoBytes += bytes;
    for (const [key, entry] of this.imageMemo) {
      if (this.imageMemoBytes <= IMAGE_MEMO_MAX_TOTAL_BYTES) return;
      this.imageMemo.delete(key);
      this.imageMemoBytes -= entry.bytes;
    }
  }

  private async resolveVideoPart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    if (!model.capabilities.video_in) return videoTag(await this.displayPath(ref));
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `${ref.fileId}\0${providerKey}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return this.memoedOutcome(ref, memoed);

    const { part, memoize } = await this.resolveVideoUncached(ref, requester, cacheKey, signal);
    if (memoize) this.resolved.set(cacheKey, part);
    return part;
  }

  private async memoedOutcome(ref: DaemonFileRef, memoed: ContentPart): Promise<ContentPart> {
    if (memoed.type !== 'text') return memoed;
    const tag = matchSingleMediaPathTag(memoed.text);
    if (tag === undefined) return memoed;
    const path = await this.displayPath(ref);
    if (path === undefined || path === tag.path) return memoed;
    return { type: 'text', text: buildMediaPathTag(tag.kind, path) };
  }

  private async resolveVideoUncached(
    ref: DaemonFileRef,
    requester: ModelRequester,
    cacheKey: string,
    signal: AbortSignal | undefined,
  ): Promise<{ part: ContentPart; memoize: boolean }> {
    const cachedLlmFileId = await this.readCachedUpload(cacheKey);
    if (cachedLlmFileId !== undefined) {
      return {
        part: { type: 'video_url', videoUrl: { url: `ms://${cachedLlmFileId}`, id: cachedLlmFileId } },
        memoize: true,
      };
    }
    const tagPath = await this.displayPath(ref);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return { part: videoTag(tagPath), memoize: true };
    }

    const { bytes, filename } = source;
    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'video') return { part: videoTag(tagPath), memoize: true };
    const mimeType = fileType.mimeType;

    const model = requester.model;
    const inlineSupported = inlineVideoSupportedForProtocol(model.protocol);

    const uploader = createVideoUploader(requester, {
      client: this.telemetry,
      props: {
        model: model.name,
        provider_type: model.providerType ?? model.protocol,
        protocol: model.protocol,
      },
    });
    if (uploader === undefined) {
      return {
        part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(tagPath),
        memoize: true,
      };
    }

    try {
      const uploaded = await uploader({ data: bytes, mimeType, filename }, { signal });
      const llmFileId = uploaded.videoUrl.id ?? msFileIdFromUrl(uploaded.videoUrl.url);
      if (llmFileId !== undefined) await this.writeCachedUpload(cacheKey, llmFileId);
      return { part: uploaded, memoize: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isVideoUploadAuthError(error)) throw error;
      if (isVideoUploadUnsupportedError(error)) {
        return {
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(tagPath),
          memoize: true,
        };
      }
      return { part: videoTag(tagPath), memoize: false };
    }
  }

  private async readMedia(
    ref: DaemonFileRef,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
    try {
      signal?.throwIfAborted();
      const file = await this.files.get(ref.fileId);
      const bytes = await readStream(file.stream(), signal);
      return { bytes, filename: file.meta.name };
    } catch {
      signal?.throwIfAborted();
      const canonical = await this.mediaStore.read(ref.fileId);
      if (canonical === undefined) throw new Error(`media ${ref.fileId} is unavailable`);
      return { bytes: Buffer.from(canonical.data), filename: canonical.name };
    }
  }

  private async readCachedUpload(cacheKey: string): Promise<string | undefined> {
    const data = await this.blobs.get(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
    if (data === undefined) return undefined;
    const llmFileId = textDecoder.decode(data);
    return PROVIDER_ID_RE.test(llmFileId) ? llmFileId : undefined;
  }

  private async writeCachedUpload(cacheKey: string, llmFileId: string): Promise<void> {
    if (!PROVIDER_ID_RE.test(llmFileId)) return;
    await this.blobs.put(CACHE_SCOPE, blobKey(cacheKey), textEncoder.encode(llmFileId)).catch(
      () => undefined,
    );
  }
}

function hasResolvableMediaPart(message: Message): boolean {
  return message.content.some(
    (part) => part.type === 'image_url' || daemonFileRefFromPart(part) !== undefined,
  );
}

function imagePolicyFor(
  requester: ModelRequester,
  conversionEnabled: boolean,
): ResolvedImagePolicy {
  const configured = requester.model.imagePolicy;
  return conversionEnabled || configured.convertUnsupported === 'off'
    ? configured
    : { acceptedTypes: configured.acceptedTypes, convertUnsupported: 'off' };
}

function conversionOutputs(policy: ResolvedImagePolicy): ReadonlySet<string> {
  if (policy.convertUnsupported === 'png') return new Set(['image/png']);
  if (policy.convertUnsupported === 'jpeg') return new Set(['image/jpeg']);
  const outputs = new Set<string>();
  if (policy.acceptedTypes.has('image/png')) outputs.add('image/png');
  if (policy.acceptedTypes.has('image/jpeg')) outputs.add('image/jpeg');
  return outputs;
}

async function prepareImageBytes(
  bytes: Buffer,
  mimeType: string,
  policy: ResolvedImagePolicy,
  providerType: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ readonly bytes: Buffer; readonly mimeType: string } | undefined> {
  if (isModelAcceptedImageMime(mimeType, providerType, policy.acceptedTypes)) {
    return { bytes, mimeType };
  }
  if (policy.convertUnsupported === 'off') return undefined;
  signal?.throwIfAborted();
  const converted = await compressImageForModel(bytes, mimeType, {
    acceptedMimes: policy.acceptedTypes,
    outputMimes: conversionOutputs(policy),
    byteBudget: IMAGE_BYTE_BUDGET,
  });
  signal?.throwIfAborted();
  if (
    !converted.changed ||
    converted.finalByteLength > IMAGE_BYTE_BUDGET ||
    !isModelAcceptedImageMime(converted.mimeType, providerType, policy.acceptedTypes)
  ) {
    return undefined;
  }
  return { bytes: Buffer.from(converted.data), mimeType: normalizeImageMime(converted.mimeType) };
}

function degradedImage(path: string | undefined): ContentPart {
  if (path === undefined) return unavailableMediaText('image');
  return { type: 'text', text: buildMediaPathTag('image', path) };
}

function unavailableMediaText(kind: 'image' | 'video'): ContentPart {
  return { type: 'text', text: kind === 'video' ? VIDEO_UNAVAILABLE_TEXT : IMAGE_UNAVAILABLE_TEXT };
}

function videoTag(path: string | undefined): ContentPart {
  if (path === undefined) {
    return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
  }
  return { type: 'text', text: buildMediaPathTag('video', path) };
}

function msFileIdFromUrl(url: string): string | undefined {
  if (!url.startsWith('ms://')) return undefined;
  const id = url.slice('ms://'.length);
  return id.length > 0 ? id : undefined;
}

function blobKey(cacheKey: string): string {
  return createHash('sha256').update(cacheKey).digest('hex');
}

async function readStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
  const onAbort = (): void => {
    const reason = signal?.reason instanceof Error ? signal.reason : undefined;
    (stream as NodeJS.ReadableStream & { destroy?(error?: Error): void }).destroy?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk as string | Uint8Array));
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaResolverService,
  AgentMediaResolverService,
  ScopeActivation.OnScopeCreated,
  'media',
);

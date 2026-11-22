import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { Error2, ErrorCodes } from '#/errors';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MISSING_MEDIA_PLACEHOLDER } from '#/agent/blob/agentBlobService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { IFlagService } from '#/app/flag/flag';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { ResolvedImagePolicy } from '#/kosong/provider/providerImagePolicy';
import { mergeProviderRequestAuth } from '#/kosong/provider/bases/request-auth';
import { REQUEST_IDENTITY_RESERVED_HEADERS } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { IBlobStore } from '#/persistence/interface/blobStore';

import './flag';
import {
  compressAudioForModel,
  compressVideoForModel,
  resolveAvInlineByteBudget,
} from './av-compress';
import { detectFileType, MEDIA_SNIFF_BYTES, sniffMediaFromMagic } from './file-type';
import { validateMediaBytesIntegrity } from './mediaIntegrity';
import {
  compressImageForModel,
  IMAGE_BYTE_BUDGET,
  validateImageDataUrl,
} from './image-compress';
import {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  INVALID_IMAGE_DATA_URL_MESSAGE,
  normalizeImageMime,
  parseCompleteImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from './image-format-policy';
import {
  AUDIO_MIME_BY_SUFFIX,
  buildMediaPathTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
  type MediaBlobRef,
  parseMediaBlobRef,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';
import { IAgentMediaResolverService } from './mediaResolver';
import { IImageConfigBridge } from './imageConfigBridge';
import { createVideoUploader } from './registerMediaTools';
import {
  inlineVideoPart,
  inlineVideoSupportedForProtocol,
  isVideoUploadAuthError,
  isVideoUploadUnsupportedError,
} from './videoUpload';

const CACHE_SCOPE = 'video-upload-cache';
const AV_COMPRESS_CACHE_SCOPE = 'av-compress-cache';
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';
const VIDEO_UNSUPPORTED_TEXT =
  '[video omitted: the current model does not support video input]';
const VIDEO_CORRUPT_TEXT =
  '[video omitted: the file or media data is empty, corrupted, or incomplete]';
const IMAGE_UNAVAILABLE_TEXT =
  '[image omitted: the uploaded file is no longer available]';
const AUDIO_UNAVAILABLE_TEXT =
  '[audio omitted: inline audio is unavailable for this model request]';
const AUDIO_CORRUPT_TEXT =
  '[audio omitted: the file or media data is empty, corrupted, or incomplete]';
const POISONED_MEDIA_TEXT =
  '[media omitted: rejected by model provider as empty, corrupted, or unsupported]';
const AUDIO_BLOBREF_RE = /^blobref:(audio\/[A-Za-z0-9.+_*-]+);([0-9a-f]{64})$/u;
const AUDIO_MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
};
const SUPPORTED_AUDIO_MIMES = new Set(Object.values(AUDIO_MIME_BY_SUFFIX));
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
    @ref(IAgentScopeContext) private readonly agentScope?: LiveRef<IAgentScopeContext>,
    @ref(ICpuWorkerService) private readonly cpuWorkerRef?: LiveRef<ICpuWorkerService>,
    @ref(IImageConfigBridge) private readonly imageConfigRef?: LiveRef<IImageConfigBridge>,
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
  private readonly imageUploadUnsupported = new WeakSet<ModelRequester>();
  private readonly poisonedMedia = new Set<string>();

  markMediaPoisoned(urlsOrKeys: Iterable<string>): void {
    for (const urlOrKey of urlsOrKeys) {
      if (urlOrKey.length === 0) continue;
      this.poisonedMedia.add(poisonKey(urlOrKey));
    }
  }

  private isPoisoned(url: string): boolean {
    if (this.poisonedMedia.size === 0) return false;
    return this.poisonedMedia.has(poisonKey(url));
  }

  async resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
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
        const rawUrl = mediaPartUrl(part);
        if (rawUrl !== undefined && this.isPoisoned(rawUrl)) {
          content.push({ type: 'text', text: POISONED_MEDIA_TEXT });
          changed = true;
          continue;
        }
        const daemonPart = daemonFileRefFromPart(part);
        let resolved =
          daemonPart?.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal)
            : daemonPart?.kind === 'image'
              ? await this.resolveImagePart(daemonPart.ref, requester, signal, headers)
              : daemonPart?.kind === 'audio'
                ? await this.resolveAudioPart(daemonPart.ref, requester, signal)
                : part.type === 'image_url'
                  ? await this.resolveInlineImagePart(part, requester, signal)
                  : part.type === 'video_url'
                    ? await this.resolveInlineVideoPart(part, requester, signal)
                    : part.type === 'audio_url'
                      ? await this.resolveInlineAudioPart(part, requester, signal)
                      : part;
        const resolvedUrl = mediaPartUrl(resolved);
        if (resolvedUrl !== undefined && this.isPoisoned(resolvedUrl)) {
          resolved = { type: 'text', text: POISONED_MEDIA_TEXT };
        }
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

  private async resolveAudioPart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.audio_in) {
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    }
    const cacheKey = `audio\0${ref.fileId}\0${ref.fullResolution === true ? 'full' : 'auto'}`;
    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return memoed;
    try {
      signal?.throwIfAborted();
      const file = await this.mediaStore.open(ref.fileId, 'wav') ?? await this.mediaStore.open(ref.fileId);
      const mime = file === undefined ? undefined : normalizeAudioMime(file.mediaType);
      const type = mime !== undefined && SUPPORTED_AUDIO_MIMES.has(mime)
        ? mime : file && AUDIO_MIME_BY_SUFFIX[extname(file.name).toLowerCase()];
      if (file !== undefined && type !== undefined) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of file.stream()) {
          signal?.throwIfAborted();
          chunks.push(chunk);
        }
        const rawBytes = Buffer.concat(chunks);
        if (!validateMediaBytesIntegrity(rawBytes, type).valid) {
          return { type: 'text', text: AUDIO_CORRUPT_TEXT };
        }
        const prepared = ref.fullResolution === true
          ? { data: rawBytes, mimeType: type }
          : await this.prepareInlineAv('audio', rawBytes, type, signal);
        const part: ContentPart = {
          type: 'audio_url',
          audioUrl: {
            url: `data:${prepared.mimeType};base64,${Buffer.from(prepared.data).toString('base64')}`,
            name: file.name,
          },
        };
        this.resolved.set(cacheKey, part);
        return part;
      }
    } catch {
      signal?.throwIfAborted();
    }
    return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
  }

  private async resolveInlineAudioPart(
    part: Extract<ContentPart, { type: 'audio_url' }>,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.audio_in) {
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    }
    const url = part.audioUrl.url;
    if (url === MISSING_MEDIA_PLACEHOLDER) {
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    }
    if (url.startsWith('blobref:')) {
      const match = AUDIO_BLOBREF_RE.exec(url);
      if (match === null) {
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      const mime = normalizeAudioMime(match[1]!);
      if (!SUPPORTED_AUDIO_MIMES.has(mime)) {
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      signal?.throwIfAborted();
      const scope = this.agentScope?.current?.scope('blobs') ?? 'blobs';
      const bytes = await this.blobs.get(scope, match[2]!).catch(() => undefined);
      signal?.throwIfAborted();
      if (bytes === undefined) {
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      if (!validateMediaBytesIntegrity(bytes, mime).valid) {
        return { type: 'text', text: AUDIO_CORRUPT_TEXT };
      }
      return {
        type: 'audio_url',
        audioUrl: {
          ...part.audioUrl,
          url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
        },
      };
    }
    if (isDataUrl(url)) {
      const decoded = decodeValidatedBase64DataUrl(url);
      if (decoded === null) {
        return { type: 'text', text: AUDIO_CORRUPT_TEXT };
      }
      const mime = normalizeAudioMime(decoded.mimeType);
      const effectiveMime = resolveInlineAvIntegrityMime('audio', mime, decoded.bytes);
      if (effectiveMime === undefined || !validateMediaBytesIntegrity(decoded.bytes, effectiveMime).valid) {
        return { type: 'text', text: AUDIO_CORRUPT_TEXT };
      }
      const emittedMime = effectiveMime !== 'audio/octet-stream' ? effectiveMime : mime;
      if (emittedMime !== decoded.mimeType && SUPPORTED_AUDIO_MIMES.has(emittedMime)) {
        return {
          type: 'audio_url',
          audioUrl: { ...part.audioUrl, url: `data:${emittedMime};base64,${decoded.base64}` },
        };
      }
    }
    return part;
  }

  private async resolveInlineVideoPart(
    part: Extract<ContentPart, { type: 'video_url' }>,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.video_in) {
      return { type: 'text', text: VIDEO_UNSUPPORTED_TEXT };
    }
    const url = part.videoUrl.url;
    if (url === MISSING_MEDIA_PLACEHOLDER) {
      return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
    }
    if (url.startsWith('blobref:')) {
      const ref = parseMediaBlobRef(url);
      if (ref === undefined || (ref.kind === 'mime' && !ref.mime.startsWith('video/'))) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      signal?.throwIfAborted();
      const scope = resolveBlobScope(this.agentScope?.current, ref);
      const bytes = await this.blobs.get(scope, ref.hash).catch(() => undefined);
      signal?.throwIfAborted();
      if (bytes === undefined) {
        return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
      }
      let mimeType: string | undefined;
      if (ref.kind === 'mime') {
        mimeType = ref.mime;
      } else {
        const sniffed = sniffMediaFromMagic(bytes);
        mimeType = sniffed?.kind === 'video' ? sniffed.mimeType : undefined;
      }
      if (mimeType === undefined || !validateMediaBytesIntegrity(bytes, mimeType).valid) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      return {
        type: 'video_url',
        videoUrl: {
          ...part.videoUrl,
          url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
        },
      };
    }
    if (isDataUrl(url)) {
      const decoded = decodeValidatedBase64DataUrl(url);
      if (decoded === null) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      const effectiveMime = resolveInlineAvIntegrityMime('video', decoded.mimeType, decoded.bytes);
      if (effectiveMime === undefined || !validateMediaBytesIntegrity(decoded.bytes, effectiveMime).valid) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      if (effectiveMime !== 'video/octet-stream' && effectiveMime !== decoded.mimeType.trim().toLowerCase()) {
        return {
          type: 'video_url',
          videoUrl: { ...part.videoUrl, url: `data:${effectiveMime};base64,${decoded.base64}` },
        };
      }
      return part;
    }
    return part;
  }

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.image_in) {
      return degradedImage(await this.displayPath(ref));
    }
    const policy = imagePolicyFor(
      requester,
      this.flags.enabled('image_format_conversion'),
    );
    const cacheKey = `image\0${ref.fileId}\0${policy.convertUnsupported}`;
    const uploader = this.imageUploadUnsupported.has(requester) ? undefined : requester.uploadImage?.bind(requester);
    const memoed = uploader === undefined ? this.memoedImage(cacheKey, policy) : undefined;
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
      this.cpuWorkerRef?.current,
      this.imageConfigRef?.current?.maxEdgePx,
    );
    if (resolved === undefined) return degradedImage(path);
    if (uploader !== undefined) {
      const variant = `${cacheKey}\0${resolved.mimeType}`;
      const uploadKey = await imageUploadCacheKey(requester, variant, headers);
      const cachedFileId = uploadKey === undefined ? undefined : await this.readCachedUpload(uploadKey, 'image-upload-cache');
      try {
        const uploaded = await uploader({
          data: resolved.bytes,
          mimeType: resolved.mimeType,
          filename: source.filename,
        }, { signal, cachedFileId, headers });
        signal?.throwIfAborted();
        if (uploaded !== undefined) {
          const id = msFileIdFromUrl(uploaded.imageUrl.url);
          if (id !== undefined && PROVIDER_ID_RE.test(id)) {
            if (uploadKey !== undefined && uploadKey === await imageUploadCacheKey(requester, variant, headers)) {
              await this.writeCachedUpload(uploadKey, id, 'image-upload-cache');
            }
            return uploaded;
          }
        } else {
          this.imageUploadUnsupported.add(requester);
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (isVideoUploadAuthError(error)) throw error;
      }
    }

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
    if (part.imageUrl.url === MISSING_MEDIA_PLACEHOLDER) {
      return { type: 'text', text: IMAGE_UNAVAILABLE_TEXT };
    }
    const policy = imagePolicyFor(
      requester,
      this.flags.enabled('image_format_conversion'),
    );
    const validated = await validateImageDataUrl(part.imageUrl.url);
    if (validated === null) {
      if (isDataUrl(part.imageUrl.url)) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          parseCompleteImageDataUrl(part.imageUrl.url) === null
            ? INVALID_IMAGE_DATA_URL_MESSAGE
            : 'The image attachment has valid base64 data, but its image content could not be decoded. The image may be damaged or unsupported by the local decoder. Reattach it as PNG or JPEG and retry.',
          { details: { mediaType: 'image', urlLength: part.imageUrl.url.length } },
        );
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
      resolveEffectiveImageMime(validated.mimeType, decodeBase64Prefix(validated.base64)),
    );
    if (isModelAcceptedImageMime(mimeType, requester.model.providerType, policy.acceptedTypes)) {
      const url = `data:${mimeType};base64,${validated.base64}`;
      return url === part.imageUrl.url
        ? part
        : { type: 'image_url', imageUrl: { ...part.imageUrl, url } };
    }
    const source = validated.bytes;
    const resolved = await prepareImageBytes(
      source,
      mimeType,
      policy,
      requester.model.providerType,
      signal,
      this.cpuWorkerRef?.current,
      this.imageConfigRef?.current?.maxEdgePx,
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
    const previous = this.imageMemo.get(cacheKey);
    if (previous !== undefined) this.imageMemoBytes -= previous.bytes;
    this.imageMemo.delete(cacheKey);
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
    const mode = ref.fullResolution === true ? '\0full' : '';
    const cacheKey = `${ref.fileId}\0${providerKey}${mode}`;

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
    if (!validateMediaBytesIntegrity(bytes, mimeType).valid) {
      return { part: { type: 'text', text: VIDEO_CORRUPT_TEXT }, memoize: false };
    }

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
      if (!inlineSupported) return { part: videoTag(tagPath), memoize: true };
      const prepared = ref.fullResolution === true
        ? { data: bytes, mimeType }
        : await this.prepareInlineAv('video', bytes, mimeType, signal);
      return {
        part: inlineVideoPart(prepared.data, prepared.mimeType),
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
        if (!inlineSupported) return { part: videoTag(tagPath), memoize: true };
        const prepared = ref.fullResolution === true
          ? { data: bytes, mimeType }
          : await this.prepareInlineAv('video', bytes, mimeType, signal);
        return {
          part: inlineVideoPart(prepared.data, prepared.mimeType),
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

  private async prepareInlineAv(
    kind: 'video' | 'audio',
    bytes: Uint8Array,
    mimeType: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly data: Uint8Array; readonly mimeType: string }> {
    const budget = resolveAvInlineByteBudget();
    if (bytes.length <= budget) return { data: bytes, mimeType };
    const digest = createHash('sha256').update(bytes).digest('hex');
    const cacheKey = `${kind}\0${mimeType}\0${digest}\0${String(budget)}`;
    const cached = await this.readCachedCompressedAv(cacheKey);
    if (cached !== undefined && validateMediaBytesIntegrity(cached.data, cached.mimeType).valid) {
      return cached;
    }
    const compressed =
      kind === 'video'
        ? await compressVideoForModel(bytes, mimeType, { byteBudget: budget, signal })
        : await compressAudioForModel(bytes, mimeType, { byteBudget: budget, signal });
    if (compressed.changed) {
      if (!validateMediaBytesIntegrity(compressed.data, compressed.mimeType).valid) {
        return { data: bytes, mimeType };
      }
      await this.writeCachedCompressedAv(cacheKey, compressed.mimeType, compressed.data);
    }
    return { data: compressed.data, mimeType: compressed.mimeType };
  }

  private async readCachedCompressedAv(
    cacheKey: string,
  ): Promise<{ readonly data: Uint8Array; readonly mimeType: string } | undefined> {
    const raw = await this.blobs.get(AV_COMPRESS_CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
    if (raw === undefined || raw.length === 0) return undefined;
    const sep = raw.indexOf(0x0a);
    if (sep <= 0 || sep >= raw.length - 1) return undefined;
    const mimeType = textDecoder.decode(raw.subarray(0, sep));
    if (!mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) return undefined;
    return { mimeType, data: raw.subarray(sep + 1) };
  }

  private async writeCachedCompressedAv(
    cacheKey: string,
    mimeType: string,
    data: Uint8Array,
  ): Promise<void> {
    const header = textEncoder.encode(`${mimeType}\n`);
    const payload = new Uint8Array(header.length + data.length);
    payload.set(header, 0);
    payload.set(data, header.length);
    await this.blobs.put(AV_COMPRESS_CACHE_SCOPE, blobKey(cacheKey), payload).catch(() => undefined);
  }

  private async readCachedUpload(cacheKey: string, scope = CACHE_SCOPE): Promise<string | undefined> {
    const data = await this.blobs.get(scope, blobKey(cacheKey)).catch(() => undefined);
    if (data === undefined) return undefined;
    const llmFileId = textDecoder.decode(data);
    return PROVIDER_ID_RE.test(llmFileId) ? llmFileId : undefined;
  }

  private async writeCachedUpload(cacheKey: string, llmFileId: string, scope = CACHE_SCOPE): Promise<void> {
    if (!PROVIDER_ID_RE.test(llmFileId)) return;
    await this.blobs.put(scope, blobKey(cacheKey), textEncoder.encode(llmFileId)).catch(
      () => undefined,
    );
  }
}

function hasResolvableMediaPart(message: Message): boolean {
  return message.content.some(
    (part) =>
      part.type === 'image_url' ||
      part.type === 'video_url' ||
      part.type === 'audio_url' ||
      daemonFileRefFromPart(part) !== undefined,
  );
}

function mediaPartUrl(part: ContentPart): string | undefined {
  if (part.type === 'image_url') return part.imageUrl.url;
  if (part.type === 'video_url') return part.videoUrl.url;
  if (part.type === 'audio_url') return part.audioUrl.url;
  return undefined;
}

function poisonKey(urlOrKey: string): string {
  if (urlOrKey.length <= 256) return urlOrKey;
  return `sha256:${createHash('sha256').update(urlOrKey).digest('hex')}`;
}

function resolveBlobScope(
  agentScope: IAgentScopeContext | undefined,
  ref: MediaBlobRef,
): string {
  if (ref.kind === 'mime') {
    return agentScope?.scope('blobs') ?? 'blobs';
  }
  if (agentScope !== undefined) {
    if (agentScope.agentId === ref.agentId) return agentScope.scope('blobs');
    const current = agentScope.scope('blobs');
    const suffix = `/agents/${agentScope.agentId}/blobs`;
    if (current.endsWith(suffix)) {
      return `${current.slice(0, -suffix.length)}/agents/${ref.agentId}/blobs`;
    }
    if (current === `agents/${agentScope.agentId}/blobs`) {
      return `agents/${ref.agentId}/blobs`;
    }
  }
  return `agents/${ref.agentId}/blobs`;
}

function decodeValidatedBase64DataUrl(
  url: string,
): { readonly mimeType: string; readonly base64: string; readonly bytes: Buffer } | null {
  const match = /^data:([^;,]+)(?:;[^;,]+)*?;base64,(.*)$/si.exec(url);
  if (match === null) return null;
  const mimeType = match[1]!.trim();
  const base64 = match[2]!;
  if (base64.length === 0 || base64.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) return null;
  if (base64.includes('=') && base64.length % 4 !== 0) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) return null;
  return { mimeType, base64, bytes };
}

function normalizeAudioMime(raw: string): string {
  const base = (raw.split(';', 1)[0] ?? '').trim().toLowerCase();
  return AUDIO_MIME_ALIASES[base] ?? base;
}

function resolveInlineAvIntegrityMime(
  kind: 'audio' | 'video',
  declaredMime: string,
  bytes: Uint8Array,
): string | undefined {
  const normalized = (declaredMime.split(';', 1)[0] ?? '').trim().toLowerCase();
  const sniffed = sniffMediaFromMagic(bytes);
  if (sniffed !== null) {
    if (sniffed.kind === kind) return sniffed.mimeType;
    if (kind === 'audio' && sniffed.mimeType === 'video/mp4') return 'audio/mp4';
    if (kind === 'audio' && sniffed.mimeType === 'video/webm') return 'audio/webm';
    if (kind === 'video' && sniffed.mimeType === 'audio/mp4') return 'video/mp4';
    return undefined;
  }
  if (bytes.length >= 8) {
    const boxType = Buffer.from(bytes.subarray(4, 8)).toString('latin1');
    if (boxType === 'ftyp' || boxType === 'styp') {
      return kind === 'video' ? 'video/mp4' : 'audio/mp4';
    }
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return kind === 'video' ? 'video/webm' : 'audio/webm';
  }
  return normalized.startsWith(`${kind}/`) ? normalized : `${kind}/octet-stream`;
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
  cpuWorker: ICpuWorkerService | undefined,
  maxEdge?: number,
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
    maxEdge,
    cpuWorker,
    signal,
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

async function imageUploadCacheKey(
  requester: ModelRequester,
  variant: string,
  requestHeaders: Readonly<Record<string, string>> | undefined,
): Promise<string | undefined> {
  const model = requester.model;
  if (!model.baseUrl) return undefined;
  const auth = mergeProviderRequestAuth(await model.authProvider.getAuth?.(), requestHeaders);
  const headers = new Headers(model.headers);
  new Headers(auth?.headers).forEach((value, key) => { headers.set(key, value); });
  if (!auth?.apiKey && !headers.has('authorization') && !headers.has('x-api-key')) return undefined;
  const credentials = [...headers].filter(([key]) => !REQUEST_IDENTITY_RESERVED_HEADERS.has(key) && !key.startsWith('x-kiki-'));
  const identity = createHash('sha256').update(JSON.stringify({ apiKey: auth?.apiKey, headers: credentials.toSorted(([a], [b]) => a.localeCompare(b)) })).digest('hex');
  return JSON.stringify([variant, model.providerName, model.providerType, model.protocol, model.baseUrl, identity]);
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

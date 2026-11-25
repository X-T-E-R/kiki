import { createHash } from 'node:crypto';
import { extname } from 'node:path';

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
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  HOSTREF_PROTOCOL,
  HostPinnedSourceChangedError,
  openVerifiedHostPinnedStream,
  parseHostPinnedUrl,
  readHostPinnedRefRecord,
  statHostPinnedRef,
  verifyHostPinnedRef,
  type HostPinnedStatFingerprint,
} from './hostPinnedMedia';

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
  normalizeImageMime,
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
const IMAGE_UPLOAD_CACHE_SCOPE = 'image-upload-cache';
const AV_COMPRESS_CACHE_SCOPE = 'av-compress-cache';
const UPLOAD_CACHE_TTL_MS = 18 * 60 * 60 * 1000;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';
const VIDEO_UNSUPPORTED_TEXT =
  '[video omitted: the current model does not support video input]';
const VIDEO_CORRUPT_TEXT =
  '[video omitted: the file or media data is empty, corrupted, or incomplete]';
const IMAGE_UNAVAILABLE_TEXT =
  '[image omitted: the uploaded file is no longer available]';
const IMAGE_CORRUPT_TEXT =
  '[image omitted: the file or media data is empty, corrupted, or incomplete]';
const AUDIO_UNAVAILABLE_TEXT =
  '[audio omitted: inline audio is unavailable for this model request]';
const AUDIO_CORRUPT_TEXT =
  '[audio omitted: the file or media data is empty, corrupted, or incomplete]';
const POISONED_MEDIA_TEXT =
  '[media omitted: rejected by model provider as empty, corrupted, or unsupported]';
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
    @ref(IAtomicDocumentStore) private readonly documentsRef?: LiveRef<IAtomicDocumentStore>,
    @ref(ISessionContext) private readonly sessionRef?: LiveRef<ISessionContext>,
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
  private readonly uploadCacheByUrl = new Map<string, Set<string>>();
  private readonly evictedUploadCacheKeys = new Set<string>();
  private readonly memoKeysByUrl = new Map<string, Set<string>>();
  private readonly videoMemoExpiresAt = new Map<string, number>();
  private readonly hostPinnedStatMemo = new Map<string, HostPinnedStatFingerprint>();

  markMediaPoisoned(urlsOrKeys: Iterable<string>): void {
    for (const urlOrKey of urlsOrKeys) {
      if (urlOrKey.length === 0) continue;
      const key = poisonKey(urlOrKey);
      this.poisonedMedia.add(key);
      const cacheEntries = this.uploadCacheByUrl.get(key);
      if (cacheEntries !== undefined) {
        for (const entry of cacheEntries) {
          this.evictedUploadCacheKeys.add(entry);
          const sep = entry.indexOf('\0');
          if (sep > 0) {
            const scope = entry.slice(0, sep);
            const hashedKey = entry.slice(sep + 1);
            void this.blobs.delete(scope, hashedKey).catch(() => undefined);
          }
        }
        this.uploadCacheByUrl.delete(key);
      }
      const memoEntries = this.memoKeysByUrl.get(key);
      if (memoEntries !== undefined) {
        for (const entry of memoEntries) {
          const sep = entry.indexOf('\0');
          if (sep <= 0) continue;
          const kind = entry.slice(0, sep);
          const memoKey = entry.slice(sep + 1);
          if (kind === 'resolved') {
            this.resolved.delete(memoKey);
            this.videoMemoExpiresAt.delete(memoKey);
            this.hostPinnedStatMemo.delete(memoKey);
          } else if (kind === 'image') {
            const existing = this.imageMemo.get(memoKey);
            if (existing !== undefined) {
              this.imageMemoBytes -= existing.bytes;
              this.imageMemo.delete(memoKey);
            }
          }
        }
        this.memoKeysByUrl.delete(key);
      }
    }
  }

  private rememberUploadCache(urls: readonly (string | undefined)[], scope: string, hashedKey: string): void {
    const entry = `${scope}\0${hashedKey}`;
    this.evictedUploadCacheKeys.delete(entry);
    for (const url of urls) {
      if (url === undefined || url.length === 0) continue;
      const key = poisonKey(url);
      let entries = this.uploadCacheByUrl.get(key);
      if (entries === undefined) {
        entries = new Set<string>();
        this.uploadCacheByUrl.set(key, entries);
      }
      entries.add(entry);
    }
  }

  private rememberMemoKey(urls: readonly (string | undefined)[], kind: 'resolved' | 'image', cacheKey: string): void {
    const entry = `${kind}\0${cacheKey}`;
    for (const url of urls) {
      if (url === undefined || url.length === 0) continue;
      const key = poisonKey(url);
      let entries = this.memoKeysByUrl.get(key);
      if (entries === undefined) {
        entries = new Set<string>();
        this.memoKeysByUrl.set(key, entries);
      }
      entries.add(entry);
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
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal, rawUrl)
            : daemonPart?.kind === 'image'
              ? await this.resolveImagePart(daemonPart.ref, requester, signal, headers, rawUrl)
              : daemonPart?.kind === 'audio'
                ? await this.resolveAudioPart(daemonPart.ref, requester, signal, rawUrl)
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
    rawUrl: string | undefined,
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
      if (file !== undefined && file.size === 0) {
        return { type: 'text', text: AUDIO_CORRUPT_TEXT };
      }
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
        if (rawBytes.length === 0 || !validateMediaBytesIntegrity(rawBytes, type).valid) {
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
        this.rememberMemoKey([rawUrl, part.audioUrl.url], 'resolved', cacheKey);
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
    if (url.startsWith(HOSTREF_PROTOCOL)) {
      return this.resolveHostPinnedAudioPart(part, url, signal);
    }
    if (url.startsWith('blobref:')) {
      const ref = parseMediaBlobRef(url);
      if (ref === undefined || (ref.kind === 'mime' && !ref.mime.startsWith('audio/'))) {
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      signal?.throwIfAborted();
      const scope = resolveBlobScope(this.agentScope?.current, ref);
      const bytes = await this.blobs.get(scope, ref.hash);
      signal?.throwIfAborted();
      if (bytes === undefined) {
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      const rawMime = ref.kind === 'mime'
        ? ref.mime
        : detectFileType('audio.bin', bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media').mimeType;
      const mime = normalizeAudioMime(rawMime);
      if (!SUPPORTED_AUDIO_MIMES.has(mime)) {
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
    if (url.startsWith(HOSTREF_PROTOCOL)) {
      return this.resolveHostPinnedVideoPart(part, url, requester, signal);
    }
    if (url.startsWith('blobref:')) {
      const ref = parseMediaBlobRef(url);
      if (ref === undefined || (ref.kind === 'mime' && !ref.mime.startsWith('video/'))) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      signal?.throwIfAborted();
      const scope = resolveBlobScope(this.agentScope?.current, ref);
      const bytes = await this.blobs.get(scope, ref.hash);
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
      const model = requester.model;
      const uploader = createVideoUploader(requester, {
        client: this.telemetry,
        props: {
          model: model.name,
          provider_type: model.providerType ?? model.protocol,
          protocol: model.protocol,
        },
      });
      if (uploader !== undefined) {
        const providerKey = model.providerType ?? model.protocol;
        const uploadCacheKey = `blobref\0${ref.hash}\0${providerKey}`;
        const cachedUpload = await this.readCachedUpload(uploadCacheKey);
        if (cachedUpload !== undefined) {
          const uploadedUrl = `ms://${cachedUpload.llmFileId}`;
          this.rememberUploadCache([url, uploadedUrl], CACHE_SCOPE, blobKey(uploadCacheKey));
          return { type: 'video_url', videoUrl: { ...part.videoUrl, url: uploadedUrl, id: cachedUpload.llmFileId } };
        }
        try {
          const uploaded = await uploader({ data: Buffer.from(bytes), mimeType, filename: `${ref.hash}.mp4` }, { signal });
          const llmFileId = uploaded.videoUrl.id ?? msFileIdFromUrl(uploaded.videoUrl.url);
          if (llmFileId !== undefined) {
            await this.writeCachedUpload(uploadCacheKey, llmFileId, CACHE_SCOPE);
            this.rememberUploadCache([url, uploaded.videoUrl.url, `ms://${llmFileId}`], CACHE_SCOPE, blobKey(uploadCacheKey));
          }
          return uploaded;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (isVideoUploadAuthError(error)) throw error;
        }
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
    rawUrl: string | undefined,
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
    if (source.bytes.length === 0) {
      return { type: 'text', text: IMAGE_CORRUPT_TEXT };
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
      const cachedUpload = uploadKey === undefined ? undefined : await this.readCachedUpload(uploadKey, IMAGE_UPLOAD_CACHE_SCOPE);
      const cachedFileId = cachedUpload?.llmFileId;
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
              if (id !== cachedFileId) {
                await this.writeCachedUpload(uploadKey, id, IMAGE_UPLOAD_CACHE_SCOPE);
              }
              this.rememberUploadCache([rawUrl, uploaded.imageUrl.url], IMAGE_UPLOAD_CACHE_SCOPE, blobKey(uploadKey));
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
      this.rememberMemoKey([rawUrl, part.imageUrl.url], 'image', cacheKey);
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
    let effectivePart = part;
    if (part.imageUrl.url.startsWith('blobref:')) {
      const ref = parseMediaBlobRef(part.imageUrl.url);
      if (ref === undefined || (ref.kind === 'mime' && !ref.mime.startsWith('image/'))) {
        return { type: 'text', text: IMAGE_CORRUPT_TEXT };
      }
      signal?.throwIfAborted();
      const scope = resolveBlobScope(this.agentScope?.current, ref);
      const bytes = await this.blobs.get(scope, ref.hash);
      signal?.throwIfAborted();
      if (bytes === undefined) {
        return { type: 'text', text: IMAGE_UNAVAILABLE_TEXT };
      }
      if (bytes.length === 0) {
        return { type: 'text', text: IMAGE_CORRUPT_TEXT };
      }
      const sniffed = sniffMediaFromMagic(bytes);
      const declaredMime = ref.kind === 'mime' ? ref.mime : sniffed?.kind === 'image' ? sniffed.mimeType : undefined;
      if (declaredMime === undefined) {
        return { type: 'text', text: IMAGE_CORRUPT_TEXT };
      }
      const normalizedMime = normalizeImageMime(resolveEffectiveImageMime(declaredMime, bytes));
      effectivePart = {
        type: 'image_url',
        imageUrl: { ...part.imageUrl, url: `data:${normalizedMime};base64,${Buffer.from(bytes).toString('base64')}` },
      };
    }
    const validated = await validateImageDataUrl(effectivePart.imageUrl.url);
    if (validated === null) {
      if (isDataUrl(effectivePart.imageUrl.url)) {
        return { type: 'text', text: IMAGE_CORRUPT_TEXT };
      }
      const unsupported = unsupportedImageMimeFromUrl(
        effectivePart.imageUrl.url,
        requester.model.providerType,
        policy.acceptedTypes,
      );
      if (unsupported === null) return effectivePart;
      return {
        type: 'text',
        text: buildUnsupportedImageNotice(
          unsupported,
          effectivePart.imageUrl.url,
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
        : { type: 'image_url', imageUrl: { ...effectivePart.imageUrl, url } };
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
      : { type: 'image_url', imageUrl: { ...effectivePart.imageUrl, url } };
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
    rawUrl: string | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    if (!model.capabilities.video_in) return videoTag(await this.displayPath(ref));
    const providerKey = model.providerType ?? model.protocol;
    const mode = ref.fullResolution === true ? '\0full' : '';
    const cacheKey = `${ref.fileId}\0${providerKey}${mode}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) {
      const expiresAtMs = this.videoMemoExpiresAt.get(cacheKey);
      if (expiresAtMs !== undefined && Date.now() >= expiresAtMs) {
        this.resolved.delete(cacheKey);
        this.videoMemoExpiresAt.delete(cacheKey);
      } else if (memoed.type === 'video_url' && memoed.videoUrl.url.startsWith('ms://')) {
        const localState = await this.preflightLocalMedia(ref, signal);
        if (localState === 'ok') {
          return memoed;
        }
        this.resolved.delete(cacheKey);
        this.videoMemoExpiresAt.delete(cacheKey);
        void this.blobs.delete(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
        return localState === 'empty'
          ? { type: 'text', text: VIDEO_CORRUPT_TEXT }
          : videoTag(await this.displayPath(ref));
      } else {
        return this.memoedOutcome(ref, memoed);
      }
    }

    const { part, memoize, expiresAtMs } = await this.resolveVideoUncached(ref, requester, cacheKey, signal, rawUrl);
    if (memoize) {
      this.resolved.set(cacheKey, part);
      if (expiresAtMs !== undefined) {
        this.videoMemoExpiresAt.set(cacheKey, expiresAtMs);
      } else {
        this.videoMemoExpiresAt.delete(cacheKey);
      }
      this.rememberMemoKey([rawUrl, mediaPartUrl(part)], 'resolved', cacheKey);
    }
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

  private async preflightLocalMedia(
    ref: DaemonFileRef,
    signal: AbortSignal | undefined,
  ): Promise<'ok' | 'missing' | 'empty'> {
    signal?.throwIfAborted();
    try {
      const file = await this.files.get(ref.fileId);
      return file.meta.size > 0 ? 'ok' : 'empty';
    } catch {
      signal?.throwIfAborted();
    }
    const opened = await this.mediaStore.open(ref.fileId);
    if (opened !== undefined) return opened.size > 0 ? 'ok' : 'empty';
    const canonical = await this.mediaStore.read(ref.fileId);
    if (canonical === undefined) return 'missing';
    return canonical.data.length > 0 ? 'ok' : 'empty';
  }

  private async resolveVideoUncached(
    ref: DaemonFileRef,
    requester: ModelRequester,
    cacheKey: string,
    signal: AbortSignal | undefined,
    rawUrl: string | undefined,
  ): Promise<{ part: ContentPart; memoize: boolean; expiresAtMs?: number }> {
    const cachedUpload = await this.readCachedUpload(cacheKey);
    if (cachedUpload !== undefined) {
      const localState = await this.preflightLocalMedia(ref, signal);
      if (localState === 'ok') {
        const url = `ms://${cachedUpload.llmFileId}`;
        this.rememberUploadCache([rawUrl, url], CACHE_SCOPE, blobKey(cacheKey));
        return {
          part: { type: 'video_url', videoUrl: { url, id: cachedUpload.llmFileId } },
          memoize: true,
          expiresAtMs: cachedUpload.uploadedAtMs + UPLOAD_CACHE_TTL_MS,
        };
      }
      void this.blobs.delete(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
      if (localState === 'empty') {
        return { part: { type: 'text', text: VIDEO_CORRUPT_TEXT }, memoize: false };
      }
      return { part: videoTag(await this.displayPath(ref)), memoize: false };
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
    if (bytes.length === 0) {
      return { part: { type: 'text', text: VIDEO_CORRUPT_TEXT }, memoize: false };
    }
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
      let expiresAtMs: number | undefined;
      if (llmFileId !== undefined) {
        const uploadedAtMs = Date.now();
        await this.writeCachedUpload(cacheKey, llmFileId, CACHE_SCOPE, uploadedAtMs);
        expiresAtMs = uploadedAtMs + UPLOAD_CACHE_TTL_MS;
        this.rememberUploadCache([rawUrl, uploaded.videoUrl.url, `ms://${llmFileId}`], CACHE_SCOPE, blobKey(cacheKey));
      }
      return { part: uploaded, memoize: true, expiresAtMs };
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

  private async resolveHostPinnedAudioPart(
    part: Extract<ContentPart, { type: 'audio_url' }>,
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const parsed = parseHostPinnedUrl(url);
    const documents = this.documentsRef?.current;
    const session = this.sessionRef?.current;
    if (parsed === undefined || documents === undefined || session === undefined) {
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    }
    const record = await readHostPinnedRefRecord(documents, session.scope(), session.sessionId, parsed.refId);
    if (record === undefined || !record.mimeType.startsWith('audio/')) {
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    }
    const cacheKey = `hostref-audio:${record.refId}\0${record.sha256}`;
    const memoed = this.resolved.get(cacheKey);
    const cachedStat = this.hostPinnedStatMemo.get(cacheKey);
    if (memoed !== undefined && cachedStat !== undefined) {
      try {
        const currentStat = await statHostPinnedRef(record);
        signal?.throwIfAborted();
        if (
          currentStat.path === cachedStat.path &&
          currentStat.size === cachedStat.size &&
          currentStat.mtimeNs === cachedStat.mtimeNs &&
          currentStat.ino === cachedStat.ino
        ) {
          return memoed;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        this.resolved.delete(cacheKey);
        this.hostPinnedStatMemo.delete(cacheKey);
        return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      }
      this.resolved.delete(cacheKey);
      this.hostPinnedStatMemo.delete(cacheKey);
    }
    let opened: Awaited<ReturnType<typeof openVerifiedHostPinnedStream>> | undefined;
    try {
      opened = await openVerifiedHostPinnedStream(record, { signal });
      const chunks: Uint8Array[] = [];
      for await (const chunk of opened.stream) {
        signal?.throwIfAborted();
        chunks.push(chunk as Uint8Array);
      }
      const bytes = Buffer.concat(chunks);
      const mime = normalizeAudioMime(record.mimeType);
      if (!SUPPORTED_AUDIO_MIMES.has(mime) || !validateMediaBytesIntegrity(bytes, mime).valid) {
        return { type: 'text', text: AUDIO_CORRUPT_TEXT };
      }
      const resolvedPart: ContentPart = {
        type: 'audio_url',
        audioUrl: {
          ...part.audioUrl,
          url: `data:${mime};base64,${bytes.toString('base64')}`,
        },
      };
      const verifiedStat = await statHostPinnedRef(record).catch(() => undefined);
      if (verifiedStat !== undefined) {
        this.resolved.set(cacheKey, resolvedPart);
        this.hostPinnedStatMemo.set(cacheKey, verifiedStat);
        this.rememberMemoKey([url, mediaPartUrl(resolvedPart)], 'resolved', cacheKey);
      }
      return resolvedPart;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof HostPinnedSourceChangedError) return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
      return { type: 'text', text: AUDIO_UNAVAILABLE_TEXT };
    } finally {
      opened?.close();
    }
  }

  private async resolveHostPinnedVideoPart(
    part: Extract<ContentPart, { type: 'video_url' }>,
    url: string,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const parsed = parseHostPinnedUrl(url);
    const documents = this.documentsRef?.current;
    const session = this.sessionRef?.current;
    if (parsed === undefined || documents === undefined || session === undefined) {
      return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
    }
    const record = await readHostPinnedRefRecord(documents, session.scope(), session.sessionId, parsed.refId);
    if (record === undefined || !record.mimeType.startsWith('video/')) {
      return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
    }
    const model = requester.model;
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `hostref-video:${record.refId}\0${record.sha256}\0${providerKey}`;
    const memoed = this.resolved.get(cacheKey);
    const cachedStat = this.hostPinnedStatMemo.get(cacheKey);
    if (memoed !== undefined && cachedStat !== undefined) {
      const expiresAtMs = this.videoMemoExpiresAt.get(cacheKey);
      if (expiresAtMs !== undefined && Date.now() >= expiresAtMs) {
        this.resolved.delete(cacheKey);
        this.videoMemoExpiresAt.delete(cacheKey);
        this.hostPinnedStatMemo.delete(cacheKey);
      } else {
        try {
          const currentStat = await statHostPinnedRef(record);
          signal?.throwIfAborted();
          if (
            currentStat.path === cachedStat.path &&
            currentStat.size === cachedStat.size &&
            currentStat.mtimeNs === cachedStat.mtimeNs &&
            currentStat.ino === cachedStat.ino
          ) {
            return memoed;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          this.resolved.delete(cacheKey);
          this.videoMemoExpiresAt.delete(cacheKey);
          this.hostPinnedStatMemo.delete(cacheKey);
          void this.blobs.delete(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
          return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
        }
        this.resolved.delete(cacheKey);
        this.videoMemoExpiresAt.delete(cacheKey);
        this.hostPinnedStatMemo.delete(cacheKey);
      }
    }

    const cachedUpload = await this.readCachedUpload(cacheKey);
    if (cachedUpload !== undefined) {
      try {
        await verifyHostPinnedRef(record, signal);
        const verifiedStat = await statHostPinnedRef(record);
        signal?.throwIfAborted();
        const msUrl = `ms://${cachedUpload.llmFileId}`;
        const reused: ContentPart = {
          type: 'video_url',
          videoUrl: { ...part.videoUrl, url: msUrl, id: cachedUpload.llmFileId },
        };
        this.resolved.set(cacheKey, reused);
        this.videoMemoExpiresAt.set(cacheKey, cachedUpload.uploadedAtMs + UPLOAD_CACHE_TTL_MS);
        this.hostPinnedStatMemo.set(cacheKey, verifiedStat);
        this.rememberMemoKey([url, msUrl], 'resolved', cacheKey);
        this.rememberUploadCache([url, msUrl], CACHE_SCOPE, blobKey(cacheKey));
        return reused;
      } catch (error) {
        if (signal?.aborted) throw error;
        void this.blobs.delete(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
        if (error instanceof HostPinnedSourceChangedError) return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
      }
    }

    let opened: Awaited<ReturnType<typeof openVerifiedHostPinnedStream>> | undefined;
    try {
      opened = await openVerifiedHostPinnedStream(record, { signal });
      const chunks: Uint8Array[] = [];
      for await (const chunk of opened.stream) {
        signal?.throwIfAborted();
        chunks.push(chunk as Uint8Array);
      }
      const bytes = Buffer.concat(chunks);
      if (!validateMediaBytesIntegrity(bytes, record.mimeType).valid) {
        return { type: 'text', text: VIDEO_CORRUPT_TEXT };
      }
      const uploader = createVideoUploader(requester, {
        client: this.telemetry,
        props: {
          model: model.name,
          provider_type: model.providerType ?? model.protocol,
          protocol: model.protocol,
        },
      });
      let resolvedPart: ContentPart | undefined;
      let uploadedAtMs: number | undefined;
      if (uploader !== undefined) {
        try {
          resolvedPart = await uploader({ data: bytes, mimeType: record.mimeType, filename: `${record.refId}.mp4` }, { signal });
          if (resolvedPart.type === 'video_url' && resolvedPart.videoUrl.url.startsWith('ms://')) {
            const llmFileId = resolvedPart.videoUrl.id ?? resolvedPart.videoUrl.url.slice('ms://'.length);
            uploadedAtMs = Date.now();
            await this.writeCachedUpload(cacheKey, llmFileId, CACHE_SCOPE, uploadedAtMs);
            this.rememberUploadCache([url, resolvedPart.videoUrl.url], CACHE_SCOPE, blobKey(cacheKey));
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (isVideoUploadAuthError(error)) throw error;
        }
      }
      if (resolvedPart === undefined) {
        resolvedPart = {
          type: 'video_url',
          videoUrl: {
            ...part.videoUrl,
            url: `data:${record.mimeType};base64,${bytes.toString('base64')}`,
          },
        };
      }
      const verifiedStat = await statHostPinnedRef(record).catch(() => undefined);
      if (verifiedStat !== undefined) {
        this.resolved.set(cacheKey, resolvedPart);
        this.hostPinnedStatMemo.set(cacheKey, verifiedStat);
        if (uploadedAtMs !== undefined) {
          this.videoMemoExpiresAt.set(cacheKey, uploadedAtMs + UPLOAD_CACHE_TTL_MS);
        } else {
          this.videoMemoExpiresAt.delete(cacheKey);
        }
        this.rememberMemoKey([url, mediaPartUrl(resolvedPart)], 'resolved', cacheKey);
      }
      return resolvedPart;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof HostPinnedSourceChangedError) return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
      return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
    } finally {
      opened?.close();
    }
  }

  private async readCachedUpload(
    cacheKey: string,
    scope = CACHE_SCOPE,
  ): Promise<{ readonly llmFileId: string; readonly uploadedAtMs: number } | undefined> {
    const hashed = blobKey(cacheKey);
    if (this.evictedUploadCacheKeys.has(`${scope}\0${hashed}`)) return undefined;
    const data = await this.blobs.get(scope, hashed).catch(() => undefined);
    if (data === undefined) return undefined;
    try {
      const parsed = JSON.parse(textDecoder.decode(data)) as { llmFileId?: unknown; uploadedAtMs?: unknown };
      if (
        typeof parsed?.llmFileId === 'string' &&
        PROVIDER_ID_RE.test(parsed.llmFileId) &&
        typeof parsed.uploadedAtMs === 'number' &&
        Number.isFinite(parsed.uploadedAtMs)
      ) {
        const ageMs = Date.now() - parsed.uploadedAtMs;
        if (ageMs >= -60_000 && ageMs < UPLOAD_CACHE_TTL_MS) {
          return { llmFileId: parsed.llmFileId, uploadedAtMs: parsed.uploadedAtMs };
        }
      }
    } catch {
      void this.blobs.delete(scope, hashed).catch(() => undefined);
      return undefined;
    }
    void this.blobs.delete(scope, hashed).catch(() => undefined);
    return undefined;
  }

  private async writeCachedUpload(
    cacheKey: string,
    llmFileId: string,
    scope = CACHE_SCOPE,
    uploadedAtMs = Date.now(),
  ): Promise<void> {
    if (!PROVIDER_ID_RE.test(llmFileId)) return;
    const hashed = blobKey(cacheKey);
    this.evictedUploadCacheKeys.delete(`${scope}\0${hashed}`);
    const payload = JSON.stringify({ llmFileId, uploadedAtMs });
    await this.blobs.put(scope, hashed, textEncoder.encode(payload)).catch(
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

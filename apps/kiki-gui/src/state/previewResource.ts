/**
 * Pure preview resource model — classifies previewable items by content,
 * normalizes resource identity across path spellings vs. sent copies, gates
 * host-computer capabilities fail-closed, and derives the ordered action list
 * from origin, environment, and read state.
 */

import { basenameOf, joinPath } from '@kiki/session-core/composer/media';

export type PreviewResourceType =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'office'
  | 'table'
  | 'unsupported';

export type PreviewResourceSource =
  | { readonly kind: 'host-file'; readonly path: string }
  | {
      readonly kind: 'session-copy';
      readonly sessionId: string;
      readonly fileId: string;
      readonly sourceId?: string;
    }
  | { readonly kind: 'url'; readonly url: string };

export interface PreviewResourceOrigin {
  readonly path: string;
  readonly trusted: boolean;
}

export interface PreviewResource {
  readonly source: PreviewResourceSource;
  readonly origin?: PreviewResourceOrigin;
  readonly type: PreviewResourceType;
  readonly name?: string;
  readonly mime?: string;
}

export type PreviewResourceMutability = 'live' | 'copy';

export interface ClassifyResourceInput {
  readonly name?: string;
  readonly mime?: string;
  readonly head?: Uint8Array;
}

export interface KikiComputerConnection {
  readonly connectionSource?: string | null;
  readonly scopeId?: string;
  readonly spaceKey?: string;
  readonly config?: { readonly url?: string } | null;
}

export interface KikiComputerOptions {
  readonly pageUrl?: string;
}

export interface PreviewHostCapabilities {
  readonly reveal?: boolean;
  readonly open?: boolean;
  readonly write?: boolean;
  readonly saveDialog?: boolean;
}

export interface PreviewEnvironment {
  readonly isKikiComputer: boolean;
  readonly hasSession?: boolean;
  readonly phoneForm?: boolean;
  readonly capabilities: PreviewHostCapabilities;
}

export type PreviewReadStatus = 'loading' | 'ready' | 'failed';

export type PreviewReadFailureReason =
  | 'missing'
  | 'permission-denied'
  | 'folder'
  | 'remote-unreadable'
  | 'unsupported'
  | 'corrupted'
  | 'error';

export interface PreviewReadState {
  readonly status: PreviewReadStatus;
  readonly losslessUtf8?: boolean;
  readonly truncated?: boolean;
  readonly readableFromDevice?: boolean;
  readonly originalReadable?: boolean;
  readonly failureReason?: PreviewReadFailureReason;
}

export type ResourceActionId =
  | 'open-current-file'
  | 'rendered-source'
  | 'edit'
  | 'find-in-file'
  | 'download'
  | 'add-to-chat'
  | 'copy-content'
  | 'copy-path'
  | 'show-on-this-computer'
  | 'open-with-default-app'
  | 'open-in-browser'
  | 'reload';

export interface ResourceAction {
  readonly id: ResourceActionId;
  readonly zh: string;
  readonly en: string;
}

export interface LocalizedReason {
  readonly zh: string;
  readonly en: string;
}

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_ROOTED_RE = /^\/[A-Za-z]:[\\/]/u;
const UNC_RE = /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/u;
const FILE_URL_RE = /^file:\/\//iu;
const HTTP_URL_RE = /^https?:\/\//iu;
const RECOGNIZED_LOCAL_BROWSER_SOURCES = new Set([
  'deep-link',
  'stored',
  'manual',
  'local-detection',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
const TABLE_EXTS = new Set(['csv', 'tsv']);
const PDF_EXTS = new Set(['pdf']);
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'mpg', 'mpeg', '3gp', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'opus', 'flac', 'aac']);
const UNSUPPORTED_EXTS = new Set([
  'doc', 'xls', 'ppt', 'rtf',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'wasm', 'class', 'pyc', 'o', 'obj', 'a', 'lib',
  'dmg', 'iso', 'apk', 'ipa', 'msi',
]);
const TEXT_EXTS = new Set([
  'txt', 'log', 'json', 'jsonc', 'jsonl', 'ipynb', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'properties', 'lock',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'css', 'scss', 'less',
  'vue', 'svelte', 'astro', 'nix', 'zig', 'proto', 'prisma', 'tf', 'hcl', 'diff', 'patch', 'srt', 'vtt',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'swift', 'kt', 'kts', 'm', 'mm', 'php', 'pl', 'pm', 'r', 'lua', 'sql', 'graphql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'dockerfile', 'makefile', 'cmake', 'mk', 'gradle',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc',
]);
const KNOWN_EXTENSIONLESS_TEXT_NAMES = new Set([
  'dockerfile',
  'makefile',
  'gnumakefile',
  'cmake',
  'mk',
  'gradle',
  'rakefile',
  'gemfile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
  'brewfile',
  'justfile',
  'taskfile',
  'readme',
  'license',
  'licence',
  'copying',
  'changelog',
  'authors',
  'contributors',
  'notice',
  'codeowners',
  'hosts',
  'gitignore',
  'gitattributes',
  'gitmodules',
  'editorconfig',
  'npmrc',
  'nvmrc',
  'yarnrc',
  'dockerignore',
  'npmignore',
  'prettierignore',
  'eslintignore',
  'env',
  'bashrc',
  'zshrc',
  'profile',
  'inputrc',
  'vimrc',
  'gitconfig',
]);

const TEXT_LIKE_TYPES: ReadonlySet<PreviewResourceType> = new Set([
  'text',
  'markdown',
  'html',
  'table',
]);

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

export function resourceMutability(resource: Pick<PreviewResource, 'source'>): PreviewResourceMutability {
  return resource.source.kind === 'session-copy' ? 'copy' : 'live';
}

export function isLiveResource(resource: Pick<PreviewResource, 'source'>): boolean {
  return resourceMutability(resource) === 'live';
}

function trustedOriginPath(resource: PreviewResource): string | undefined {
  if (resource.source.kind === 'host-file') {
    if (resource.origin !== undefined) {
      return resource.origin.trusted ? resource.origin.path : undefined;
    }
    return resource.source.path;
  }
  if (resource.origin !== undefined && resource.origin.trusted) {
    return resource.origin.path;
  }
  return undefined;
}

function stripFileCitationSuffix(value: string): string {
  const colonMatch = /^(.*?):(\d+)(?::(\d+))?$/u.exec(value);
  if (colonMatch !== null && colonMatch[1] !== '') {
    return colonMatch[1]!;
  }
  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) return value;
  const pathPart = value.slice(0, hashIndex);
  const fragment = value.slice(hashIndex + 1);
  if (pathPart === '') return value;
  if (/^L\d+(?:C\d+|-L\d+)?$/u.test(fragment)) {
    return pathPart;
  }
  const base = basenameOf(pathPart);
  if (/\.(?:md|markdown|mdx)$/iu.test(base) && fragment !== '') {
    return pathPart;
  }
  return value;
}

function parseFileUrlPath(value: string): string | undefined {
  if (!FILE_URL_RE.test(value)) return undefined;
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  const suffixIndex = [hashIndex, queryIndex].filter((i) => i >= 0).toSorted((a, b) => a - b)[0];
  const urlPart = suffixIndex === undefined ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === undefined ? '' : value.slice(suffixIndex);
  try {
    const parsed = new URL(urlPart);
    let path = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:\//u.test(path)) path = path.slice(1);
    if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
      path = `//${parsed.hostname}${path}`;
    }
    if (path === '') return undefined;
    return stripFileCitationSuffix(`${path}${suffix}`);
  } catch {
    return undefined;
  }
}

function normalizeAbsoluteSlashesAndDots(path: string): string {
  const forward = path.replaceAll('\\', '/');
  const uncMatch = /^\/\/([^/]+)\/([^/]+)(.*)$/u.exec(forward);
  if (uncMatch !== null) {
    const host = uncMatch[1]!;
    const share = uncMatch[2]!;
    const rest = uncMatch[3] ?? '';
    const stack: string[] = [];
    for (const seg of rest.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(seg);
    }
    return `//${host}/${share}${stack.length > 0 ? `/${stack.join('/')}` : ''}`;
  }
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/u.exec(forward);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!;
    const rest = driveMatch[2] ?? '/';
    const stack: string[] = [];
    for (const seg of rest.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(seg);
    }
    return `${drive}/${stack.join('/')}`;
  }
  if (forward.startsWith('/')) {
    const stack: string[] = [];
    for (const seg of forward.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(seg);
    }
    return `/${stack.join('/')}`;
  }
  return forward;
}

/**
 * Normalize a host file path (absolute, relative to `cwd`, `file://` URL,
 * Windows/POSIX slashes, `.`/`..` segments, and `:line` / `#L` / `#heading`
 * citations) into a canonical path string.
 */
export function normalizeHostFilePath(rawPath: string, cwd?: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '') return '';
  let path = parseFileUrlPath(trimmed) ?? stripFileCitationSuffix(trimmed);
  if (WINDOWS_ROOTED_RE.test(path)) path = path.slice(1);
  if (WINDOWS_ABS_RE.test(path) || UNC_RE.test(path) || path.startsWith('/')) {
    return normalizeAbsoluteSlashesAndDots(path);
  }
  if (cwd !== undefined && cwd.trim() !== '') {
    const cleanCwd = WINDOWS_ROOTED_RE.test(cwd.trim()) ? cwd.trim().slice(1) : cwd.trim();
    return normalizeAbsoluteSlashesAndDots(joinPath(cleanCwd, path));
  }
  return path.replaceAll('\\', '/');
}

function hostFileIdentityPath(rawPath: string, cwd?: string): string {
  const normalized = normalizeHostFilePath(rawPath, cwd);
  if (/^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Compute the tab/resource identity key. Live host files share a key across
 * equivalent path spellings; session copies use sessionId + fileId + sourceId;
 * live files and copies always produce distinct keys.
 */
export function previewResourceKey(resource: Pick<PreviewResource, 'source'>, cwd?: string): string {
  const { source } = resource;
  if (source.kind === 'host-file') {
    return `file:${hostFileIdentityPath(source.path, cwd)}`;
  }
  if (source.kind === 'session-copy') {
    const sourceSuffix =
      source.sourceId === undefined || source.sourceId === ''
        ? ''
        : `:${encodeURIComponent(source.sourceId)}`;
    return `attachment:${encodeURIComponent(source.sessionId)}:${encodeURIComponent(source.fileId)}${sourceSuffix}`;
  }
  return `url:${source.url}`;
}

function hasBinarySignatureOrControls(head: Uint8Array): boolean {
  if (
    head.length >= 4 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    return true;
  }
  for (let i = 0; i < head.length; i += 1) {
    const byte = head[i]!;
    if (byte === 0x00 || byte === 0x7f) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return true;
    }
  }
  return false;
}

/** Whether `head` decodes losslessly as UTF-8 text without binary control bytes. */
export function isLosslessUtf8Bytes(head: Uint8Array): boolean {
  if (hasBinarySignatureOrControls(head)) return false;
  try {
    utf8FatalDecoder.decode(head);
    return true;
  } catch {
    return false;
  }
}

function sniffMagicType(head: Uint8Array | undefined): PreviewResourceType | undefined {
  if (head === undefined || head.length === 0) return undefined;
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return 'unsupported';
  }
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    return 'pdf';
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'image';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image';
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return 'image';
  }
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return 'image';
  }
  return undefined;
}

function splitNameParts(name: string | undefined): { readonly base: string; readonly ext: string } {
  if (name === undefined) return { base: '', ext: '' };
  const cleaned = name.split(/[?#]/u, 1)[0] ?? '';
  const base = basenameOf(cleaned);
  if (base === '') return { base: '', ext: '' };
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return { base, ext: '' };
  return { base, ext: base.slice(dot + 1).toLowerCase() };
}

function classifyByExtension(ext: string): PreviewResourceType | undefined {
  if (ext === '') return undefined;
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  if (TABLE_EXTS.has(ext)) return 'table';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (UNSUPPORTED_EXTS.has(ext)) return 'unsupported';
  return undefined;
}

function classifyByMime(mime: string | undefined): PreviewResourceType | undefined {
  if (mime === undefined) return undefined;
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalized === '' || normalized === 'application/octet-stream') return undefined;
  if (normalized === 'text/html' || normalized === 'application/xhtml+xml') return 'html';
  if (normalized === 'text/markdown' || normalized === 'text/x-markdown') return 'markdown';
  if (normalized === 'text/csv' || normalized === 'text/tab-separated-values' || normalized === 'application/csv') return 'table';
  if (normalized === 'application/pdf') return 'pdf';
  if (
    normalized === 'application/msword' ||
    normalized === 'application/vnd.ms-excel' ||
    normalized === 'application/vnd.ms-powerpoint'
  ) {
    return 'unsupported';
  }
  if (
    normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'office';
  }
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('text/') || normalized === 'application/json' || normalized === 'application/xml' || normalized.endsWith('+json')) {
    return 'text';
  }
  return undefined;
}

/**
 * Unified resource type classifier. Extension takes precedence over a
 * conflicting declared MIME; extension-less files are `text` only when the
 * filename is a known text filename AND `head` decodes losslessly as UTF-8.
 */
export function classifyResource(input: ClassifyResourceInput): PreviewResourceType {
  const { base, ext } = splitNameParts(input.name);
  const byExt = classifyByExtension(ext);
  if (byExt !== undefined) return byExt;

  const magic = sniffMagicType(input.head);
  if (ext === '' && base !== '') {
    const normalizedBase = base.toLowerCase().replace(/^\.+/u, '');
    if (KNOWN_EXTENSIONLESS_TEXT_NAMES.has(normalizedBase)) {
      if (magic === 'unsupported') return 'unsupported';
      return input.head !== undefined && isLosslessUtf8Bytes(input.head) ? 'text' : 'unsupported';
    }
    const byMime = classifyByMime(input.mime);
    if (byMime !== undefined && byMime !== 'text') return byMime;
    if (magic !== undefined && magic !== 'pdf') return magic;
    return 'unsupported';
  }

  const byMime = classifyByMime(input.mime);
  if (byMime !== undefined) return byMime;
  if (magic !== undefined) return magic;
  return 'unsupported';
}

function isLoopbackIpv4(hostname: string): boolean {
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (match === null) return false;
  return [match[1], match[2], match[3]].every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '[::1]' || host === '::1') return true;
    return isLoopbackIpv4(host);
  } catch {
    return false;
  }
}

/**
 * Fail-closed check for whether the current GUI device is the computer running
 * Kiki. True only for a non-remote desktop connection or a loopback browser
 * connection; false for ssh, direct:peer, remote spaces, app-shell,
 * web-cookie, null/undefined, or any unrecognized connection source.
 */
export function isKikiComputer(
  connection: KikiComputerConnection | null | undefined,
  options?: KikiComputerOptions,
): boolean {
  if (connection === null || connection === undefined) return false;
  if (connection.scopeId?.startsWith('ssh:') || connection.scopeId === 'direct:peer') return false;
  if (connection.connectionSource === 'remote') return false;
  if (connection.spaceKey?.startsWith('remote:')) return false;

  const source = connection.connectionSource;
  if (source === undefined || source === null) return false;
  if (source === 'desktop') return true;
  if (!RECOGNIZED_LOCAL_BROWSER_SOURCES.has(source)) return false;

  const targetUrl = connection.config?.url?.trim();
  if (targetUrl === undefined) return false;
  if (targetUrl === '') {
    return options?.pageUrl !== undefined && isLoopbackHttpUrl(options.pageUrl);
  }
  return isLoopbackHttpUrl(targetUrl);
}

/**
 * Returns the short read-only reason shown in the header when the desktop
 * could normally edit a live host text file, but cannot because of its bytes
 * or truncation.
 */
export function resourceReadOnlyReason(
  resource: PreviewResource,
  environment: PreviewEnvironment,
  readState: PreviewReadState,
): LocalizedReason | undefined {
  if (
    resource.source.kind !== 'host-file' ||
    !environment.isKikiComputer ||
    environment.capabilities.write !== true ||
    readState.status !== 'ready'
  ) {
    return undefined;
  }
  if (TEXT_LIKE_TYPES.has(resource.type)) {
    if (readState.losslessUtf8 === false) {
      return { zh: '只读：不是 UTF-8 文本', en: 'Read-only: not UTF-8 text' };
    }
    if (readState.truncated === true) {
      return { zh: '只读：文件过大', en: 'Read-only: file too large' };
    }
    return undefined;
  }
  if (resource.type === 'unsupported') {
    if (readState.losslessUtf8 === false) {
      return { zh: '只读：不是 UTF-8 文本', en: 'Read-only: not UTF-8 text' };
    }
    if (readState.truncated === true) {
      return { zh: '只读：文件过大', en: 'Read-only: file too large' };
    }
    return { zh: '只读：未知文件类型', en: 'Read-only: unknown file type' };
  }
  return undefined;
}

/**
 * Derive the ordered list of applicable actions for a preview resource given
 * its origin, environment, and current read state. Inapplicable actions are
 * omitted (no disabled or no-op entries).
 */
export function resourceActions(
  resource: PreviewResource,
  environment: PreviewEnvironment,
  readState: PreviewReadState,
): readonly ResourceAction[] {
  const actions: ResourceAction[] = [];
  const originalPath = trustedOriginPath(resource);
  const isCopy = resource.source.kind === 'session-copy';
  const isHostFile = resource.source.kind === 'host-file';
  const isHttpUrl = resource.source.kind === 'url' && HTTP_URL_RE.test(resource.source.url);
  const ready = readState.status === 'ready';
  const isTextLike = TEXT_LIKE_TYPES.has(resource.type);
  const bytesReadable = ready && readState.readableFromDevice !== false;
  const originalReadable =
    originalPath !== undefined &&
    (readState.originalReadable ?? (isHostFile ? ready : ready));

  if (isCopy && originalReadable) {
    actions.push({
      id: 'open-current-file',
      zh: '打开现在的文件',
      en: 'Open current file',
    });
  }

  if (ready && (resource.type === 'markdown' || resource.type === 'html')) {
    actions.push({
      id: 'rendered-source',
      zh: '渲染 / 源码',
      en: 'Rendered / Source',
    });
  }

  if (
    isHostFile &&
    environment.isKikiComputer &&
    environment.capabilities.write === true &&
    ready &&
    isTextLike &&
    readState.losslessUtf8 === true &&
    readState.truncated !== true
  ) {
    actions.push({
      id: 'edit',
      zh: '编辑',
      en: 'Edit',
    });
  }

  if (ready && (resource.type === 'text' || resource.type === 'markdown' || resource.type === 'table')) {
    actions.push({
      id: 'find-in-file',
      zh: '文件内查找',
      en: 'Find in file',
    });
  }

  if (bytesReadable) {
    actions.push({
      id: 'download',
      zh: '下载',
      en: 'Download',
    });
  }

  if (environment.hasSession === true && originalReadable) {
    actions.push({
      id: 'add-to-chat',
      zh: '加入对话',
      en: 'Add to chat',
    });
  }

  if (ready && isTextLike && readState.truncated !== true) {
    actions.push({
      id: 'copy-content',
      zh: '复制内容',
      en: 'Copy content',
    });
  }

  if (originalPath !== undefined) {
    actions.push({
      id: 'copy-path',
      zh: '复制路径',
      en: 'Copy path',
    });
  }

  if (originalPath !== undefined && environment.isKikiComputer && environment.capabilities.reveal === true) {
    actions.push({
      id: 'show-on-this-computer',
      zh: '在这台电脑上显示',
      en: 'Show on this computer',
    });
  }

  if (originalPath !== undefined && environment.isKikiComputer && environment.capabilities.open === true) {
    actions.push({
      id: 'open-with-default-app',
      zh: isCopy ? '打开原文件' : '以默认程序打开',
      en: isCopy ? 'Open original file' : 'Open with default app',
    });
  }

  if (isHttpUrl) {
    actions.push({
      id: 'open-in-browser',
      zh: '在浏览器打开',
      en: 'Open in browser',
    });
  }

  if (isHostFile || isHttpUrl) {
    actions.push({
      id: 'reload',
      zh: '重新读取',
      en: 'Reload',
    });
  }

  return actions;
}

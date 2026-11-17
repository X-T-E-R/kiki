import type { ImIdentity } from '@kiki/protocol';

export interface CompactIdentifierOptions {
  readonly head?: number;
  readonly tail?: number;
  readonly minDigits?: number;
}

const IM_PROTOCOL_SUFFIX_RE = /^([^@\s]+)@(?:im\.wechat|chatroom|s\.whatsapp\.net|broadcast|g\.us)$/i;
const SESSION_PREFIX_RE = /^session[_-]([0-9a-f]{8}-[0-9a-f-]{12,}|[A-Za-z0-9_-]{12,})$/i;
const WORKSPACE_SLUG_HASH_RE = /^wd_([a-z0-9_-]+?)_([0-9a-f]{8,})$/i;
const WORKSPACE_HASH_ONLY_RE = /^wd_([0-9a-f]{8,})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_DIGITS_RE = /^(-?)(\d+)$/;
const IPV4_HOST_PORT_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/;
const IPV6_BRACKET_RE = /^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/;
const HOSTNAME_PORT_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?::\d{1,5})?$/;
const PREFIXED_OPAQUE_RE = /^(oc_|ou_|on_|om_|cli_|wxid_|ghp_|gho_|ghu_|ghs_|ghr_|sk-proj-|sk-|xox[bpas]-|sha256:)(.+)$/i;
const HEX_RUN_RE = /(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{10,}/;
const MIXED_CASE_ALNUM_RUN_RE = /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{12,}/;
const UPPER_ALNUM_RUN_RE = /(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{16,}/;
const LONG_DIGIT_RUN_RE = /\d{8,}/;

/** Middle-ellipsize by Unicode code points when longer than head + tail + 1. */
export function compactMiddle(value: string, head = 4, tail = 4): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const chars = Array.from(trimmed);
  if (chars.length <= head + tail + 1) return trimmed;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

function looksOpaqueToken(token: string): boolean {
  if (UUID_RE.test(token)) return true;
  if (HEX_RUN_RE.test(token)) return true;
  if (MIXED_CASE_ALNUM_RUN_RE.test(token)) return true;
  if (UPPER_ALNUM_RUN_RE.test(token)) return true;
  if (LONG_DIGIT_RUN_RE.test(token)) return true;
  return false;
}

function isReadableNetworkHost(value: string): boolean {
  if (IPV4_HOST_PORT_RE.test(value) || IPV6_BRACKET_RE.test(value)) return true;
  if (!HOSTNAME_PORT_RE.test(value)) return false;
  const hostPart = value.replace(/:\d{1,5}$/, '');
  return hostPart.split('.').every((label) => label.length <= 32 && !looksOpaqueToken(label));
}

/**
 * Compact raw machine IDs, protocol JIDs, session UUIDs, and long numeric
 * account/chat/credential IDs into `head…tail` while leaving human names,
 * normal emails, and short slugs intact.
 */
export function compactIdentifier(raw: string | null | undefined, options?: CompactIdentifierOptions): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  const head = options?.head ?? 4;
  const tail = options?.tail ?? 4;
  const minDigits = options?.minDigits ?? 8;

  // Human labels with whitespace or non-ASCII characters (e.g. CJK names) stay intact.
  if (/\s/u.test(trimmed) || /[^\x20-\x7E]/u.test(trimmed)) {
    return trimmed;
  }

  // Strip noisy IM transport suffixes such as `@im.wechat` or `@chatroom`.
  const imMatch = IM_PROTOCOL_SUFFIX_RE.exec(trimmed);
  if (imMatch !== null) {
    return compactIdentifier(imMatch[1], options);
  }

  // Session IDs (`session_<uuid>` -> `ffc0…a63d`).
  const sessionMatch = SESSION_PREFIX_RE.exec(trimmed);
  if (sessionMatch !== null) {
    return compactMiddle(sessionMatch[1]!, head, tail);
  }

  // Workspace IDs (`wd_<slug>_<hash>` or `wd_<hash>`).
  const wsSlugMatch = WORKSPACE_SLUG_HASH_RE.exec(trimmed);
  if (wsSlugMatch !== null) {
    const slug = wsSlugMatch[1]!;
    const hash = wsSlugMatch[2]!;
    return `${compactMiddle(slug, 8, 4)} · ${hash.slice(0, 4)}…`;
  }
  const wsHashMatch = WORKSPACE_HASH_ONLY_RE.exec(trimmed);
  if (wsHashMatch !== null) {
    return `wd_${compactMiddle(wsHashMatch[1]!, head, tail)}`;
  }

  // Long numeric / signed numeric IDs (Telegram chat/account IDs, QQ uin, etc.).
  const digitsMatch = SIGNED_DIGITS_RE.exec(trimmed);
  if (digitsMatch !== null) {
    const sign = digitsMatch[1]!;
    const digits = digitsMatch[2]!;
    if (digits.length < minDigits) return trimmed;
    const digitEnds = digits.length <= 9 ? 3 : Math.min(head, tail, 4);
    return `${sign}${compactMiddle(digits, digitEnds, digitEnds)}`;
  }

  // Standard IPv4 / IPv6 (with optional :port) and readable domain/hostnames stay intact.
  if (isReadableNetworkHost(trimmed)) {
    return trimmed;
  }

  // Normal emails / Matrix handles (`user@example.test`, `@team:example.test`).
  const atIndex = trimmed.indexOf('@');
  if (atIndex >= 0) {
    if (atIndex === 0) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 1) {
        const local = trimmed.slice(1, colonIdx);
        const domain = trimmed.slice(colonIdx + 1);
        return local.length >= 20 && looksOpaqueToken(local)
          ? `@${compactMiddle(local, head, tail)}:${domain}`
          : trimmed;
      }
    } else {
      const local = trimmed.slice(0, atIndex);
      const domain = trimmed.slice(atIndex + 1);
      if (local.length >= 20 && looksOpaqueToken(local)) {
        return `${compactMiddle(local, head, tail)}@${domain}`;
      }
      return trimmed;
    }
  }

  // Recognizable platform / secret prefixes (`oc_`, `ou_`, `sk-`, `sha256:`, etc.).
  const prefixMatch = PREFIXED_OPAQUE_RE.exec(trimmed);
  if (prefixMatch !== null) {
    const rawPrefix = prefixMatch[1]!;
    const body = prefixMatch[2]!;
    if (body.length > head + tail + 1 && (looksOpaqueToken(body) || body.length >= 16)) {
      const normalizedPrefix = rawPrefix.toLowerCase() === 'sk-proj-' ? 'sk-' : rawPrefix;
      return `${normalizedPrefix}${compactMiddle(body, head, tail)}`;
    }
    return trimmed;
  }

  // UUIDs and other long opaque single-token identifiers.
  if (trimmed.length >= 14 && looksOpaqueToken(trimmed)) {
    return compactMiddle(trimmed, head, tail);
  }

  return trimmed;
}

/** Compact a session ID when no human session title is available. */
export function compactSessionId(sessionId: string | null | undefined): string {
  if (typeof sessionId !== 'string') return '';
  const trimmed = sessionId.trim();
  if (trimmed === '') return '';
  const sessionMatch = SESSION_PREFIX_RE.exec(trimmed);
  if (sessionMatch !== null) {
    return compactMiddle(sessionMatch[1]!, 4, 4);
  }
  if (UUID_RE.test(trimmed)) {
    return compactMiddle(trimmed, 4, 4);
  }
  return compactIdentifier(trimmed);
}

/**
 * Prefer a real human session title; fall back to a compact session identifier
 * only when the session has no title or has been deleted.
 */
export function formatSessionOwnerLabel(
  sessionId: string | null | undefined,
  sessionTitle: string | null | undefined,
  unknownFallback = '',
): string {
  const cleanId = sessionId?.trim() ?? '';
  const cleanTitle = sessionTitle?.trim() ?? '';
  if (cleanTitle !== '' && cleanTitle !== cleanId) {
    return cleanTitle;
  }
  if (cleanId !== '') {
    return compactSessionId(cleanId);
  }
  return unknownFallback;
}

/**
 * Return a trimmed IM display name only when it is genuinely human-readable
 * rather than a copy of `chat_id`/`sender_id` or another opaque machine ID.
 */
export function humanIdentityName(
  candidate: string | null | undefined,
  rawIds: readonly string[] = [],
): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  if (trimmed === '') return undefined;
  if (rawIds.some((id) => id !== '' && id === trimmed)) return undefined;
  if (compactIdentifier(trimmed) !== trimmed) return undefined;
  return trimmed;
}

export interface ImIdentityDisplay {
  /** Main human-first title (never repeats the same ID on `secondary`). */
  readonly primary: string;
  /** Compact channel/topic metadata, omitted when `primary` already shows the raw ID. */
  readonly secondary: string | undefined;
  /** Full uncompacted string for hover `title` tooltips. */
  readonly fullTitle: string;
}

export function formatImIdentityDisplay(
  identity: Pick<ImIdentity, 'chat_id' | 'sender_id'> & Partial<Pick<ImIdentity, 'topic_id' | 'chat_title' | 'sender_name' | 'topic_title' | 'chat_kind'>>,
  options?: { readonly topicPrefix?: string },
): ImIdentityDisplay {
  const chatId = identity.chat_id.trim();
  const senderId = identity.sender_id.trim();
  const rawEndpointIds = [chatId, senderId];
  const chatTitle = humanIdentityName(identity.chat_title, rawEndpointIds);
  const senderName = humanIdentityName(identity.sender_name, rawEndpointIds);
  const topicId = identity.topic_id?.trim();
  const hasTopic = topicId !== undefined && topicId !== '' && topicId !== '0';
  const topicTitle = hasTopic ? humanIdentityName(identity.topic_title, [topicId]) : undefined;
  const topicPrefix = options?.topicPrefix ?? 'topic:';
  const compactTopic = hasTopic ? `${topicPrefix}${compactIdentifier(topicId)}` : undefined;

  const compactChat = compactIdentifier(chatId);
  const compactSender = compactIdentifier(senderId);
  const sameRawEndpoint = senderId === '' || chatId === senderId;

  const fullParts = [
    chatTitle,
    senderName !== undefined && senderName !== chatTitle ? senderName : undefined,
    chatId,
    !sameRawEndpoint ? senderId : undefined,
    hasTopic ? (topicTitle ? `${topicTitle} (${topicPrefix}${topicId})` : `${topicPrefix}${topicId}`) : undefined,
  ].filter((part): part is string => part !== undefined && part !== '');
  const fullTitle = fullParts.join(' · ');

  if (chatTitle !== undefined) {
    const primary = [
      chatTitle,
      senderName !== undefined && senderName !== chatTitle ? senderName : undefined,
      topicTitle,
    ].filter((part): part is string => part !== undefined && part !== '').join(' · ');
    const secondary = hasTopic && topicTitle === undefined
      ? `${compactChat} / ${compactTopic}`
      : compactChat;
    return { primary, secondary: secondary || undefined, fullTitle };
  }

  if (senderName !== undefined) {
    const primary = [senderName, topicTitle]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ');
    const secondary = hasTopic && topicTitle === undefined
      ? `${compactChat} / ${compactTopic}`
      : compactChat;
    return { primary, secondary: secondary || undefined, fullTitle };
  }

  const primary = sameRawEndpoint
    ? (hasTopic ? `${compactChat} / ${compactTopic}` : compactChat)
    : [compactChat, compactSender, topicTitle ?? compactTopic]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ');

  return {
    primary,
    secondary: undefined,
    fullTitle,
  };
}

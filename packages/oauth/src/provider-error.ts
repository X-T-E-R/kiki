/**
 * Credential-safe provider errors.
 *
 * A provider endpoint (or the fetch implementation itself) can echo the
 * credential it just received back in an error message: an invalid API key
 * containing an internal newline fails the runtime's own request-header
 * validation, and undici's `TypeError` quotes the offending header value in
 * full. Vendor error bodies are no safer — they routinely repeat the
 * `Authorization` header, the request URL (userinfo / query credentials), or
 * the key itself when it is "invalid".
 *
 * Anything that turns a provider failure into a message for logs, the CLI, or
 * the daemon must funnel through {@link sanitizeProviderError}: it strips known
 * credential values (raw, trimmed, internal-newline, and encoded forms),
 * sensitive headers, URL userinfo and sensitive query values, and control
 * characters. `assertProviderHeaders` complements it on the request side: it
 * rejects a credential/header value that the fetch implementation would
 * otherwise quote back, before the request is dispatched.
 *
 * No dependency on `agent-core` or the SDK — hosts import these helpers from
 * `@kiki/oauth`.
 */

import { isRecord } from './utils';

const REDACTED = '[redacted]';
const UNKNOWN_ERROR = 'Unknown provider error.';

/**
 * Credentials at least this long are redacted wherever they appear, in literal
 * and encoded forms. Shorter values are still redacted — the caller declared
 * them as the credential it just sent — but only as whole tokens, so a
 * one-character key cannot rewrite every word of the message. Their encoded
 * forms are skipped entirely: an encoded two-character string is a generic
 * alphanumeric run that would corrupt unrelated text.
 */
const MIN_SECRET_LENGTH = 8;

/** Shortest opaque token replaced after a `Bearer` / `Basic` style prefix. */
const MIN_AUTH_TOKEN_LENGTH = 6;

/** Header / query-parameter / env names whose value is always a credential. */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'auth',
  'auth-token',
  'api-key',
  'api_key',
  'apikey',
  'key',
  'access-key',
  'access_key',
  'secret-key',
  'secret_key',
  'token',
  'access-token',
  'access_token',
  'refresh-token',
  'refresh_token',
  'id-token',
  'id_token',
  'secret',
  'client-secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'signature',
  'sig',
  'credential',
  'credentials',
  'cookie',
  'set-cookie',
  'session',
  'session-id',
  'session_id',
]);

const SENSITIVE_NAME_PATTERN =
  /(?:^|[-_])(?:api[-_]?key|apikey|token|secret|password|passwd|pwd|credential|authorization|signature|cookie)(?:$|[-_])/;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** `Bearer <opaque>` / `Basic <opaque>` literals the vendor may quote back. */
const AUTH_LITERAL_PATTERN = new RegExp(
  String.raw`\b(Bearer|Basic|Token|ApiKey|Api-Key)\s+[A-Za-z0-9\-._~+/=]{${String(MIN_AUTH_TOKEN_LENGTH)},}`,
  'gi',
);

/** `https://user:pass@host` → `https://[redacted]@host`. */
const URL_USERINFO_PATTERN = /(\/\/)[^/?#\s@]*@/g;

/** Same match, capturing the userinfo value for use as a secret. */
const URL_USERINFO_VALUE_PATTERN = /\/\/([^/?#\s@]*)@/;

/**
 * `?api_key=…&x=1` → `?api_key=[redacted]&x=1` (value ends at `&` / `#`).
 * Group 1 is the `?name=` prefix, group 2 the value.
 */
function sensitiveQueryPattern(): RegExp {
  return new RegExp(
    String.raw`([?&](?:${[...SENSITIVE_NAMES].map(escapeRegExp).join('|')})=)([^&#\s"']*)`,
    'gi',
  );
}

export interface ProviderErrorSanitizeOptions {
  /** Credential values to strip from the message. */
  readonly secrets?: readonly (string | null | undefined)[];
  /** Convenience alias for a single credential; merged into `secrets`. */
  readonly apiKey?: string | null;
  /**
   * Request URL. Redacted in the message, and its own credential material
   * (userinfo, sensitive query values) is additionally stripped wherever it
   * appears in the message.
   */
  readonly baseUrl?: string | null;
  /**
   * Headers sent with the failed request. Sensitive values (Authorization,
   * `*api*key*`, `*token*`, …) are redacted wholesale.
   */
  readonly headers?: Readonly<Record<string, unknown>>;
  /**
   * Environment bag (e.g. `process.env`). Values of credential-shaped names
   * (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …) are stripped as well.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderCredentialCheck {
  readonly ok: boolean;
  /** Present when `ok` is false; never contains the credential itself. */
  readonly reason?: string;
}

/** A record of header values, or an entry iterable such as `Headers`. */
export type ProviderHeaderInput =
  | Readonly<Record<string, unknown>>
  | Iterable<readonly [string, unknown]>;

/** True when a header / query-parameter / env name carries a credential. */
export function isSensitiveProviderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_NAMES.has(lower) || SENSITIVE_NAME_PATTERN.test(lower);
}

/**
 * Redact credential material from a provider error before it reaches a log,
 * a status payload, or the user.
 *
 * Credentials come from `secrets` / `apiKey`, from credential-shaped header and
 * env entries, and from the credential material inside `baseUrl` (userinfo and
 * sensitive query values). Each is stripped in the form the provider may have
 * echoed it: as sent, trimmed, newline-collapsed, JSON-escaped, or percent- /
 * base64- / hex-encoded.
 *
 * `error` may be an `Error`, a thrown string, or a thrown record; only its
 * message is used — nested `cause` chains are deliberately not walked so the
 * result cannot leak transport details of a rejected credential, and no cause
 * is attached to anything this module returns.
 */
export function sanitizeProviderError(
  error: unknown,
  options: ProviderErrorSanitizeOptions = {},
): string {
  let text = errorText(error);
  for (const secret of collectSecretForms(options)) {
    text = redactSecret(text, secret);
  }
  text = redactUrls(text);
  text = text.replace(AUTH_LITERAL_PATTERN, `$1 ${REDACTED}`);
  text = redactHeaderPairs(text, options.headers);
  text = normalizeWhitespace(text);
  return text.length > 0 ? text : UNKNOWN_ERROR;
}

/**
 * Redact credential material from a single URL: userinfo (`user:pass@`) and
 * sensitive query values. Works on unparseable URLs too, and leaves the rest
 * of the URL byte-for-byte intact.
 */
export function sanitizeProviderUrl(url: string): string {
  return url
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(sensitiveQueryPattern(), `$1${REDACTED}`);
}

/**
 * Copy of a header bag safe to log: sensitive values (and every value whose
 * name looks credential-shaped) become `[redacted]`.
 */
export function sanitizeProviderHeaders(
  headers: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveProviderName(name) ? REDACTED : String(value);
  }
  return out;
}

/**
 * Validate an API key / access token before it is embedded in a request.
 *
 * Rejects non-strings, blank values, and values containing control characters:
 * an internal newline is not a legal header value, and the fetch
 * implementation quotes the whole value in the resulting `TypeError`.
 */
export function validateProviderCredential(credential: unknown): ProviderCredentialCheck {
  if (typeof credential !== 'string') {
    return { ok: false, reason: 'provider credential must be a string.' };
  }
  if (credential.trim().length === 0) {
    return { ok: false, reason: 'provider credential must not be blank.' };
  }
  if (CONTROL_CHARS.test(credential)) {
    return {
      ok: false,
      reason:
        'provider credential contains control characters (a newline makes the request header invalid).',
    };
  }
  return { ok: true };
}

/**
 * Validate one header value before dispatch. The reason names the header only —
 * never its value — so surfacing the failure cannot leak the credential.
 */
export function validateProviderHeader(name: string, value: unknown): ProviderCredentialCheck {
  if (typeof value !== 'string') {
    return { ok: false, reason: `request header "${name}" must be a string.` };
  }
  if (CONTROL_CHARS.test(value)) {
    return {
      ok: false,
      reason:
        `request header "${name}" contains control characters (a newline makes the request invalid).`,
    };
  }
  return { ok: true };
}

/**
 * Throws on the first header whose value the fetch implementation would reject
 * and quote back. Call sites run this immediately before `fetch(...)` so the
 * credential never reaches the runtime's header validation.
 */
export function assertProviderHeaders(headers: ProviderHeaderInput): void {
  const entries: Iterable<readonly [string, unknown]> = isIterable(headers)
    ? headers
    : Object.entries(headers);
  for (const [name, value] of entries) {
    const check = validateProviderHeader(name, value);
    if (!check.ok) throw new Error(check.reason);
  }
}

/**
 * Throws on a credential the fetch implementation would reject and quote back
 * in its own `TypeError`. The reason describes the problem only; the credential
 * itself never appears in it. Call sites run this before building the request
 * headers, so the value never reaches the header at all.
 */
export function assertProviderCredential(credential: unknown): void {
  const check = validateProviderCredential(credential);
  if (!check.ok) throw new Error(check.reason);
}

// ── internals ─────────────────────────────────────────────────────────

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = error['message'];
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error) ?? '';
    } catch {
      return '';
    }
  }
  if (error === undefined || error === null) return '';
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  if (typeof error === 'symbol') return error.toString();
  return '';
}

/**
 * Replace one credential form. Long forms are replaced wherever they appear;
 * short ones only as whole tokens, so a one-character credential cannot rewrite
 * every word of the message.
 */
function redactSecret(text: string, secret: string): string {
  if (secret.length >= MIN_SECRET_LENGTH) return text.replaceAll(secret, REDACTED);
  const tokenPattern = new RegExp(
    String.raw`(^|[^A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`,
    'g',
  );
  return text.replace(tokenPattern, `$1${REDACTED}`);
}

function collectSecretForms(options: ProviderErrorSanitizeOptions): string[] {
  const values: string[] = [];
  for (const value of credentialValues(options)) {
    const forms = secretForms(value);
    values.push(...forms.literal);
    if (forms.literal.some((form) => form.length >= MIN_SECRET_LENGTH)) {
      values.push(...forms.encoded);
    }
  }

  const forms = new Set<string>();
  for (const value of values) {
    if (value.length > 0) forms.add(value);
  }
  // Longest first so an encoded variant of a key is not partially consumed by
  // a shorter prefix before its own literal is replaced.
  return [...forms].toSorted((a, b) => b.length - a.length);
}

/** Every credential value the options declare, including the ones inside `baseUrl`. */
function credentialValues(options: ProviderErrorSanitizeOptions): string[] {
  const values: string[] = [];
  if (typeof options.apiKey === 'string') values.push(options.apiKey);
  for (const secret of options.secrets ?? []) {
    if (typeof secret === 'string') values.push(secret);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (typeof value === 'string' && isSensitiveProviderName(name)) values.push(value);
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined && isSensitiveProviderName(name)) values.push(value);
  }
  values.push(...urlCredentialValues(options.baseUrl));
  return values;
}

/**
 * Credential material carried by a request URL: the userinfo pair (and its two
 * halves) and every sensitive query value. These are stripped from the message
 * even when the message echoes only the credential, not the whole URL.
 */
function urlCredentialValues(url: string | null | undefined): string[] {
  if (typeof url !== 'string' || url.length === 0) return [];
  const values: string[] = [];
  const userinfo = URL_USERINFO_VALUE_PATTERN.exec(url)?.[1];
  if (userinfo !== undefined && userinfo.length > 0) {
    values.push(userinfo);
    const separator = userinfo.indexOf(':');
    if (separator >= 0) {
      values.push(userinfo.slice(0, separator), userinfo.slice(separator + 1));
    }
  }
  for (const match of url.matchAll(sensitiveQueryPattern())) {
    const value = match[2];
    if (value !== undefined && value.length > 0) values.push(value);
  }
  return values.flatMap((value) => {
    try { return [value, decodeURIComponent(value.replaceAll('+', ' '))]; }
    catch { return [value]; }
  });
}

/**
 * Every shape a credential can take in a message: as configured, trimmed, with
 * an internal newline collapsed to a space or removed, with it escaped the way
 * a JSON rendering would, and percent- / base64- / hex-encoded.
 */
function secretForms(value: string): { literal: string[]; encoded: string[] } {
  const literal = new Set<string>([value]);
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    literal.add(trimmed);
    const collapsed = trimmed.replaceAll(/\s+/g, ' ');
    if (collapsed.length > 0) literal.add(collapsed);
    const stripped = trimmed.replaceAll(/\s+/g, '');
    if (stripped.length > 0) literal.add(stripped);
    const jsonEscaped = JSON.stringify(trimmed).slice(1, -1);
    if (jsonEscaped.length > 0) literal.add(jsonEscaped);
  }

  const encoded: string[] = [];
  for (const form of literal) {
    if (form.length === 0) continue;
    encoded.push(
      encodeURIComponent(form),
      encodeURI(form),
      Buffer.from(form, 'utf8').toString('base64'),
      Buffer.from(form, 'utf8').toString('base64url'),
      Buffer.from(form, 'utf8').toString('hex'),
    );
  }
  return { literal: [...literal].filter((form) => form.length > 0), encoded };
}

function redactUrls(text: string): string {
  const withUrls = text.replaceAll(
    /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi,
    (url) => sanitizeProviderUrl(url),
  );
  // Also catch query values the URL match above did not cover (truncated URLs,
  // relative request paths, bare `?api_key=…` diagnostics).
  return withUrls.replace(sensitiveQueryPattern(), `$1${REDACTED}`);
}

function redactHeaderPairs(
  text: string,
  headers: Readonly<Record<string, unknown>> | undefined,
): string {
  const names = new Set<string>([...SENSITIVE_NAMES].filter((name) => name !== 'key'));
  for (const name of Object.keys(headers ?? {})) {
    if (isSensitiveProviderName(name)) names.add(name);
  }
  let out = text;
  for (const name of names) {
    // The name may be bare (`x-api-key: …`) or a quoted property (`"x-api-key": "…"`),
    // which is how a JSON-rendered error body or header dump reports it.
    const pattern = new RegExp(
      String.raw`(["']?${escapeRegExp(name)}["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic|Token|ApiKey|Api-Key)\s+[^\s,;&#"']+|[^\s,;&#"']+)`,
      'gi',
    );
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}

function normalizeWhitespace(text: string): string {
  return text.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

function isIterable(value: unknown): value is Iterable<readonly [string, unknown]> {
  if (typeof value !== 'object' || value === null) return false;
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof iterator === 'function';
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

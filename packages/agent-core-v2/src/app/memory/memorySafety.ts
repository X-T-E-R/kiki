export function redactMemorySecrets(input: string): string {
  return input
    .replace(/-----BEGIN (?:[\w ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[\w ]+ )?PRIVATE KEY-----/g, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|key)=)[^&\s"'`]{8,}/gi, '$1[REDACTED_SECRET]')
    .replace(
      /(?<![?&])([\w-]*(?:api[_-]?key|token|secret|passw(?:or)?d|credential))\b(["']?\s*[:=]\s*)(?:"((?:\\[\s\S]|[^"\\]){8,})"|'((?:\\[\s\S]|[^'\\]){8,})'|([^\s"',}\]]{8,}))/gi,
      (_match, key: string, sep: string, dq?: string, sq?: string) => (
        dq !== undefined ? `${key}${sep}"[REDACTED_SECRET]"` : sq !== undefined ? `${key}${sep}'[REDACTED_SECRET]'` : `${key}${sep}[REDACTED_SECRET]`
      ),
    );
}

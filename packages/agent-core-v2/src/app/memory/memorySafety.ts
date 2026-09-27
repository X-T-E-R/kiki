export function redactMemorySecrets(input: string): string {
  return input
    .replace(/-----BEGIN (?:[\w ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[\w ]+ )?PRIVATE KEY-----/g, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/\b(api[_-]?key|token|secret|password|credential)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi, '$1$2$3[REDACTED_SECRET]');
}

const SHA256_RE = /^[0-9a-fA-F]{64}$/;

export interface ParsedPluginInstallArgs {
  readonly source: string;
  readonly sha256?: string;
  readonly trust: boolean;
}

export function parsePluginInstallArgs(raw: string): ParsedPluginInstallArgs {
  let rest = raw.trim();
  let trust = false;
  let sha256: string | undefined;
  for (;;) {
    if (rest === '--trust') {
      trust = true;
      rest = '';
      break;
    }
    if (rest.startsWith('--trust ')) {
      trust = true;
      rest = rest.slice('--trust '.length).trimStart();
      continue;
    }
    if (rest === '--sha256' || rest.startsWith('--sha256 ')) {
      const after = rest === '--sha256' ? '' : rest.slice('--sha256 '.length).trimStart();
      const token = /^(\S+)/.exec(after)?.[1] ?? '';
      if (!SHA256_RE.test(token)) {
        throw new Error('Usage: /plugins install [--trust] [--sha256 <64-hex>] <local-path-or-url>');
      }
      const digest = token.toLowerCase();
      if (sha256 !== undefined && sha256 !== digest) {
        throw new Error('Usage: /plugins install [--trust] [--sha256 <64-hex>] <local-path-or-url>');
      }
      sha256 = digest;
      rest = after.slice(token.length).trimStart();
      continue;
    }
    break;
  }
  return { source: rest, sha256, trust };
}

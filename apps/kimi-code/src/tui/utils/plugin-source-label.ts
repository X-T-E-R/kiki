import type { PluginSummary } from '@kiki/node-sdk';

export const OFFICIAL_BADGE = 'official';
export const CURATED_BADGE = 'curated';
export const THIRD_PARTY_BADGE = 'third-party';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

// Trusted plugin artifact hosts come in .com / .ai region pairs. Both host
// families are trusted regardless of the current region — a zip served by
// either deployment is still an official build.
const CODE_CDN_HOSTS = new Set(['code.kimi.com', 'code.kimi.ai']);
const CONTENT_CDN_HOSTS = new Set(['cdn.kimi.com', 'cdn.kimi.ai']);

/**
 * Human-readable provenance label for a plugin, suitable for inline display
 * in `/plugins` overviews and lists.
 *
 * - github source → `github <owner>/<repo>@<ref>`
 * - zip-url with parseable URL → `via <host[:port]>`
 * - everything else → raw source kind (`local-path`, `zip-url`)
 */
export function formatPluginSourceLabel(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github ${plugin.github.owner}/${plugin.github.repo}@${plugin.github.ref.value}`;
  }
  if (plugin.source === 'zip-url' && plugin.originalSource !== undefined) {
    const host = hostFromUrl(plugin.originalSource);
    if (host !== undefined) return `via ${host}`;
  }
  return plugin.source;
}

/**
 * Labels recognized official locations: Kiki plugin Release ZIPs and the retained
 * Kimi CDN paths. A manifest id alone does not establish provenance.
 */
export function pluginTrustLabel(plugin: PluginSummary): PluginTrustLabel {
  if (plugin.source !== 'zip-url' || plugin.originalSource === undefined) {
    return 'third-party';
  }
  try {
    const url = new URL(plugin.originalSource);
    if (isOfficialPluginUrl(url)) {
      return 'official';
    }
    if (
      url.protocol === 'https:' &&
      CODE_CDN_HOSTS.has(url.hostname) &&
      url.pathname.startsWith('/kimi-code/plugins/curated/')
    ) {
      return 'curated';
    }
    return 'third-party';
  } catch {
    return 'third-party';
  }
}

/**
 * Recognizes HTTPS ZIP locations in the Kiki plugin Release repository or the
 * retained official Kimi CDN paths. Local directories and arbitrary GitHub
 * repositories remain unofficial, regardless of manifest identity.
 */
export function isOfficialPluginSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    return isOfficialPluginUrl(new URL(trimmed));
  } catch {
    return false;
  }
}

/**
 * Checks the installed ZIP's original official location, not its manifest id.
 * Local paths and generic GitHub sources do not qualify.
 */
export function isOfficialPluginInstall(plugin: PluginSummary): boolean {
  return (
    plugin.source === 'zip-url' &&
    plugin.originalSource !== undefined &&
    isOfficialPluginSource(plugin.originalSource)
  );
}

function isOfficialPluginUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  return (
    (url.hostname === 'github.com' &&
      /^\/X-T-E-R\/kiki-plugins\/releases\/download\/[^/]+\/[^/]+\.zip$/.test(url.pathname)) ||
    (CODE_CDN_HOSTS.has(url.hostname) &&
      url.pathname.startsWith('/kimi-code/plugins/official/')) ||
    (CONTENT_CDN_HOSTS.has(url.hostname) &&
      (url.pathname.startsWith('/kimi-computer-use/') ||
        url.pathname.startsWith('/kimi-computer-use-windows/')))
  );
}

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.port.length > 0) return `${url.hostname}:${url.port}`;
    return url.hostname;
  } catch {
    return undefined;
  }
}

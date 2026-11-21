/**
 * Shared bridge for browser stress scenarios: GUI assets are always served by the
 * real `kap-server` `webAssets` route (started with `webAssetsDir`), never by a
 * hand-rolled Node static server, so transfer size, Content-Encoding and HTTP
 * headers measured here are the ones a phone actually receives.
 */

const MiB = 1024 * 1024;

/** Raw (uncompressed) cold-boot JavaScript budget accepted only when assets ship without br/gzip/zstd. */
export const WEB_ASSETS_RAW_JS_BUDGET_BYTES = 2 * MiB;

/**
 * Verifies that `kap-server` at `endpoint` serves the real built GUI shell through
 * its native `webAssets` route (HTTP 200 HTML containing the React root).
 */
export async function assertKapServerWebAssets(endpoint, { timeoutMs = 10_000 } = {}) {
  const baseUrl = String(endpoint ?? '').replace(/\/+$/u, '');
  if (!baseUrl) {
    throw new Error('assertKapServerWebAssets requires a non-empty kap-server endpoint');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'GET',
      headers: { accept: 'text/html', 'accept-encoding': 'br, gzip' },
      signal: ac.signal,
    });
    const contentType = res.headers.get('content-type') ?? '';
    const html = await res.text();
    if (!res.ok || !contentType.includes('text/html') || !html.includes('id="root"')) {
      throw new Error(
        `kap-server at ${baseUrl}/ is not serving real webAssets (status=${res.status}, content-type=${contentType}); start it with webAssetsDir`,
      );
    }
    return {
      webUrl: baseUrl,
      servedByKapServer: true,
      indexStatus: res.status,
      indexContentEncoding: res.headers.get('content-encoding') ?? 'identity',
      indexCacheControl: res.headers.get('cache-control') ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records every `/assets/*` response the page receives from `kap-server`, with real
 * status, Content-Type, Content-Encoding and encoded transfer bytes.
 */
export function createWebAssetsAuditRecorder(page, endpoint) {
  const origin = new URL(endpoint).origin;
  const assets = [];
  const pending = new Set();

  const onResponse = (res) => {
    let u;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.origin !== origin || !u.pathname.startsWith('/assets/')) return;
    const headers = res.headers();
    const contentEncoding = String(headers['content-encoding'] || 'identity').toLowerCase();
    const isJs = /\.m?js$/u.test(u.pathname);
    const isCss = u.pathname.endsWith('.css');
    const entry = {
      path: u.pathname,
      status: res.status(),
      kind: isJs ? 'js' : isCss ? 'css' : 'other',
      contentType: headers['content-type'] ?? null,
      contentEncoding,
      compressed: contentEncoding === 'br' || contentEncoding === 'gzip' || contentEncoding === 'zstd',
      transferBytes: Number(headers['content-length'] ?? 0) || 0,
    };
    assets.push(entry);
    const sizes = res
      .request()
      .sizes()
      .then((s) => {
        if (s && Number.isFinite(s.responseBodySize) && s.responseBodySize > 0) entry.transferBytes = s.responseBodySize;
      })
      .catch(() => undefined)
      .finally(() => pending.delete(sizes));
    pending.add(sizes);
  };

  page.on('response', onResponse);

  return {
    detach() {
      page.off('response', onResponse);
    },
    async settle() {
      await Promise.all(pending);
    },
    snapshot() {
      return summarizeWebAssets(origin, assets);
    },
  };
}

export function summarizeWebAssets(origin, assets) {
  const jsAssets = assets.filter((a) => a.kind === 'js');
  const jsTotalTransferBytes = jsAssets.reduce((sum, a) => sum + a.transferBytes, 0);
  const jsCompressedCount = jsAssets.filter((a) => a.compressed).length;
  const failedAssets = assets.filter((a) => a.status >= 400).map((a) => ({ path: a.path, status: a.status }));
  const jsWrongContentType = jsAssets
    .filter((a) => !/javascript/u.test(String(a.contentType ?? '')))
    .map((a) => ({ path: a.path, contentType: a.contentType }));
  const largestJsAsset = jsAssets.toSorted((a, b) => b.transferBytes - a.transferBytes)[0] ?? null;
  return {
    servedByKapServer: true,
    origin,
    assetCount: assets.length,
    jsAssetsCount: jsAssets.length,
    jsTotalTransferBytes,
    jsTotalTransferKiB: Number((jsTotalTransferBytes / 1024).toFixed(1)),
    jsCompressedCount,
    jsUncompressedCount: jsAssets.length - jsCompressedCount,
    allJsCompressed: jsAssets.length > 0 && jsCompressedCount === jsAssets.length,
    contentEncodings: [...new Set(assets.map((a) => a.contentEncoding))].toSorted((a, b) => a.localeCompare(b)),
    failedAssets,
    jsWrongContentType,
    largestJsAsset: largestJsAsset ? { path: largestJsAsset.path, transferBytes: largestJsAsset.transferBytes } : null,
  };
}

/**
 * Gate: assets must come from kap-server with valid headers and either be fully
 * br/gzip/zstd compressed or stay under the raw JS byte budget.
 */
export function evaluateWebAssetsBudget(audit, { rawJsBudgetBytes = WEB_ASSETS_RAW_JS_BUDGET_BYTES } = {}) {
  const failures = [];
  if (!audit || audit.servedByKapServer !== true) failures.push('assets were not served by kap-server webAssets');
  if (!audit || audit.jsAssetsCount === 0) failures.push('no /assets/*.js responses observed from kap-server');
  if (audit?.failedAssets?.length > 0) failures.push(`${audit.failedAssets.length} asset responses returned HTTP >= 400`);
  if (audit?.jsWrongContentType?.length > 0) failures.push(`${audit.jsWrongContentType.length} JS assets lack a javascript content-type`);
  if (audit && audit.jsAssetsCount > 0 && !audit.allJsCompressed && audit.jsTotalTransferBytes > rawJsBudgetBytes) {
    failures.push(
      `${audit.jsUncompressedCount}/${audit.jsAssetsCount} JS assets uncompressed (encodings=${audit.contentEncodings.join(',')}) and ${audit.jsTotalTransferBytes} raw bytes exceed the ${rawJsBudgetBytes}-byte budget`,
    );
  }
  return { passed: failures.length === 0, failures, rawJsBudgetBytes };
}

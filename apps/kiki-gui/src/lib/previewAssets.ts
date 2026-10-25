/**
 * Where a rendered document-preview asset lives, as an API path on THIS
 * connection.
 *
 * The server hands back a URL like `/api/sessions/<id>/document-preview/assets/
 * <assetId>`. That string is not directly usable in the browser: the asset
 * route is behind the same bearer gate as the rest of `/api`, so an `<img src>`
 * or a bare `getDocument({ url })` would be refused, and a remote scope would
 * resolve the path against the wrong origin. Reducing it to a path here lets
 * the client read it over the connection the file actually lives on.
 *
 * Anything that is not one of this API's own asset paths is refused rather
 * than passed along: a preview must never turn into a request to some other
 * host, and a host path is not a URL the GUI may fetch from.
 */

const ASSET_PATH = /^\/api\/sessions\/[^/]+\/document-preview\/assets\/[A-Za-z0-9_-]{16,128}$/;

export function documentPreviewAssetPath(assetUrl: string): string {
  // Tolerate an absolute URL on this API's own shape: strip scheme and host
  // when the path is still a valid asset path, refuse anything else.
  const raw = assetUrl.trim();
  if (ASSET_PATH.test(raw)) return raw;

  const withOrigin = (() => {
    try {
      return new URL(raw, 'http://example.test');
    } catch {
      return undefined;
    }
  })();
  if (withOrigin === undefined) throw new Error('Preview asset URL is not a readable document-preview asset path.');
  const path = withOrigin.pathname;
  if (withOrigin.origin !== 'http://example.test' || !ASSET_PATH.test(path)) {
    throw new Error('Preview asset URL does not belong to this connection.');
  }
  return path;
}

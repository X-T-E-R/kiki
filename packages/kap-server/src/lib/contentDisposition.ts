export function buildContentDisposition(name: string, mediaType?: string): string {
  const mime = (mediaType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const active = mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml' || /\.(?:svg|svgz|html?|xhtml)$/i.test(name);
  const disposition = !active && /^(image|video|audio)\//.test(mime) ? 'inline' : 'attachment';
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }
  return disposition;
}

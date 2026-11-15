export function buildContentDisposition(name: string, mediaType?: string): string {
  const mime = (mediaType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const active = mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml' || /\.(?:svg|svgz|html?|xhtml)$/i.test(name);
  const disposition = !active && /^(image|video|audio)\//.test(mime) ? 'inline' : 'attachment';
  const fallback = name.replaceAll(/[^\u0020-\u007E]|["\\/]/gu, '_') || 'download';
  const base = `${disposition}; filename="${fallback}"`;
  if (!/[^\u0000-\u007F]/u.test(name)) return base;
  const encoded = encodeURIComponent(name).replaceAll(/['()*]/gu, (character) =>
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return `${base}; filename*=UTF-8''${encoded}`;
}

import { ACCEPTED_IMAGE_MIMES } from '@kiki/session-core/composer';

const MEDIA_MIMES_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mpg: 'video/mpeg', mpeg: 'video/mpeg', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ogv: 'video/ogg', wmv: 'video/x-ms-wmv',
  webm: 'video/webm', m4v: 'video/x-m4v', flv: 'video/x-flv', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
};
const VIDEO_MIMES = new Set(Object.values(MEDIA_MIMES_BY_EXTENSION).filter((mime) => mime.startsWith('video/')));

/** Clipboard media follows the image whitelist and the existing uploaded-video formats. */
export function pastedMediaType(file: { readonly name: string; readonly type: string }): string | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = file.type || MEDIA_MIMES_BY_EXTENSION[extension] || '';
  return ACCEPTED_IMAGE_MIMES.includes(mime) || VIDEO_MIMES.has(mime) ? mime : null;
}

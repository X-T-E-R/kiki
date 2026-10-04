/**
 * Modality marks — the three drawn glyphs a media source, a job and an
 * artifact all share, so "this is a video" reads the same everywhere.
 *
 * Deliberately not icons from the shared family: that family is built for
 * actions (a thing you press) and for tool verbs, and a photo / a play triangle
 * / a speaker are neither. These are the same 16px grid, same stroke weight
 * and same currentColor contract as `CapabilityGlyph`, so they sit in a row
 * with those without looking borrowed.
 */

import type { MediaKind } from '../../lib/mediaSources';

/** The modality a surface is talking about. `audio` is the TTS modality. */
export type MediaModality = MediaKind | 'audio' | 'file';

const GLYPHS: Record<MediaModality, React.ReactNode> = {
  // A framed picture with a horizon: the corner marks read as a crop region,
  // which is what an image request is usually about.
  image: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.6" />
      <path d="M2.5 10.2 5.8 7.1l2.4 2.2 2.1-1.9 3.2 2.8" />
      <circle cx="10.6" cy="6.1" r="0.9" />
    </>
  ),
  // A play triangle inside a frame: the frame is the clip, the triangle is the
  // affordance. A bare triangle alone would read as "run this".
  video: (
    <>
      <rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.6" />
      <path d="M7.1 6.3 10.7 8l-3.6 1.7z" />
    </>
  ),
  // A speaker cone and two arcs: the universal mark for "this is heard", and
  // the one modality the product has no icon for today.
  tts: (
    <>
      <path d="M4.2 6.4h1.9L8.6 4.2v7.6L6.1 9.6H4.2z" />
      <path d="M10.4 6.2a2.6 2.6 0 0 1 0 3.6" />
      <path d="M12.1 4.6a5 5 0 0 1 0 6.8" />
    </>
  ),
  // The same speaker, for an artifact that is already an audio file.
  audio: (
    <>
      <path d="M4.2 6.4h1.9L8.6 4.2v7.6L6.1 9.6H4.2z" />
      <path d="M10.4 6.2a2.6 2.6 0 0 1 0 3.6" />
    </>
  ),
  // A page with a folded corner: a sidecar — a subtitle, a JSON receipt — that
  // is an answer to read rather than a picture or a sound.
  file: (
    <>
      <path d="M4.2 2.8h4.6l3 3v7.4H4.2z" />
      <path d="M8.8 2.8v3h3" />
    </>
  ),
};

export function MediaKindGlyph({ kind, className = 'h-4 w-4' }: { readonly kind: MediaModality; readonly className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" className={`${className} shrink-0 fill-none stroke-current stroke-[1.25] stroke-linecap-round stroke-linejoin-round`}>
      {GLYPHS[kind]}
    </svg>
  );
}

const MODALITY_LABEL: Record<MediaModality, 'cap.media.kind.image' | 'cap.media.kind.video' | 'cap.media.kind.tts' | 'cap.media.kind.file'> = {
  image: 'cap.media.kind.image',
  video: 'cap.media.kind.video',
  tts: 'cap.media.kind.tts',
  audio: 'cap.media.kind.tts',
  file: 'cap.media.kind.file',
};

export function modalityLabelKey(modality: MediaModality) {
  return MODALITY_LABEL[modality];
}

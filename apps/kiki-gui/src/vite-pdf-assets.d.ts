/**
 * Ambient types for the virtual modules the GUI's own Vite plugins resolve.
 *
 * `vite/pdfAssets.ts` emits `virtual:kiki-pdf-assets`, which exports the URLs
 * of the installed pdf.js worker, CMaps and standard fonts as they are served
 * from this app. They are real emitted files in a build and real requests in
 * dev — never a CDN, because a preview that fetched its fonts from another
 * host would leak the shape of the document and stop working offline.
 */
declare module 'virtual:kiki-pdf-assets' {
  /** The pdf.js worker module, loaded by the library at runtime. */
  export const workerSrc: string;
  /** Directory the CMaps are served from; required for CJK encodings. */
  export const cMapUrl: string;
  /** Directory the standard fonts are served from. */
  export const standardFontDataUrl: string;
}

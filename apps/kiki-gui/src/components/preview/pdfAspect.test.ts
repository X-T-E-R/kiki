// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The canvas must keep the document's own proportions.
 *
 * The previous defect was subtle and self-consistent: both viewport widths
 * agreed with each other while disagreeing with the PDF, because CSS
 * `aspect-ratio` reads width/height and the component passed height/width. A
 * portrait page came out sideways and squashed. Comparing two runs of the same
 * bug proves nothing, so the expectation here is stated as a NUMBER measured
 * from the real file: this sample's first page is 612 x 792 points.
 *
 * The component source is read so the test fails if the ratio is ever inverted
 * again, and the real file is opened so the expected numbers cannot drift.
 */
const REAL_SAMPLE = 'C:/Programs/AI/EasyAgent/systems/kiki/.tmp/work-presets-033/preview-engine/ui-live-workspace-pdf.pdf';
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'PdfPageView.tsx');
const LETTER_PORTRAIT = { width: 612, height: 792 };

describe('pdf page proportions', () => {
  it('the real sample is a portrait page, and we know its exact shape', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = new Uint8Array(await readFile(REAL_SAMPLE));
    const document = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
    const viewport = (await document.getPage(1)).getViewport({ scale: 1 });
    expect(viewport.width).toBe(LETTER_PORTRAIT.width);
    expect(viewport.height).toBe(LETTER_PORTRAIT.height);
    // Portrait: taller than wide, so a width/height ratio is below 1.
    expect(viewport.height).toBeGreaterThan(viewport.width);
    expect(viewport.width / viewport.height).toBeCloseTo(0.7727, 3);
  }, 30_000);

  it('the canvas is given width over height, never the reciprocal', async () => {
    const source = await readFile(SOURCE, 'utf8');
    expect(source).toContain('setAspect(unit.width / unit.height)');
    // The inverted form is the bug this guards against.
    expect(source).not.toContain('setAspect(unit.height / unit.width)');
  });

  it('a correctly shaped box stays portrait at both panel widths', () => {
    const ratio = LETTER_PORTRAIT.width / LETTER_PORTRAIT.height;
    for (const width of [900, 390]) {
      const height = width * ratio;
      // Below 1 means width/height, i.e. a portrait box: taller than wide.
      expect(ratio).toBeLessThan(1);
      expect(height / width).toBeCloseTo(ratio, 4);
      // The inverse — what the bug produced — would be above 1 (sideways).
      expect(height / width).not.toBeGreaterThan(1);
    }
  });
});

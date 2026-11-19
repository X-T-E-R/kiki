import jsQR from 'jsqr';

export interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
}

let sharedVideoCanvas: HTMLCanvasElement | null = null;
let sharedVideoCtx: CanvasRenderingContext2D | null = null;

function getVideoScratchCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (typeof document === 'undefined') return null;
  if (!sharedVideoCanvas) {
    sharedVideoCanvas = document.createElement('canvas');
    sharedVideoCtx = sharedVideoCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!sharedVideoCtx) return null;
  if (sharedVideoCanvas.width !== width || sharedVideoCanvas.height !== height) {
    sharedVideoCanvas.width = width;
    sharedVideoCanvas.height = height;
  }
  return { canvas: sharedVideoCanvas, ctx: sharedVideoCtx };
}

export function decodeQrFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  inversionAttempts: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' = 'attemptBoth',
): string | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const decoded = jsQR(data, width, height, { inversionAttempts });
  const text = decoded?.data?.trim() ?? '';
  return text !== '' ? text : null;
}

export async function decodeQrFromVideo(
  video: HTMLVideoElement,
  detector?: NativeBarcodeDetector | null,
): Promise<string | null> {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }
  if (detector) {
    try {
      const codes = await detector.detect(video);
      if (Array.isArray(codes)) {
        for (const code of codes) {
          const val = code?.rawValue?.trim() ?? '';
          if (val !== '') return val;
        }
      }
    } catch {
    }
  }
  const maxDim = 720;
  const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const scratch = getVideoScratchCanvas(width, height);
  if (!scratch) return null;
  scratch.ctx.drawImage(video, 0, 0, width, height);
  const imageData = scratch.ctx.getImageData(0, 0, width, height);
  return decodeQrFromImageData(imageData.data, width, height, 'dontInvert');
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolveImg, rejectImg) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolveImg(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rejectImg(new Error('Failed to decode image'));
    };
    img.src = url;
  });
}

export async function decodeQrFromImageFile(
  file: Blob,
  detector?: NativeBarcodeDetector | null,
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  let source: CanvasImageSource;
  let naturalWidth: number;
  let naturalHeight: number;
  let bitmap: ImageBitmap | null = null;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
      source = bitmap;
      naturalWidth = bitmap.width;
      naturalHeight = bitmap.height;
    } else {
      const img = await loadImageElement(file);
      source = img;
      naturalWidth = img.naturalWidth || img.width;
      naturalHeight = img.naturalHeight || img.height;
    }

    if (detector) {
      try {
        const codes = await detector.detect(source);
        if (Array.isArray(codes)) {
          for (const code of codes) {
            const val = code?.rawValue?.trim() ?? '';
            if (val !== '') return val;
          }
        }
      } catch {
      }
    }

    if (naturalWidth <= 0 || naturalHeight <= 0) return null;
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return decodeQrFromImageData(imageData.data, width, height, 'attemptBoth');
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

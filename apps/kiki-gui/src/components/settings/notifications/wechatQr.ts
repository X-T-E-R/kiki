import { renderSVG } from 'uqr';

export function wechatQrImage(value: string): string | undefined {
  if (value.length === 0) return undefined;
  try {
    const svg = renderSVG(value, {
      ecc: 'M',
      border: 2,
      pixelSize: 1,
      whiteColor: '#fbfaf6',
      blackColor: '#1b1a17',
    }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return undefined;
  }
}

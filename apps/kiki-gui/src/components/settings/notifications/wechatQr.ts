import QRCode from '../../../vendor/qrcode-svg.js';

export function wechatQrImage(value: string): string | undefined {
  try {
    const symbol = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const size = symbol.modules.size;
    const cells: string[] = [];
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (symbol.modules.data[row * size + col]) cells.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
      }
    }
    const margin = 2;
    const span = size + margin * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin} ${span} ${span}" shape-rendering="crispEdges"><rect x="${-margin}" y="${-margin}" width="${span}" height="${span}" fill="#fbfaf6"/><g fill="#1b1a17">${cells.join('')}</g></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return undefined;
  }
}

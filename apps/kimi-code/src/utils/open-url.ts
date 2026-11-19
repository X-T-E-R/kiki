import open from 'open';

export function openUrl(url: string): void {
  void open(url).catch(() => {});
}

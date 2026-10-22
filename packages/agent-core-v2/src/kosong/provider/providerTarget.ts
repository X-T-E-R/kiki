export function matchesProviderTarget(value: string, targets: readonly string[]): boolean {
  const url = new URL(value);
  return targets.some((value) => {
    const target = new URL(value);
    return url.origin === target.origin && (url.pathname === target.pathname ||
      url.pathname.startsWith(`${target.pathname.replace(/\/$/, '')}/`));
  });
}

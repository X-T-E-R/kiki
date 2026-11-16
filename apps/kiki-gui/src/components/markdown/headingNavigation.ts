export function slugifyMarkdownHeading(text: string): string {
  return text.toLowerCase()
    .replaceAll(/[\p{P}\p{S}]/gu, (character) => character === '-' || character === '_' ? character : '')
    .replaceAll(' ', '-');
}

/** GitHub-style heading fragments, scoped to one rendered document. */
export function indexMarkdownHeadings(root: HTMLElement): ReadonlyMap<string, HTMLElement> {
  const headings = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const base = slugifyMarkdownHeading(element.textContent ?? '');
    let slug = base;
    let suffix = 0;
    while (headings.has(slug)) slug = `${base}-${++suffix}`;
    element.dataset['markdownHeading'] = slug;
    headings.set(slug, element);
  }
  return headings;
}

export function findMarkdownHeading(root: HTMLElement, fragment: string): HTMLElement | undefined {
  const headings = indexMarkdownHeadings(root);
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {}
  return headings.get(decoded) ?? headings.get(slugifyMarkdownHeading(decoded));
}

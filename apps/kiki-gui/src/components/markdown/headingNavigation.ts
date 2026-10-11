/** GitHub-style heading fragments, scoped to one rendered document. */
export function indexMarkdownHeadings(root: HTMLElement): ReadonlyMap<string, HTMLElement> {
  const headings = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const base = (element.textContent ?? '').toLowerCase()
      .replaceAll(/[\p{P}\p{S}]/gu, (character) => character === '-' || character === '_' ? character : '')
      .replaceAll(' ', '-');
    let slug = base;
    let suffix = 0;
    while (headings.has(slug)) slug = `${base}-${++suffix}`;
    element.dataset['markdownHeading'] = slug;
    headings.set(slug, element);
  }
  return headings;
}

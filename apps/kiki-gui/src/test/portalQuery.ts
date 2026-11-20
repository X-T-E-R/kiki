/**
 * Test-only helper that lets existing jsdom tests querying `container.querySelector`
 * reach Base UI popovers/selects portaled to `document.body` (`[data-base-ui-portal]`).
 */
export function withPortalQueries<T extends HTMLElement>(container: T): T {
  return new Proxy(container, {
    get(target, prop, receiver) {
      if (prop === 'querySelector') {
        return (selector: string) => {
          const direct = target.querySelector(selector);
          if (direct !== null) return direct;
          for (const portal of document.body.querySelectorAll('[data-base-ui-portal]')) {
            const hit = portal.querySelector(selector);
            if (hit !== null) return hit;
          }
          return null;
        };
      }
      if (prop === 'querySelectorAll') {
        return (selector: string) => {
          const seen = new Set<Element>();
          const combined: Element[] = [];
          for (const el of target.querySelectorAll(selector)) {
            if (!seen.has(el)) { seen.add(el); combined.push(el); }
          }
          for (const portal of document.body.querySelectorAll('[data-base-ui-portal]')) {
            for (const el of portal.querySelectorAll(selector)) {
              if (!seen.has(el)) { seen.add(el); combined.push(el); }
            }
          }
          return combined as unknown as NodeListOf<Element>;
        };
      }
      if (prop === 'textContent') {
        const portals = [...document.body.querySelectorAll('[data-base-ui-portal]')]
          .map((node) => node.textContent ?? '')
          .join('');
        return `${target.textContent ?? ''}${portals}`;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

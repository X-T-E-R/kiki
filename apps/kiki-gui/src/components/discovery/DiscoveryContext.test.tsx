// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { discoveryDestinationHref } from './DiscoveryContext';

describe('discoveryDestinationHref', () => {
  it('routes the usage-filter anchor to the history panel that mounts it', () => {
    expect(discoveryDestinationHref({ href: '/usage', anchor: 'usage-filter' })).toBe('/usage?panel=history');
  });

  it('appends the panel after an existing query', () => {
    expect(discoveryDestinationHref({ href: '/usage?metric=tokens', anchor: 'usage-filter' })).toBe('/usage?metric=tokens&panel=history');
  });

  it('leaves an explicit panel parameter alone', () => {
    expect(discoveryDestinationHref({ href: '/usage?panel=quota', anchor: 'usage-filter' })).toBe('/usage?panel=quota');
  });

  it('leaves every other destination untouched', () => {
    expect(discoveryDestinationHref({ href: '/memory', anchor: 'memory-scope' })).toBe('/memory');
    expect(discoveryDestinationHref({ href: '/new', anchor: 'workspace-picker' })).toBe('/new');
    expect(discoveryDestinationHref({ href: '/usage' })).toBe('/usage');
  });
});

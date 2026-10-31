export default {
  name: 'headless-smoke',
  scenario: 'hero-shell',
  vite: true,
  routes: [
    {
      name: 'hero-shell',
      path: '/new',
      waitFor: ['[data-phase="hero"]', 'textarea:not([disabled])'],
      setup: [
        { waitFor: '[data-phase="hero"]' },
        { scroll: 'top' },
      ],
    },
  ],
  matrix: {
    themes: ['light', 'dark'],
    locales: ['en', 'zh'],
    viewports: ['wide', 'narrow'],
  },
};

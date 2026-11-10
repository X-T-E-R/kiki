export default {
  name: 'headless-smoke',
  scenario: 'hero-shell',
  vite: true,
  routes: [
    {
      name: 'hero-shell',
      path: '/new',
      waitFor: ['[data-phase="hero"]', '[data-composer-input][contenteditable="true"]:not([aria-disabled="true"])'],
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

/**
 * Boot preload — `<link rel="modulepreload">` in the built index.html for the
 * modules `src/main.tsx` loads with `import()`, and for everything those
 * modules import statically.
 *
 * main.tsx imports the app graph dynamically on purpose: its modules read
 * space-namespaced localStorage while they are evaluated, so none of them may
 * run before the active space is known. Vite only preloads an entry's static
 * imports, which leaves most of the first-paint JavaScript undiscovered until
 * the entry chunk has downloaded, run, and finished its boot awaits — on a
 * phone loading the served GUI, two large downloads in a row. A modulepreload
 * fetches and compiles a module without evaluating it, so these links let the
 * downloads overlap while evaluation order stays exactly as main.tsx sets it.
 *
 * Every dynamic import in main.tsx is covered. One that should not be fetched
 * on every start (a heavy, rarely taken branch) must not live in main.tsx.
 */

import type { HtmlTagDescriptor, Plugin } from 'vite';

export function bootPreloadPlugin(entry = 'src/main.tsx'): Plugin {
  let base = '/';
  let bootModules: readonly string[] = [];
  return {
    name: 'kiki-boot-preload',
    apply: 'build',
    configResolved(config) { base = config.base; },
    buildEnd() {
      const id = [...this.getModuleIds()].find((moduleId) => moduleId.endsWith(`/${entry}`));
      bootModules = id === undefined ? [] : (this.getModuleInfo(id)?.dynamicallyImportedIds ?? []);
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk }) {
        if (bundle === undefined || chunk === undefined) return undefined;
        const chunks = new Map<string, readonly string[]>();
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') chunks.set(output.fileName, output.imports);
        }
        // Vite already preloads the entry's own static graph.
        const covered = new Set<string>();
        const cover = (fileName: string) => {
          if (covered.has(fileName)) return;
          covered.add(fileName);
          for (const next of chunks.get(fileName) ?? []) cover(next);
        };
        cover(chunk.fileName);
        const links: HtmlTagDescriptor[] = [];
        const visit = (fileName: string) => {
          if (covered.has(fileName)) return;
          covered.add(fileName);
          links.push({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `${base}${fileName}` }, injectTo: 'head' });
          for (const next of chunks.get(fileName) ?? []) visit(next);
        };
        // A module removed by tree-shaking (a dev-only branch) has no chunk and gets no link.
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk' && bootModules.some((id) => output.moduleIds.includes(id))) visit(output.fileName);
        }
        return links;
      },
    },
  };
}

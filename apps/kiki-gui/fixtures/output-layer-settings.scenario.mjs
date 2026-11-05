import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import base from './plugin-settings-pages.scenario.mjs';
import { panelDocument } from '../../../packages/agent-core-v2/src/app/plugin/panelDocument.ts';

const pluginRoot = process.env.KIKI_PLUGINS_ROOT;
if (!pluginRoot) throw new Error('Set KIKI_PLUGINS_ROOT to the plugin repository containing plugins/official/kiki-output-layer.');
const root = resolve(pluginRoot);
const outputRoot = resolve(root, 'plugins/official/kiki-output-layer');
const readManifest = async (path) => JSON.parse(await readFile(resolve(root, path, 'kimi.plugin.json'), 'utf8'));
const output = await readManifest('plugins/official/kiki-output-layer');
const media = await readManifest('plugins/official/kiki-media');
const extract = await readManifest('plugins/official/kiki-extract');
const mail = await readManifest('plugins/kiki-mail');
const { configuration } = await import(pathToFileURL(resolve(outputRoot, 'lib/configuration.mjs')).href);
const outputHtml = await panelDocument(outputRoot, { file: resolve(outputRoot, 'settings.html'), assetFiles: {} });
const mediaRoot = resolve(root, 'plugins/official/kiki-media');
const mediaHtml = await panelDocument(mediaRoot, { file: resolve(mediaRoot, 'settings.html'), assetFiles: {} });
const { handlePanelRequest } = await import(pathToFileURL(resolve(mediaRoot, 'entry.mjs')).href);
const mediaCatalog = await handlePanelRequest('catalog');
const legacy = {
  id: 'legacy', label: 'Night reading', instruction: 'Keep the user prompt exactly as saved.',
  connectionId: 'studio', customModelId: 'legacy-reader-v1', contextWindow: 65536, maxOutputTokens: 2048,
};
const manifestEntry = (manifest) => ({
  ...base.plugins[0], id: manifest.name, displayName: manifest.interface?.displayName ?? (manifest === output ? 'Output Layer' : manifest.name),
  version: manifest.version, enabled: true, state: 'ok', skillCount: manifest.skills ? 1 : 0, mcpServerCount: 0, enabledMcpServerCount: 0,
  mcpServers: [], diagnostics: [],
});
const manifests = [output, media, extract, mail];
// The fixture serves the Host's effective schema: adapter connection declarations
// become formats and group prerequisites join the required list, not raw fields.
const mediaSchema = structuredClone(media['x-kiki'].settings);
const required = new Set(mediaSchema.schema.required ?? []);
for (const source of media['x-kiki'].mediaSources) {
  const connection = media['x-kiki'].mediaProviders.find((item) => source.providerIds.includes(item.id))?.connectionSetting;
  if (connection) mediaSchema.schema.properties[connection].format = 'kiki-connection';
  for (const field of source.required) {
    const key = source.settingsPrefix + field;
    required.add(key);
    if (connection && (field === 'apiKey' || field === 'baseUrl')) mediaSchema.schema.properties[key].requiredUnless = connection;
  }
}
mediaSchema.schema.required = [...required];
const mediaValues = { openai__enabled: true, openai__connectionId: 'openai-main', google__removed: true, agnes__enabled: false, agnes__connectionId: 'studio' };
const mediaSettings = { schema: mediaSchema, values: mediaValues, secretsConfigured: ['openai__apiKey', 'agnes__apiKey'] };
export default {
  ...base,
  plugins: manifests.map(manifestEntry).concat({ ...manifestEntry(media), id: 'media-schema-fixture', displayName: 'Media schema fixture' }),
  models: [
    { id: 'studio/reader-small', display_name: 'Reader Small', remote_id: 'reader-small', provider_id: 'studio', max_context_size: 65536 },
    { id: 'studio/reader-large', display_name: 'Reader Large', remote_id: 'reader-large', provider_id: 'studio', max_context_size: 131072 },
  ],
  pluginInfos: Object.fromEntries(manifests.map((manifest) => [manifest.name, { ...manifestEntry(manifest), manifest }]).concat([
    ['media-schema-fixture', { ...manifestEntry(media), id: 'media-schema-fixture', manifest: { ...media, 'x-kiki': { ...media['x-kiki'], panels: [] } } }],
  ])),
  pluginSettings: {
    'kiki-output-layer': { schema: output['x-kiki'].settings, values: { presets: JSON.stringify([legacy]), groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 }, secretsConfigured: [] },
    'kiki-media': mediaSettings,
    'media-schema-fixture': mediaSettings,
    'kiki-extract': { schema: extract['x-kiki'].settings, values: { pythonPath: 'python' }, secretsConfigured: ['mineruToken'] },
    'kiki-mail': { schema: mail['x-kiki'].settings, values: { watchEnabled: false }, secretsConfigured: ['credentials'] },
  },
  pluginPanels: {
    'kiki-output-layer': [{ id: 'settings', label: 'Output Layer', slot: 'settings', html: outputHtml }],
    'kiki-media': [{ id: 'settings', label: 'Media settings', slot: 'settings', html: mediaHtml }],
    // Mail's real manifest drives the route. Its running mail service is not part of this fixture.
    'kiki-mail': [{ id: 'mail', label: 'Mail', slot: 'workspace', html: '<!doctype html><html><body><h1>Mail fixture</h1></body></html>' }],
  },
  pluginCallResponses: {
    'kiki-output-layer': { configuration },
    'kiki-media': { catalog: mediaCatalog },
  },
};

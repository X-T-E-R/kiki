/**
 * Declaration for `plugin-settings-pages.scenario.mjs`.
 *
 * The GUI program resolves a `.mjs` import to the sibling `.d.mts`. This
 * covers the panel document the settings test reads. The fixture file stays
 * the JavaScript module the fixture server loads.
 */
export interface PluginSettingsPanelFixture {
  readonly html: string;
}

export interface PluginSettingsPagesScenario {
  readonly pluginPanels: Readonly<Record<string, readonly PluginSettingsPanelFixture[]>>;
}

declare const pluginSettingsPagesScenario: PluginSettingsPagesScenario;
export default pluginSettingsPagesScenario;

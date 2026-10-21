/**
 * installed-plugin settings pages — the Settings → Plugins leaf and the
 * per-plugin page it opens.
 *
 * Self-contained on purpose: it declares its own installed plugins and their
 * settings rather than spreading another scenario, so this page's states are
 * exactly the ones being checked. Four plugins cover the paths that matter:
 *
 *   `kiki-notes`   — a plugin with settings: string, number and boolean fields
 *                    plus a secret that is already stored, so one page shows a
 *                    plain value reading back and a secret reported as set.
 *   `kimi-webbridge` — the browser bridge, installed and off.
 *   `sketchbook`   — a local-folder plugin that is on.
 *   `broken-tools` — reporting errors.
 *
 * No market is configured, so the leaf's link out to the catalog is exercised
 * against a server that has no catalog of its own — the common case, not a
 * broken one.
 */

const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iI2VlZSIvPjwvc3ZnPg==';

const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  enabled: true,
  globalEnabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  ...overrides,
});

export default {
  plugins: [
    summary('kiki-notes', {
      displayName: 'Kiki Notes',
      version: '2.4.0',
      icon: ICON,
      enabled: true,
      skillCount: 1,
      originalSource: 'C:/kiki/plugins/kiki-notes',
    }),
    summary('sketchbook', {
      displayName: 'Sketchbook',
      version: '0.9.1',
      enabled: true,
      originalSource: 'C:/kiki/plugins/sketchbook',
    }),
    summary('kimi-webbridge', {
      displayName: 'Kimi Browser Extension',
      version: '1.11.4',
      enabled: false,
      globalEnabled: false,
      originalSource: 'https://example.test/kimi-webbridge/releases/1.11.4.zip',
      source: 'zip-url',
    }),
    summary('broken-tools', {
      displayName: 'Broken Tools',
      enabled: true,
      state: 'error',
      hasErrors: true,
      originalSource: 'C:/kiki/plugins/broken-tools',
    }),
    summary('kiki-media', {
      displayName: 'Kiki Media',
      version: '0.2.0',
      enabled: true,
      originalSource: 'C:/kiki/plugins/kiki-media',
    }),
    summary('kiki-output-layer', {
      displayName: 'Output layer',
      version: '0.3.2',
      enabled: true,
      originalSource: 'C:/kiki/plugins/kiki-output-layer',
    }),
  ],
  providers: [
    { id: 'openai-main', type: 'api', name: 'OpenAI main', has_api_key: true, status: 'connected' },
    { id: 'studio', type: 'api', name: 'Studio', has_api_key: false, status: 'unconfigured' },
  ],
  // Only `kiki-notes` declares a form. The others must still get a real page:
  // their state and their management, with no invented empty form.
  pluginSettings: {
    'kiki-notes': {
      schema: {
        schema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              title: 'Workspace folder',
              description: 'Where notes are stored on the server.',
            },
            maxResults: {
              type: 'number',
              title: 'Results per search',
              description: 'How many notes one search returns.',
              default: 8,
            },
            syncOnOpen: {
              type: 'boolean',
              title: 'Sync when Kiki opens',
              description: 'Pull remote changes before the first search.',
            },
            vaultToken: {
              type: 'string',
              title: 'Vault token',
              description: 'Written only. It is never sent back to this page.',
              secret: true,
            },
          },
        },
      },
      values: { workspace: 'notes-archive', syncOnOpen: true },
      secretsConfigured: ['vaultToken'],
    },
    'kiki-media': {
      schema: {
        schema: {
          type: 'object',
          properties: {
            mediaOutputDir: {
              type: 'string',
              title: 'Output folder',
              description: 'Where generated files are written.',
              localizations: { zh: { title: '输出目录', description: '生成的文件写到这里。' } },
            },
            defaultImageProvider: {
              type: 'string',
              title: 'Default image provider',
              enum: ['openai', 'google'],
              localizations: { zh: { title: '默认图像来源' } },
            },
            openai__enabled: {
              type: 'boolean',
              title: 'Enabled',
              group: 'openai',
              groupTitle: 'OpenAI',
              default: true,
              localizations: { zh: { title: '启用', groupTitle: 'OpenAI' } },
            },
            openai__connectionId: {
              type: 'string',
              title: 'Connection',
              group: 'openai',
              groupTitle: 'OpenAI',
              localizations: { zh: { title: '关联连接', groupTitle: 'OpenAI' } },
            },
            openai__apiKey: {
              type: 'string',
              title: 'API key',
              secret: true,
              group: 'openai',
              groupTitle: 'OpenAI',
              localizations: { zh: { title: 'API 密钥', groupTitle: 'OpenAI' } },
            },
            openai__note: {
              type: 'string',
              title: 'Note',
              group: 'openai',
              groupTitle: 'OpenAI',
              advanced: true,
              multiline: true,
              localizations: { zh: { title: '备注', groupTitle: 'OpenAI' } },
            },
            google__enabled: {
              type: 'boolean',
              title: 'Enabled',
              group: 'google',
              groupTitle: 'Google',
              default: false,
              localizations: { zh: { title: '启用', groupTitle: 'Google' } },
            },
            google__baseUrl: {
              type: 'string',
              title: 'API base URL',
              group: 'google',
              groupTitle: 'Google',
              localizations: { zh: { title: 'API 地址', groupTitle: 'Google' } },
            },
          },
        },
      },
      values: { mediaOutputDir: 'D:/kiki/media', defaultImageProvider: 'openai', openai__enabled: true, google__enabled: false },
      secretsConfigured: ['openai__apiKey'],
    },
    'kiki-output-layer': {
      schema: { schema: { type: 'object', properties: { presetName: { type: 'string', title: 'Preset name' } } } },
      values: { presetName: 'Reading' },
      secretsConfigured: [],
    },
  },
  pluginInfos: {
    'kiki-output-layer': {
      id: 'kiki-output-layer',
      displayName: 'Output layer',
      version: '0.3.2',
      enabled: true,
      state: 'ok',
      manifest: {
        kiki: {
          panels: [{ id: 'settings', slot: 'settings', label: 'Output layer settings' }],
        },
      },
    },
  },
  pluginPanels: {
    'kiki-output-layer': [{
      id: 'settings',
      label: 'Output layer settings',
      slot: 'settings',
      html: `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;background:var(--color-paper,#f6f1e7);color:var(--color-ink,#241c14);font:14px/1.45 ui-sans-serif,sans-serif}
        main{padding:16px 18px 20px;max-width:42rem}
        h2{margin:0 0 12px;font-size:16px;font-weight:600}
        label{display:block;margin:10px 0 4px;font-size:13px}
        input{box-sizing:border-box;width:100%;max-width:28rem;height:32px;padding:0 8px;border:1px solid var(--color-hairline,#d9d0c3);border-radius:6px;background:var(--color-panel,#fffdf8);color:inherit}
        button{margin-top:14px;height:32px;padding:0 12px;border:0;border-radius:6px;background:var(--color-accent,#8a5a2b);color:var(--color-on-accent,#fff);cursor:pointer}
        #status{min-height:1.2em;margin:8px 0 0;font-size:12px;color:var(--color-ink-soft,#6d6256)}
        #status[data-tone="error"]{color:var(--color-danger,#9b2c2c)}
      </style></head><body><main>
        <h2>输出层设置</h2>
        <label for="name">名称</label>
        <input id="name" value="">
        <button id="save" type="button">保存</button>
        <p id="status">正在加载…</p>
      </main><script>
        const CHANNEL='kiki.panel.v1';
        let seq=0;
        const pending=new Map();
        function ask(method, extra){
          const id=++seq;
          parent.postMessage(Object.assign({channel:CHANNEL,kind:'request',id,method}, extra||{}), '*');
          return new Promise((resolve,reject)=>{ pending.set(id,{resolve,reject}); });
        }
        window.addEventListener('message', (event)=>{
          const data=event.data;
          if(!data || data.channel!==CHANNEL || data.kind!=='response') return;
          const waiter=pending.get(data.id);
          if(!waiter) return;
          pending.delete(data.id);
          if(data.ok) waiter.resolve(data.result); else waiter.reject(new Error(data.error||'failed'));
        });
        const name=document.getElementById('name');
        const status=document.getElementById('status');
        name.addEventListener('input', ()=>{ ask('plugin.dirty',{dirty:true}); });
        const savedLabel=()=>document.documentElement.lang.startsWith('zh')?'已保存':'Saved';
        document.getElementById('save').addEventListener('click', async ()=>{
          status.dataset.tone='';
          status.textContent=savedLabel();
          try {
            await ask('plugin.settings.patch',{values:{presetName:name.value}});
            status.textContent=savedLabel();
          } catch (error) {
            status.dataset.tone='error';
            status.textContent=error.message||'failed';
          }
        });
        ask('plugin.settings.get').then((view)=>{
          name.value=(view&&view.values&&view.values.presetName)||'';
          status.textContent='';
        }).catch((error)=>{ status.dataset.tone='error'; status.textContent=error.message||'failed'; });
      </script></body></html>`,
    }],
  },
  // No catalog: the leaf links to the market, and the market is the bundled one.
  pluginMarketplace: [],
};
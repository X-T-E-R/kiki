import { describe, expect, it } from 'vitest';

import { modelsDevProviderModels } from '#/app/kosongConfig/modelsDev';

describe('models.dev per-model protocol', () => {
  it('keeps a model protocol that differs from the provider and skips vendor wires', () => {
    const models = modelsDevProviderModels({
      id: 'gateway',
      type: 'openai',
      api: 'https://gateway.example.test/openai/v1',
      models: {
        'vendor/gemini-model': {
          id: 'vendor/gemini-model',
          limit: { context: 8192 },
          provider: { npm: '@google/genai', api: 'https://gateway.example.test/gemini' },
        },
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 8192 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://gateway.example.test/anthropic/v1' },
        },
        'vendor/vertex-model': {
          id: 'vendor/vertex-model',
          limit: { context: 8192 },
          provider: { npm: '@ai-sdk/google-vertex', api: 'https://us-central1-aiplatform.googleapis.com/v1' },
        },
      },
    });

    expect(models.find((model) => model.id === 'vendor/gemini-model')).toMatchObject({
      protocol: 'google-genai',
      baseUrl: 'https://gateway.example.test/gemini',
    });
    expect(models.find((model) => model.id === 'vendor/claude-model')).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example.test/anthropic',
    });
    expect(models.find((model) => model.id === 'vendor/vertex-model')).toBeUndefined();
  });
});

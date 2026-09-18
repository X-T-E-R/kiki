import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelCatalogErrors = {
  codes: {
    PROVIDER_NOT_FOUND: 'provider.not_found',
    PROVIDER_ALREADY_EXISTS: 'provider.already_exists',
    MODEL_NOT_FOUND: 'model.not_found',
    MODEL_ALREADY_EXISTS: 'model.already_exists',
    REVISION_CONFLICT: 'model_catalog.revision_conflict',
  },
  info: {
    'provider.not_found': {
      title: 'Provider not found',
      retryable: false,
      public: true,
      action: 'Check the provider id or configure the provider first.',
    },
    'provider.already_exists': {
      title: 'Provider already exists',
      retryable: false,
      public: true,
      action: 'Choose another provider id or edit the existing connection.',
    },
    'model.not_found': {
      title: 'Model not found',
      retryable: false,
      public: true,
      action: 'Check the model alias or configure the model first.',
    },
    'model.already_exists': {
      title: 'Model already exists',
      retryable: false,
      public: true,
      action: 'Choose another local model id; an existing model is never overwritten.',
    },
    'model_catalog.revision_conflict': {
      title: 'Configuration changed',
      retryable: true,
      public: true,
      action: 'Re-read the entity and reapply the edit against the current revision.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelCatalogErrors);

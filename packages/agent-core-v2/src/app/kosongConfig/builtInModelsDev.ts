declare const __KIKI_BUILT_IN_CATALOG__: string | undefined;

export const BUILT_IN_MODELS_DEV_JSON: string | undefined =
  typeof __KIKI_BUILT_IN_CATALOG__ === 'string'
    ? __KIKI_BUILT_IN_CATALOG__
    : undefined;

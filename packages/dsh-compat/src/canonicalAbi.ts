import {
  cordis as cordisNamespace,
  cosmokit as cosmokitNamespace,
  getCordisCanonicalAbi,
  schemastery as schemasteryNamespace,
  scope as scopeNamespace,
} from '@kiki/cordis-runtime';

const {
  AnonymousEntries,
  bindScopeParent,
  carrierKeyOf,
  createScope,
  isScopeCarrier,
  NamedEntries,
  ScopedLayers,
  scopeChainOf,
  scopeOf,
  scopeParentOf,
  scopeTarget,
} = scopeNamespace;

/** Canonical single-instance Cordis/Cosmokit/Schemastery/Scope ABI shared directly with @kiki/cordis-runtime. */
export const canonicalCordisAbi = getCordisCanonicalAbi();

export {
  AnonymousEntries,
  bindScopeParent,
  carrierKeyOf,
  cordisNamespace,
  cosmokitNamespace,
  createScope,
  isScopeCarrier,
  NamedEntries,
  schemasteryNamespace,
  scopeChainOf,
  scopeNamespace,
  ScopedLayers,
  scopeOf,
  scopeParentOf,
  scopeTarget,
};

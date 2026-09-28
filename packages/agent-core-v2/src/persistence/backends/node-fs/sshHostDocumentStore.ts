import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';

import { TomlAtomicDocumentStore } from './atomicDocumentStore';

registerScopedService(LifecycleScope.App, ISshHostDocumentStore, TomlAtomicDocumentStore, ScopeActivation.OnDemand, 'ssh');

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAtomicTomlDocumentStore } from './atomicDocumentStore';

export const ISshHostDocumentStore: ServiceIdentifier<IAtomicTomlDocumentStore> =
  createDecorator<IAtomicTomlDocumentStore>('sshHostDocumentStore');

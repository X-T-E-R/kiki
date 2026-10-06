/**
 * The external-client wire types, taken from `klient` rather than restated.
 *
 * `klient.rest.externalClients` is the single owner of the 0.3.3 contract. The
 * GUI re-exports it through one module so a field that moves there moves here
 * too, and so a type the facade does not carry cannot quietly appear in a
 * component. `ExternalConnectionMode` is a local alias because the panel pairs
 * it with the composer's own permission enum.
 */

export type {
  ExternalClientAuthorization,
  ExternalClientConnection,
  ExternalClientConnectionInput,
  ExternalClientListener,
  ExternalClientListenerInput,
  ExternalClientMaterial,
  ExternalClientMaterialsPreview,
  ExternalClientSession,
  ExternalClientTextInput,
  ExternalClientTextReceipt,
  ExternalClientsFacade,
} from '@kiki/klient';

import type { ExternalClientConnection, ExternalClientConnectionInput, ExternalClientTextInput } from '@kiki/klient';

/** The native permission mode a connection's calls run under. */
export type ExternalConnectionMode = ExternalClientConnection['mode'];

/** What a create or update may change; omitted fields keep their value. */
export type ExternalConnectionPatch = Partial<ExternalClientConnectionInput> & { enabled?: boolean };

/** Which memory scopes a connection may read and write. */
export type ExternalMemoryScope = NonNullable<ExternalClientConnectionInput['memoryScopes']>[number];

/** How much of the past a connection may read. */
export type ExternalHistoryScope = NonNullable<ExternalClientConnectionInput['historyScope']>;

/** What kind of text a client is saving; the kind is the client's claim, not Kiki's. */
export type ExternalTextKind = NonNullable<ExternalClientTextInput['kind']>;

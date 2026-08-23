import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDesktopVersions } from './desktop-version.mjs';

test('accepts one canonical desktop version and matching release tag', () => {
  const versions = {
    package: '0.1.0-beta.1',
    tauri: '0.1.0-beta.1',
    cargo: '0.1.0-beta.1',
    system: '0.1.0-beta.1',
  };
  assert.equal(assertDesktopVersions(versions, 'kiki-v0.1.0-beta.1'), '0.1.0-beta.1');
  assert.throws(
    () => assertDesktopVersions({ ...versions, cargo: '0.1.0' }),
    /version drift/,
  );
});

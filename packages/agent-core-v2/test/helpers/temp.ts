import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'pathe';

const DARWIN_SOCKET_PATH_LIMIT = 103;
const RUNTIME_SOCKET_SUFFIX = join('store', 'runtime-host', 'runtime.sock');

export function testTempRoot(): string {
  const root = fs.realpathSync(os.tmpdir());
  if (
    process.platform === 'darwin' &&
    Buffer.byteLength(join(root, 'k-XXXXXX', RUNTIME_SOCKET_SUFFIX), 'utf8') > DARWIN_SOCKET_PATH_LIMIT
  ) {
    return fs.realpathSync('/tmp');
  }
  return root;
}

export function createTestTempDir(): Promise<string> {
  return fs.promises.mkdtemp(join(testTempRoot(), 'k-'));
}

export function createTestTempDirSync(): string {
  return fs.mkdtempSync(join(testTempRoot(), 'k-'));
}

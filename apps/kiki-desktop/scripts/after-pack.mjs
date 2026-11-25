import { join } from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { verifyElectronBinaryFuses } from './verify-fuses.mjs';

function resolvePackagedBinaryPath(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const executableName = packager.executableName || 'kiki-desktop';
  const productFilename = packager.appInfo.productFilename;
  if (electronPlatformName === 'win32') {
    return join(appOutDir, `${executableName}.exe`);
  }
  if (electronPlatformName === 'darwin') {
    return join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  return join(appOutDir, executableName);
}

export default async function afterPack(context) {
  const binaryPath = resolvePackagedBinaryPath(context);
  await flipFuses(binaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  const verification = await verifyElectronBinaryFuses(binaryPath, { packaged: true });
  if (!verification.ok) {
    throw new Error(
      `Electron fuse verification failed after packaging ${binaryPath}:\n${verification.failures.join('\n')}`,
    );
  }
}

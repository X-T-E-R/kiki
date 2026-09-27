export interface VerifiedArtifact {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly metadataUrl: string;
  readonly maxBytes: number;
}

const WEBBRIDGE_METADATA = 'https://cdn.kimi.com/webbridge/v2.0.22/version.json';
const WEBBRIDGE_VERSION = 'v2.0.22';
const WEBBRIDGE_BASE = 'https://cdn.kimi.com/webbridge/v2.0.22/releases/';
const WEBBRIDGE_MAX_BYTES = 64 * 1024 * 1024;

const WEBBRIDGE_DIGESTS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'f36dfeba6d5925318a38a4cbe688fa83c4b2bb899c8b05be4fac0848980901f0',
  'darwin-amd64': 'ad9aba7d4a2a5c45f60d72fcb00855220610c884f8b832ecb8869b0c1898d4ba',
  'linux-arm64': '6f0837446df91ae1be1293ae3c8ce0a85e777472557d491dd6216c18de45527f',
  'linux-amd64': '0d1b2bf5be0c4854110f60b755fbe50cdc3d06c6a086ab3b4d4c7505f41fdcf6',
  'windows-amd64': '8e9dfc5bb83ca696acd3e873e8cba45933d3d5b379fc1aed88641370d0eeb338',
};

export function webbridgeArtifact(platform: NodeJS.Platform, arch: string): VerifiedArtifact | undefined {
  const key = `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}`;
  const sha256 = WEBBRIDGE_DIGESTS[key];
  if (sha256 === undefined) return undefined;
  const filename = `kimi-webbridge-${key}${platform === 'win32' ? '.exe' : ''}`;
  return {
    version: WEBBRIDGE_VERSION,
    url: `${WEBBRIDGE_BASE}${filename}`,
    sha256,
    metadataUrl: WEBBRIDGE_METADATA,
    maxBytes: WEBBRIDGE_MAX_BYTES,
  };
}

const CU_MAC_VERSION = '0.6.1';
const CU_MAC_BASE = `https://cdn.kimi.com/kimi-computer-use/${CU_MAC_VERSION}/`;
const CU_MAC_METADATA = `${CU_MAC_BASE}version.json`;

export function cuMacArtifact(arch: string): VerifiedArtifact | undefined {
  if (arch !== 'arm64' && arch !== 'x64') return undefined;
  return {
    version: CU_MAC_VERSION,
    url: `${CU_MAC_BASE}${arch === 'arm64' ? 'KimiCU.app.zip' : 'KimiCU-x86_64.app.zip'}`,
    sha256: arch === 'arm64'
      ? '0c52646d981a7acb2256447acc23bad51abe24fc0803493ce4aa5c4c7edfde71'
      : '110f04a47ede16c51ec3aa7c3a1f558f5086a2511a489c2bdf525eaddd00afbd',
    metadataUrl: CU_MAC_METADATA,
    maxBytes: 500 * 1024 * 1024,
  };
}

export const CU_WINDOWS_RUNTIME_METADATA = 'https://cdn.kimi.com/kimi-computer-use-windows/0.3.6/version.json';
export const CU_WINDOWS_RUNTIME_VERSION = '0.3.6';
export const CU_WINDOWS_RUNTIME_SHA256 = 'e9376b4ad07324fdc8881f3f44720e954d80c386816f79dc60a1e4dd74824bee';
export const CU_WINDOWS_EXECUTABLE_SHA256 = '708f746f9747dadef89709613d14cdaefc8aad36dd3bcf7cb6d1f70d80a10512';

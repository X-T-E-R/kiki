import type { VerifiedArtifact } from '../verifiedArtifacts';

export const COMPUTER_VERSION = '0.32.0';
export const COMPUTER_COMMIT = '58aba84b5b83d77e7e2b0f006547699eb594e50d';
const BASE = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/';

export interface ComputerArtifact extends VerifiedArtifact {
  readonly directory: string;
  readonly executable: string;
  readonly files: Readonly<Record<string, string>>;
}

const LICENSE = 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9';
const NOTICES = '3268421fe758ec53bc11a2644aac1451a397027c508c199e86745636bb5499db';
const WINDOWS_COMMON = {
  LICENSE: 'd0a32419a44fa38d5023d1431dfcbedd1457eb5e7b2e6c7c87ca064facb41b41',
  'THIRD_PARTY_NOTICES.md': '37f03af97a33e06e168a950dabef79b4674d1c007302a13e0148871d095c962a',
  'cua_driver_abi.h': 'c17169f41da321baa5e7e953323c3ad660b00790176ba381e93189fba3506587',
};
const UNIX_COMMON = {
  LICENSE,
  'THIRD_PARTY_NOTICES.md': NOTICES,
  'cua_driver_abi.h': 'e952620e41ac81b2d900886c7b0a24ebc6268a4edb8df88cc9971ae34af4ba0d',
};
const WAYLAND_FILES = {
  'wayland-helper/install.sh': 'e13fc5700d281fed547fbb529a31bc1a0df250e6f9811c9cdddc99d465e219a0',
  'wayland-helper/winrects@cua/metadata.json': '3f6624c882bde9d611848201e2f245c813fbc322a57a003d52847afc8e6f4c50',
  'wayland-helper/winrects@cua/extension.js': '27aac56799574ecd201e810d32772d3695d8b6ace5ab4a68d026648009004eed',
  'wayland-helper/README.md': 'd43b236d07a46b91c3dacaddcf19284d37b51361fcf46b9cebd3cc72f0a369e1',
};
const ARTIFACTS: Readonly<Record<string, { readonly sha256: string; readonly files: Readonly<Record<string, string>> }>> = {
  'windows-x86_64': {
    sha256: '6d70b45c8c901db773010dd720c8bb9d58c59bb301e9891c58ca1d3860e75652',
    files: { ...WINDOWS_COMMON,
      'cua_driver_node_runtime.node': '48d75442de05ae674acf81342278585ef14724a7992b9a09d900e4e03d2c5a80',
      'cua_driver_sdk.dll': '8d4ffbc583341d0bd5ea621e4577a3fe3aa286c3fcf04590c6f598d30b6a1919',
      'cua-cursor-theme.exe': 'b472e6162ad6522398f2a49521435fe4a942e3031dd29ff30161f0be2782acbc',
      'cua-driver-uia.exe': 'a01d7a2b4cacce135e3b0b45e230f7850ac1eafbe22c5b9f62b230cdb8bacf81',
      'cua-driver.exe': 'd2477595e8b5ae850d119b48c8bbe5c16a1f229f3e99e706bd84622c2d7d98ae',
    },
  },
  'windows-arm64': {
    sha256: '51f5723a6734afb7125c92fe05835bb815f7c37b75e2332dd48ae184ddb0a9f8',
    files: { ...WINDOWS_COMMON,
      'cua_driver_node_runtime.node': '86bb03da87daefe3e3a8d23912f974e514dea0e9475106f3381c0742ee26b1cd',
      'cua_driver_sdk.dll': '8fae395cf152807465c7b4c00c7e3dffbf765c9790fac091427dd43a1be2aaa4',
      'cua-cursor-theme.exe': '30d23864fcf62b8ec3e9b7f764b7748d6129b4f0acfc5db6261b23205dcd97a8',
      'cua-driver-uia.exe': 'e7b025c299b0a27087690e937f1229686e65e363a96a60b20ec492e8ad545485',
      'cua-driver.exe': 'f4b192c8f13edcc594cdb6b0f535fb62dd77dfcbe99bbb3e7ee1b1f7426a3744',
    },
  },
  'linux-x86_64': {
    sha256: '998e63452c38b76a682da2d07f4bb24f0c1663d76c861a5dc0c345a7ead1f889',
    files: { ...UNIX_COMMON, ...WAYLAND_FILES,
      'cua-cursor-theme': '642048a9c3a31b85f98d9968b54a1a5669f692109211dfa9002499a53c529156',
      'cua_driver_node_runtime.node': '4870483907e4e5ce6c98cf75c4879ab3154490a170b19a0ad69561df30a5f067',
      'libcua_driver_sdk.so': 'eca8cf7669d0de73e56fb8e7481d219f08fe27a70fab17963431fc951736c49d',
      'cua-driver': '2c56cc4c260f07c957a0f8ee905c2477ec8f2a9b548024999f3698c9864c20e0',
    },
  },
  'linux-arm64': {
    sha256: '262439491f2fa9b718ba37bee3838fff4ad53c77a32f4a73aaf243bad3cd794c',
    files: { ...UNIX_COMMON, ...WAYLAND_FILES,
      'cua_driver_node_runtime.node': '6dc65f6f861f6cb25c0daba06932bcc0a9498b9118b8e1b4f22875deea564f74',
      'cua-driver': '03167f9045602ae79b679dfc9fa749ef20bfaafcd783106a10f96aac55068057',
      'cua-cursor-theme': '150b2bbfb573417c9fe097c4b60731d7de874e26d6dcff9f4909f7c6121212e2',
      'libcua_driver_sdk.so': '8c59187f19ec3ba4e57339be95ca72378301fe3ec920368afd44a8a685200ea1',
    },
  },
  'darwin-universal': {
    sha256: '8ea16a3f533c056c0aaeb86e6dbf7f792c9cf43532f24595427d7ccde6921a3d',
    files: { ...UNIX_COMMON,
      'cua-driver': 'd5762050791535fa85a9eae2f067167287cf4a4883b2051fe2dba33204c6e8b5',
      'cua_driver_node_runtime.node': 'ef1e413fb7e83270c7767b7cf1ddc9d8e74ba6c377611e15d0342bdfba4e1d83',
      'cua-cursor-theme': 'fe5accb934070e674e9b20416be9e47b0715ab0852e0c8f58d4cf6ea483c43d4',
      'libcua_driver_sdk.dylib': 'f2ffc3abf40a5fd6e8b1edd68220ecbc68867eb6aa9e12afd3b6ad74e943a25d',
      'CuaDriver.app/Contents/CodeResources': '4ba76a5dd2d89285b2dddb87a9448cdcb2d3c1a39f0800891345a74bf3340a26',
      'CuaDriver.app/Contents/embedded.provisionprofile': '6d0ef96f919a526c5245089d62319f53c81345a0a92cc3ef2a5911ca2e871b91',
      'CuaDriver.app/Contents/Info.plist': '6d42d890182c0b48cc3a89b9686cd684503eeffc1b64aee63cce78ab0fd735e3',
      'CuaDriver.app/Contents/Resources/AppIcon.icns': 'a23ece4fd5e883b511890fd917f3480141aa20a73ed1a862a98c50de984ab793',
      'CuaDriver.app/Contents/MacOS/cua-driver': '656ff1c1aea1ee063d7735bcd8eb4491346971d4fb3199c6d2260b40aae83c66',
      'CuaDriver.app/Contents/MacOS/cua-cursor-theme': 'fe5accb934070e674e9b20416be9e47b0715ab0852e0c8f58d4cf6ea483c43d4',
      'CuaDriver.app/Contents/_CodeSignature/CodeResources': 'cc62f59211b54ff320f65f3bad713e16613e5869ee44028b6b003fe197d84bca',
    },
  },
};

export function computerArtifact(platform: NodeJS.Platform, arch: string): ComputerArtifact | undefined {
  if (arch !== 'x64' && arch !== 'arm64') return undefined;
  const label = platform === 'darwin' ? 'darwin-universal' :
    `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'x86_64' : arch}`;
  const artifact = ARTIFACTS[label];
  if (artifact === undefined) return undefined;
  const directory = `cua-driver-rs-${COMPUTER_VERSION}-${label}`;
  return { version: COMPUTER_VERSION, url: `${BASE}${directory}${platform === 'win32' ? '.zip' : '.tar.gz'}`,
    sha256: artifact.sha256, metadataUrl: `${BASE}SHA256SUMS`, maxBytes: 100 * 1024 * 1024,
    directory, executable: platform === 'win32' ? 'cua-driver.exe' : 'cua-driver', files: artifact.files };
}

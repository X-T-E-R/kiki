export const NODE_RUNTIME_RANGE = '>=24.22.1 <25 || >=26.12.1';

const NODE_24_FLOOR = { major: 24, minor: 22, patch: 1 };
const NODE_26_FLOOR = { major: 26, minor: 12, patch: 1 };

export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function nodeRuntimeAccepted(version) {
  const parsed = parseNodeVersion(version);
  if (parsed === null) return false;
  if (parsed.major > 26) return true;
  if (parsed.major === 24) return compareVersion(parsed, NODE_24_FLOOR) >= 0;
  if (parsed.major === 26) return compareVersion(parsed, NODE_26_FLOOR) >= 0;
  return false;
}

export function nodeRuntimeRejection(version) {
  if (nodeRuntimeAccepted(version)) return null;
  return `Kiki requires Node.js ${NODE_RUNTIME_RANGE}, current ${version}.`;
}

export {
  applyBundledWindowsToolchainPath,
  applyBundledWindowsToolchainPathFromNode,
  bundledWindowsToolchainCandidates,
  detectEnvironment,
  detectEnvironmentFromNode,
  execFileText,
  locateBundledWindowsToolchainRoot,
  probeHostEnvironment,
  probeHostEnvironmentFromNode,
  type Environment,
  type EnvironmentDeps,
  type HostEnvironmentInfo,
  type HostEnvironmentProbeDeps,
  type OsKind,
  type PathClass,
  type ShellName,
  type WindowsToolchainLookupOptions,
} from './environment';
export {
  KaosShellNotFoundError,
  KaosShellNotFoundError as ProbeShellNotFoundError,
} from './errors';
export {
  applyLoginShellPath,
  applyLoginShellPathFromNode,
  mergeLoginShellPath,
  probeLoginShellPath,
  type LoginShellPathDeps,
} from './login-shell-path';
export {
  createShellPathBridge,
  getShellPathBridge,
  translateShellDrivePath,
  type ShellPathBridge,
  type ShellPathBridgeDeps,
  type ShellPathBridgeEnv,
} from './shell-path-bridge';
export {
  BufferedReadable,
  decodeTextWithErrors,
  globPatternToRegex,
  type TextDecodeErrors,
} from './internal';
export { mergeChildEnv } from './child-env';
